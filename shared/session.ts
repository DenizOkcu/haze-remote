import { cryptoReady, opaque, EncryptedChannel, confirmationCode, devicePassword, type DeviceCredential } from './crypto.js';

export interface SocketTransport {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
}
export interface SessionOptions {
  serverId: string;
  password: string;
  credential?: DeviceCredential;
  onPending?: (code: string, expiresAt: number, remainingMs: number) => void;
  onReview?: (expiresAt: number, remainingMs: number) => void;
  onApproved?: (credential: DeviceCredential) => void;
  onError?: (message: string) => void;
  onClose?: (code: number) => void;
}

// Shared by the browser and integration tests; the server uses the independent
// OPAQUE server API. No plaintext application-message fallback exists.
export class ClientSession {
  private channel?: EncryptedChannel;
  private start: ReturnType<typeof opaque.client.startLogin>;
  private password: string;
  private newPassword?: string;
  private publicKey = '';
  private code = '';
  private authorized = false;
  private listener?: (message: any) => void;
  private queue: any[] = [];
  private queuedSize = 0;
  constructor(readonly socket: SocketTransport, private readonly options: SessionOptions) {
    this.password = options.password;
    this.start = opaque.client.startLogin({ password: this.password });
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', kind: options.credential ? 'resume' : 'pair', deviceId: options.credential?.deviceId, request: this.start.startLoginRequest }));
    socket.onmessage = event => {
      try {
        const wire = event.data.toString();
        if (wire.length > 12 * 1024 * 1024) throw new Error('Server frame too large');
        const frame = JSON.parse(wire);
        if (!this.channel) {
          if (frame.type === 'error') throw new Error(frame.message);
          if (frame.type !== 'challenge') throw new Error('OPAQUE server proof required');
          const result = opaque.client.finishLogin({ password: this.password, clientLoginState: this.start.clientLoginState, loginResponse: frame.response });
          this.password = '';
          this.start = { clientLoginState: '', startLoginRequest: '' };
          if (!result) throw new Error('Incorrect or expired PIN A / device credential');
          if (options.credential && result.serverStaticPublicKey !== options.credential.serverPublicKey) throw new Error('Server identity changed; pair again locally');
          this.publicKey = result.serverStaticPublicKey;
          this.code = confirmationCode(result.sessionKey);
          this.channel = new EncryptedChannel(result.sessionKey, 'client');
          socket.send(JSON.stringify({ type: 'finish', request: result.finishLoginRequest, header: this.channel.header }));
          return;
        }
        if (frame.type === 'secure') { this.channel.acceptHeader(frame.header); return; }
        const message = this.channel.open(frame);
        if (message.type === 'error') { options.onError?.(message.message); return; }
        if (message.type === 'pending') {
          this.newPassword = devicePassword();
          socket.send(JSON.stringify(this.channel.seal({ type: 'enroll', password: this.newPassword })));
          options.onPending?.(this.code, message.expiresAt, message.remainingMs);
          return;
        }
        if (message.type === 'review') {
          if (!this.newPassword || this.authorized || options.credential) throw new Error('Unexpected local review');
          this.code = '';
          options.onReview?.(message.expiresAt, message.remainingMs);
          return;
        }
        if (message.type === 'approved') {
          if (!this.newPassword || message.serverId !== options.serverId || !/^[a-f0-9]{32}$/.test(message.deviceId)) throw new Error('Invalid enrollment confirmation');
          const credential = { serverId: options.serverId, deviceId: message.deviceId, password: this.newPassword, serverPublicKey: this.publicKey };
          this.newPassword = undefined;
          this.authorized = true;
          options.onApproved?.(credential);
          return;
        }
        if (message.type === 'snapshot' && options.credential) this.authorized = true;
        if (!this.authorized) throw new Error('Local approval required before terminal data');
        if (this.listener) this.listener(message);
        else {
          this.queuedSize += JSON.stringify(message).length;
          if (this.queuedSize > 8 * 1024 * 1024) throw new Error('Terminal consumer too slow');
          this.queue.push(message);
        }
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : 'Encrypted connection failed');
        socket.close(4001, 'Encrypted protocol validation failed');
      }
    };
    socket.onclose = event => { this.authorized = false; this.channel?.dispose(); this.channel = undefined; this.password = ''; this.newPassword = undefined; options.onClose?.(event.code); };
    socket.onerror = () => socket.close();
  }
  static async ready() { await cryptoReady; }
  subscribe(listener: (message: any) => void) {
    this.listener = listener;
    const queue = this.queue; this.queue = []; this.queuedSize = 0;
    for (const message of queue) listener(message);
    return () => { if (this.listener === listener) this.listener = undefined; };
  }
  send(message: unknown) {
    if (!this.authorized || !this.channel || this.socket.readyState !== 1 || this.socket.bufferedAmount > 256 * 1024) return false;
    try {
      this.socket.send(JSON.stringify(this.channel.seal(message)));
      return true;
    } catch (error) {
      // Sealing advances stream state; a failed write cannot reuse that stream.
      this.socket.close();
      throw error;
    }
  }
  close() { this.socket.close(); }
}
