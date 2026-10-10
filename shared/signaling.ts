// Public contract with the hosted signaling service. No application payloads.
export const SIGNALING_ORIGIN = 'https://api.haze.build';
export const UI_ORIGIN = 'https://haze.build';
export const SIGNAL_LIMIT = 64 * 1024;
export type Signal = { type: 'offer' | 'answer'; sdp: string } | { type: 'candidate'; candidate: string; sdpMid: string; sdpMLineIndex: number };
export function isSignal(value: unknown): value is Signal {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if ((v.type === 'offer' || v.type === 'answer') && Object.keys(v).sort().join(',') === 'sdp,type') return typeof v.sdp === 'string' && v.sdp.length <= SIGNAL_LIMIT && v.sdp.startsWith('v=0');
  return v.type === 'candidate' && Object.keys(v).sort().join(',') === 'candidate,sdpMLineIndex,sdpMid,type' && typeof v.candidate === 'string' && v.candidate.length <= 2048 && typeof v.sdpMid === 'string' && v.sdpMid.length <= 64 && Number.isInteger(v.sdpMLineIndex) && Number(v.sdpMLineIndex) >= 0 && Number(v.sdpMLineIndex) < 8;
}
export class SignalingClient {
  private constructor(readonly roomId: string, private readonly token: string, public expiresAt: number, private readonly origin: string) {}
  static async create(roomId: string, origin = SIGNALING_ORIGIN) {
    const result = await this.request(origin, '/v1/remote/rooms', 'POST', undefined, { roomId });
    return new SignalingClient(roomId, result.token, result.expiresAt, origin);
  }
  static async join(roomId: string, origin = SIGNALING_ORIGIN) {
    const result = await this.request(origin, `/v1/remote/rooms/${roomId}/join`, 'POST');
    return new SignalingClient(roomId, result.token, result.expiresAt, origin);
  }
  private static async request(origin: string, path: string, method: string, token?: string, body?: unknown) {
    const response = await fetch(`${origin}${path}`, { method, redirect: 'error', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(response.status === 404 || response.status === 410 ? 'Pairing expired or cancelled. Generate a new link on the PC.' : response.status === 409 ? 'Another browser is connecting. Close it or cancel pairing on the PC.' : 'Hosted signaling service unavailable. Check internet access and retry.');
    const wire = await response.text();
    if (wire.length > 512 * 1024) throw new Error('Signaling response too large');
    return JSON.parse(wire);
  }
  async send(signal: Signal) { if (!isSignal(signal)) throw new Error('Invalid signaling message'); const result = await SignalingClient.request(this.origin, `/v1/remote/rooms/${this.roomId}/messages`, 'POST', this.token, signal); this.updateExpiry(result); }
  async receive(): Promise<Signal[]> {
    const result = await SignalingClient.request(this.origin, `/v1/remote/rooms/${this.roomId}/messages`, 'GET', this.token);
    if (!Array.isArray(result.messages) || result.messages.length > 8 || !result.messages.every(isSignal)) throw new Error('Invalid signaling response');
    this.updateExpiry(result);
    return result.messages;
  }
  private updateExpiry(result: { expiresAt?: unknown }) {
    if (typeof result.expiresAt !== 'number' || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= 0) throw new Error('Invalid signaling expiry');
    this.expiresAt = result.expiresAt;
  }
  async leave() { await SignalingClient.request(this.origin, `/v1/remote/rooms/${this.roomId}/leave`, 'POST', this.token); }
  async close() { await SignalingClient.request(this.origin, `/v1/remote/rooms/${this.roomId}`, 'DELETE', this.token); }
}
