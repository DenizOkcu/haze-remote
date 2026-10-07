import { randomInt, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONFIRM_MS, PIN_MS, confirmationCode, opaque, registration } from '../shared/crypto.js';

export interface DeviceReview {
  id: string;
  peer: string;
  browser: string;
  platform: string;
  expiresAt: number;
}
export interface Candidate extends DeviceReview {
  code: string;
  verified: boolean;
  onApprove: () => void;
  onReject: () => void;
}
// Deliberately local-only: no HTTP/WebSocket route can call confirm/approve,
// reopen pairing, or revoke the approved device.
export class PairingGate {
  readonly serverId = randomBytes(16).toString('hex');
  readonly setup = opaque.server.createSetup();
  private pin = '';
  private record = '';
  private expiresAt = 0;
  private generation = 0;
  private attempts = 0;
  private enabled = true;
  private candidate?: Candidate;
  constructor(private readonly now = () => Date.now(), private readonly changed?: () => void) { this.rotate(); }
  localPin() { return this.enabled && this.attempts < 5 ? { pin: this.pin, expiresAt: this.expiresAt } : null; }
  private rotate() {
    this.pin = randomInt(100_000_000).toString().padStart(8, '0');
    this.record = registration(this.setup, 'pair', this.pin);
    this.expiresAt = this.now() + PIN_MS;
    this.generation++;
    this.changed?.();
  }
  tick() {
    if (this.candidate && this.now() >= this.candidate.expiresAt) this.reject();
    if (this.enabled && this.attempts < 5 && this.now() >= this.expiresAt) this.rotate();
  }
  begin(request: string) {
    this.tick();
    if (!this.enabled || this.attempts >= 5) throw new Error('Pairing closed. Reopen it locally on the computer.');
    if (this.candidate) throw new Error('A pairing request is awaiting local approval.');
    // Charge every handshake start, including those abandoned by a wrong-PIN
    // client. Rotation never resets the guessing/DoS budget.
    this.attempts++;
    const result = opaque.server.startLogin({ serverSetup: this.setup, registrationRecord: this.record, userIdentifier: 'pair', startLoginRequest: request });
    return { ...result, generation: this.generation, expiresAt: this.expiresAt };
  }
  finish(challenge: { generation: number; expiresAt: number; serverLoginState: string }, request: string) {
    if (!this.enabled || this.candidate || this.now() >= challenge.expiresAt || challenge.generation !== this.generation) throw new Error('Pairing challenge expired or unavailable');
    return opaque.server.finishLogin({ serverLoginState: challenge.serverLoginState, finishLoginRequest: request });
  }
  pending(sessionKey: string, review: Omit<DeviceReview, 'id' | 'expiresAt'>, onApprove: () => void, onReject: () => void) {
    if (this.candidate || !this.enabled) throw new Error('Pairing unavailable');
    this.candidate = { ...review, id: randomBytes(16).toString('hex'), expiresAt: this.now() + CONFIRM_MS, code: confirmationCode(sessionKey), verified: false, onApprove, onReject };
    return this.candidate;
  }
  confirm(code: string): DeviceReview {
    this.tick();
    const candidate = this.candidate;
    if (!candidate || !/^\d{8}$/.test(code) || !timingSafeEqual(Buffer.from(code), Buffer.from(candidate.code))) throw new Error('Incorrect or expired code B');
    candidate.verified = true;
    // Never expose code B in the local review or through the network.
    const { id, peer, browser, platform, expiresAt } = candidate;
    return { id, peer, browser, platform, expiresAt };
  }
  approve(id: string) {
    this.tick();
    const candidate = this.candidate;
    if (!candidate || !candidate.verified || candidate.id !== id) throw new Error('Confirm code B locally before approval; request may have expired');
    this.candidate = undefined;
    this.enabled = false;
    this.pin = this.record = '';
    candidate.onApprove();
    this.changed?.();
  }
  reject() { const candidate = this.candidate; this.candidate = undefined; candidate?.onReject(); }
  cancel(id: string) { if (this.candidate?.id === id) this.reject(); }
  close() { this.enabled = false; this.pin = this.record = ''; this.reject(); this.changed?.(); }
  reopen() {
    this.reject(); this.attempts = 0; this.enabled = true; this.rotate();
  }
  status() { this.tick(); return { open: this.enabled && this.attempts < 5, pending: !!this.candidate }; }
}

export function describeDevice(peer: string, userAgent = '') {
  // Only whitelisted labels/digit versions reach the terminal; never echo
  // requester-controlled escape sequences, newlines, names or forwarded IPs.
  const match = userAgent.slice(0, 512).match(/(Edg|Firefox|Chrome|Version)\/([\d.]{1,20})/);
  const browser = match ? `${({ Edg: 'Edge', Firefox: 'Firefox', Chrome: 'Chrome', Version: 'Safari' } as Record<string, string>)[match[1]]} ${match[2]}` : 'Unknown';
  const platform = /iPad|iPhone/.test(userAgent) ? 'iPad/iPhone' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Macintosh/.test(userAgent) ? 'macOS or iPad desktop mode' : /Linux/.test(userAgent) ? 'Linux' : 'Unknown';
  return { peer: peer.replace(/^::ffff:/, ''), browser, platform };
}
