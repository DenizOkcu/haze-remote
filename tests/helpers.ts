import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { ClientSession, type SocketTransport } from '../shared/session.js';
import { type DeviceCredential } from '../shared/crypto.js';
import type { LanPeerOptions } from '../server/webrtc.js';

export const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function until(check: () => boolean | Promise<boolean>, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error('Timed out waiting for expected state');
}

// Test-only duplex transport. Real ClientSession/AccessController perform OPAQUE
// and secretstream; only DTLS/network delivery is replaced, never authentication.
export class TestSocket extends EventEmitter implements SocketTransport {
  static readonly CLOSED = 3;
  readyState = 0;
  bufferedAmount = 0;
  onopen: SocketTransport['onopen'] = null;
  onmessage: SocketTransport['onmessage'] = null;
  onclose: SocketTransport['onclose'] = null;
  onerror: SocketTransport['onerror'] = null;
  channelBinding = {
    clientFingerprint: createHash('sha256').update('test-client').digest('hex'),
    serverFingerprint: createHash('sha256').update('test-server').digest('hex'),
  };
  peer!: TestSocket;
  send(data: string) {
    if (this.readyState !== 1) throw new Error('Transport closed');
    queueMicrotask(() => {
      if (this.peer.readyState !== 1) return;
      this.peer.emit('message', data, false);
      this.peer.onmessage?.({ data });
    });
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = this.peer.readyState = 3;
    queueMicrotask(() => {
      for (const socket of [this, this.peer]) {
        socket.emit('close', code, reason);
        socket.onclose?.({ code, reason });
      }
    });
  }
  terminate() { this.close(); }
  ping() { queueMicrotask(() => this.emit('pong')); }
}
export function peerHarness() {
  let options: LanPeerOptions;
  const sockets = new Set<TestSocket>();
  return {
    lan: { interfaceName: 'test', address: '192.168.1.10', subnet: '192.168.1.0/24', netmask: '255.255.255.0', network: 3232235776, prefix: 24 },
    peerFactory: async (value: LanPeerOptions) => {
      options = value;
      return { async resetPeer() {}, async close() { for (const socket of sockets) socket.close(); } };
    },
    socket(binding?: TestSocket['channelBinding']) {
      const client = new TestSocket(), server = new TestSocket();
      client.peer = server; server.peer = client;
      if (binding) client.channelBinding = server.channelBinding = { ...binding };
      client.readyState = server.readyState = 1;
      sockets.add(server);
      options.onSocket(server, { peer: '192.168.1.20', userAgent: 'Test RTC', channelBinding: { ...server.channelBinding } });
      return client;
    },
    audio(payload: Buffer) { options.onAudio?.(payload); },
  };
}
export async function connection(target: { remote: { serverId: string }; transport: ReturnType<typeof peerHarness> }, password: string, credential?: DeviceCredential) {
  await ClientSession.ready();
  const ws = target.transport.socket();
  const messages: any[] = [], wire: string[] = [], errors: string[] = [];
  const state: { code?: string; expiresAt?: number; reviewExpiresAt?: number; credential?: DeviceCredential; closed?: number } = {};
  ws.on('message', raw => wire.push(raw.toString()));
  const session = new ClientSession(ws, { serverId: target.remote.serverId, requireBinding: true, password, credential,
    onPending(code, expiresAt) { state.code = code; state.expiresAt = expiresAt; },
    onReview(expiresAt) { state.reviewExpiresAt = expiresAt; },
    onApproved(value) { state.credential = value; }, onError(message) { errors.push(message); }, onClose(code) { state.closed = code; },
  });
  session.subscribe(message => messages.push(message));
  queueMicrotask(() => ws.onopen?.({}));
  return { ws, session, messages, wire, errors, state, output: () => messages.map(m => m.data ?? '').join('') };
}
