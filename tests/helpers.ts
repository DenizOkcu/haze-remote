import { WebSocket } from 'ws';
import { ClientSession, type SocketTransport } from '../shared/session.js';
import { type DeviceCredential } from '../shared/crypto.js';

export const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function until(check: () => boolean | Promise<boolean>, timeout = 8000) {
  // Keep test waits bounded even when expiry tests mock the wall clock.
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error('Timed out waiting for expected state');
}
export async function connection(origin: string, password: string, credential?: DeviceCredential) {
  await ClientSession.ready();
  const info = await (await fetch(origin + '/api/info')).json();
  const ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, 'User-Agent': 'Version/26.0 Safari iPad', 'X-Forwarded-For': '6.6.6.6' } });
  const messages: any[] = [], wire: string[] = [], errors: string[] = [];
  const state: { code?: string; expiresAt?: number; reviewExpiresAt?: number; credential?: DeviceCredential; closed?: number } = {};
  ws.on('message', raw => wire.push(raw.toString()));
  const session = new ClientSession(ws as unknown as SocketTransport, { serverId: info.serverId, password, credential,
    onPending(code, expiresAt) { state.code = code; state.expiresAt = expiresAt; },
    onReview(expiresAt) { state.reviewExpiresAt = expiresAt; },
    onApproved(value) { state.credential = value; }, onError(message) { errors.push(message); }, onClose(code) { state.closed = code; },
  });
  session.subscribe(message => messages.push(message));
  return { ws, session, messages, wire, errors, state, output: () => messages.map(m => m.data ?? '').join('') };
}
