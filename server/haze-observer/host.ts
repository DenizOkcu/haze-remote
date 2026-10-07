import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isObserverMessage, MAX_OBSERVER_FRAME_BYTES, type ObserverMessage } from '../../shared/observer.js';

const TOKEN_BYTES = 32;
const MAX_FRAME_BYTES = Math.max(MAX_OBSERVER_FRAME_BYTES + 2048, 160 * 1024);
export type ObserverHost = {
  readonly socketPath: string;
  readonly token: string;
  readonly listening: Promise<void>;
  unsubscribe: () => void;
};
/** Private loopback NDJSON channel from a launched Haze process. */
export function hostObserver(onMessage: (message: ObserverMessage) => void): ObserverHost {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  let buffer = '';
  let path = '';
  const sockets = new Set<import('node:net').Socket>();
  // The preload connection may coexist with the app's own channel in tests.
  const server = createServer({ maxConnections: 4 } as never, socket => {
    socket.unref();
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setNoDelay(true);
    socket.on('data', data => {
      buffer += data.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (buffer.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
        if (!line) continue;
        try {
          const frame = JSON.parse(line);
          if (frame?.token !== token) continue;
          if (isObserverMessage(frame.message)) onMessage(frame.message);
        } catch { /* Malformed frames never crash the supervisor. */ }
      }
    });
    socket.on('error', () => {});
  });
  server.unref();
  const listening = new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address() as { address?: string } | string;
      path = typeof address === 'string' ? address : address?.address ?? '';
      if (path) resolve(); else reject(new Error('Observer socket has no path'));
    });
    server.once('error', reject);
  });
  // macOS abstract sockets are unsupported; use a short filesystem socket path.
  server.listen(join(tmpdir(), `hro-${randomBytes(4).toString('hex')}`));
  return {
    get socketPath() { return path; },
    get token() { return token; },
    listening,
    unsubscribe() { buffer = ''; for (const socket of sockets) socket.destroy(); server.close(); },
  };
}
export function observerEnvironment(host: ObserverHost): { HAZE_REMOTE_OBSERVER_SOCKET: string; HAZE_REMOTE_OBSERVER_TOKEN: string } {
  return { HAZE_REMOTE_OBSERVER_SOCKET: host.socketPath, HAZE_REMOTE_OBSERVER_TOKEN: host.token };
}
