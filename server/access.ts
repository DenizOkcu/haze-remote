import { randomBytes } from 'node:crypto';
import { type IncomingMessage } from 'node:http';
import { cryptoReady, EncryptedChannel, opaque, registration, canonicalChannelBinding, type ChannelBinding } from '../shared/crypto.js';
import { PairingGate, describeDevice, type DeviceReview } from './pairing.js';

export interface RemoteSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}
export interface AttachMetadata {
  peer?: string;
  userAgent?: string;
  /** Trusted transport adapter only: actual local/remote DTLS descriptions. */
  channelBinding?: ChannelBinding;
  autoApprove?: boolean;
  requireBinding?: boolean;
}
export interface AccessOptions<S extends RemoteSocket = RemoteSocket> {
  requireBinding?: boolean;
  onPin?: (pin: { pin: string; expiresAt: number } | null) => void;
  onPending?: (review: DeviceReview) => void;
  onAuthenticated: (ws: S) => void;
  onMessage: (message: any, ws: S) => void;
}
type Connection<S extends RemoteSocket> = {
  ws: S; phase: 'hello' | 'challenge' | 'pending' | 'review' | 'resuming' | 'active';
  deadline: number; kind?: 'pair' | 'resume';
  challenge?: ReturnType<PairingGate['begin']>;
  channel?: EncryptedChannel; pendingId?: string;
  enrollment?: { id: string; record: string };
};

export class AccessController<S extends RemoteSocket = RemoteSocket> {
  readonly gate: PairingGate;
  private device?: { id: string; record: string };
  private connections = new Map<S, Connection<S>>();
  private controller?: S;
  private pinShown = '';
  constructor(private readonly options: AccessOptions<S>) {
    this.gate = new PairingGate();
    this.publishPin();
  }
  static async ready() { await cryptoReady; }
  info() { return { serverId: this.gate.serverId, paired: !!this.device, pairing: this.gate.status() }; }
  active() { return this.controller; }
  isActive(ws: S) { return ws === this.controller && this.connections.get(ws)?.phase === 'active'; }
  private publishPin() {
    const value = this.gate.localPin();
    const signature = JSON.stringify(value);
    if (signature !== this.pinShown) { this.pinShown = signature; this.options.onPin?.(value); }
  }
  tick() {
    this.gate.tick(); this.publishPin();
    for (const connection of this.connections.values()) if (Date.now() >= connection.deadline) this.fail(connection, 'Connection or approval expired', connection.phase === 'active' ? 4002 : 4001);
  }
  confirm(code: string) {
    this.tick();
    const connection = [...this.connections.values()].find(c => c.pendingId && c.phase === 'review' && c.enrollment);
    if (!connection) throw new Error('Device enrollment is not ready or the request expired');
    const review = this.gate.confirm(code);
    if (connection.pendingId !== review.id) throw new Error('Pending request mismatch');
    connection.deadline = review.expiresAt;
    this.send(connection.ws, { type: 'review', expiresAt: review.expiresAt, remainingMs: review.expiresAt - Date.now() });
    return review;
  }
  approve(id: string) { this.gate.approve(id); this.publishPin(); }
  reject() { this.gate.reject(); }
  openPairing() {
    if (this.device) throw new Error('Revoke the current device locally before pairing another.');
    this.gate.reopen(); this.publishPin();
  }
  revoke() {
    this.device = undefined; this.gate.close();
    for (const c of this.connections.values()) this.fail(c, 'Device revoked locally', 4001);
    this.publishPin();
  }
  send(ws: S | undefined, message: unknown) {
    if (!ws || ws.readyState !== 1) return;
    const connection = this.connections.get(ws);
    if (!connection?.channel) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'Slow connection'); return; }
    ws.send(JSON.stringify(connection.channel.seal(message)));
  }
  private fail(connection: Connection<S>, message: string, code = 1008) {
    if (connection.channel) this.send(connection.ws, { type: 'error', message });
    else if (connection.ws.readyState === 1) connection.ws.send(JSON.stringify({ type: 'error', message }));
    // Synchronously remove authority, not merely after the close handshake.
    if (this.controller === connection.ws) this.controller = undefined;
    connection.ws.close(code, message.slice(0, 100));
    this.remove(connection.ws);
  }
  private remove(ws: S) {
    const connection = this.connections.get(ws);
    this.connections.delete(ws);
    if (this.controller === ws) this.controller = undefined;
    if (connection?.pendingId) this.gate.cancel(connection.pendingId);
    connection?.channel?.dispose();
  }
  private activate(connection: Connection<S>) {
    if (this.controller && this.controller !== connection.ws) throw new Error('Approved device is already connected; close its other tab first');
    this.controller = connection.ws;
    connection.phase = 'active';
    connection.deadline = Date.now() + 30 * 60_000;
    this.options.onAuthenticated(connection.ws);
  }
  attach(ws: S, metadata: AttachMetadata | IncomingMessage = {}) {
    const meta: AttachMetadata = 'socket' in metadata
      ? { peer: metadata.socket.remoteAddress, userAgent: metadata.headers['user-agent'] }
      : { ...metadata };
    // Capture and validate before any OPAQUE or application frames are handled.
    let binding: ChannelBinding | undefined;
    try {
      if ((this.options.requireBinding || meta.requireBinding || meta.autoApprove) && !meta.channelBinding) throw new Error('DTLS channel binding required');
      if (meta.channelBinding) {
        canonicalChannelBinding(meta.channelBinding);
        binding = { ...meta.channelBinding };
      }
    } catch {
      ws.close(4001, 'DTLS channel binding required');
      return;
    }
    const connection: Connection<S> = { ws, phase: 'hello', deadline: Date.now() + 10_000 };
    this.connections.set(ws, connection);
    let confirmationCodeForConnection: string | undefined;
    ws.on('error', () => {});
    ws.on('close', () => this.remove(ws));
    ws.on('message', (raw, binary) => {
      if (!this.connections.has(ws)) return;
      try {
        if (binary || Date.now() >= connection.deadline) throw new Error('Invalid or expired connection');
        const frame = JSON.parse(raw.toString());
        if (connection.phase === 'hello') {
          if (frame?.type !== 'hello' || typeof frame.request !== 'string' || frame.request.length > 4096) throw new Error('OPAQUE handshake required');
          connection.kind = frame.kind;
          if (frame.kind === 'pair' && !this.device) connection.challenge = this.gate.begin(frame.request);
          else if (frame.kind === 'resume' && this.device && frame.deviceId === this.device.id) {
            const challenge = opaque.server.startLogin({ serverSetup: this.gate.setup, registrationRecord: this.device.record, userIdentifier: this.device.id, startLoginRequest: frame.request });
            connection.challenge = { ...challenge, generation: -1, expiresAt: Date.now() + 10_000 };
          } else throw new Error('Pairing unavailable or device not approved');
          connection.phase = 'challenge';
          connection.deadline = Math.min(connection.deadline, connection.challenge.expiresAt);
          ws.send(JSON.stringify({ type: 'challenge', response: connection.challenge.loginResponse }));
          this.publishPin();
          return;
        }
        if (connection.phase === 'challenge') {
          if (frame?.type !== 'finish' || typeof frame.request !== 'string' || typeof frame.header !== 'string' || frame.header.length > 100) throw new Error('OPAQUE proof required');
          const result = connection.kind === 'pair' ? this.gate.finish(connection.challenge!, frame.request) : opaque.server.finishLogin({ serverLoginState: connection.challenge!.serverLoginState, finishLoginRequest: frame.request });
          connection.challenge = undefined;
          connection.channel = new EncryptedChannel(result.sessionKey, 'server', binding);
          connection.channel.acceptHeader(frame.header);
          ws.send(JSON.stringify({ type: 'secure', header: connection.channel.header }));
          if (connection.kind === 'resume') {
            if (this.controller) { this.fail(connection, 'Approved device is already connected; close its other tab first', 4000); return; }
            connection.phase = 'resuming';
          } else {
            connection.phase = 'pending';
            const review = describeDevice(meta.peer ?? 'Unknown', meta.userAgent);
            const candidate = this.gate.pending(result.sessionKey, review, () => {
              if (!connection.enrollment || ws.readyState !== 1 || Date.now() >= connection.deadline) throw new Error('Enrollment expired');
              this.device = connection.enrollment;
              this.send(ws, { type: 'approved', deviceId: this.device.id, serverId: this.gate.serverId });
              this.activate(connection);
            }, () => this.fail(connection, 'Pairing rejected or expired', 4001));
            confirmationCodeForConnection = candidate.code;
            connection.pendingId = candidate.id;
            connection.deadline = candidate.expiresAt;
            this.publishPin();
            this.send(ws, { type: 'pending', expiresAt: candidate.expiresAt, remainingMs: candidate.expiresAt - Date.now() });
          }
          return;
        }
        const message = connection.channel!.open(frame);
        if (connection.phase === 'resuming') {
          if (message?.type !== 'ready') throw new Error('Encrypted binding confirmation required');
          this.activate(connection);
          return;
        }
        if (connection.phase === 'pending') {
          if (message?.type !== 'enroll' || typeof message.password !== 'string' || !/^[a-f0-9]{64}$/.test(message.password)) throw new Error('Encrypted device enrollment required');
          const id = randomBytes(16).toString('hex');
          connection.enrollment = { id, record: registration(this.gate.setup, id, message.password) };
          if (Date.now() >= connection.deadline) throw new Error('Enrollment expired');
          connection.phase = 'review';
          const review = describeDevice(meta.peer ?? 'Unknown', meta.userAgent);
          if (meta.autoApprove) {
            // Only reached after the encrypted enrollment proved the AAD context.
            const candidate = this.confirm(confirmationCodeForConnection!);
            confirmationCodeForConnection = undefined;
            this.approve(candidate.id);
          } else this.options.onPending?.({ ...review, id: connection.pendingId!, expiresAt: connection.deadline });
          return;
        }
        if (connection.phase === 'review') throw new Error('Local approval required');
        if (!this.isActive(ws)) throw new Error('No terminal authority');
        if (message?.type === 'unpair') { this.revoke(); return; }
        this.options.onMessage(message, ws);
      } catch {
        this.fail(connection, 'Authentication, expiry or encrypted message validation failed', connection.phase === 'active' ? 1008 : 4001);
      }
    });
  }
  dispose() {
    this.gate.close();
    for (const ws of [...this.connections.keys()]) { ws.terminate(); this.remove(ws); }
    this.device = undefined;
  }
}
