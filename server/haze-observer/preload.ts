import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { createConnection, type Socket } from 'node:net';
import { HazeObserver } from './runtime.js';
import { MAX_OBSERVER_FRAME_BYTES, type ObserverMessage } from '../../shared/observer.js';

const MAX_QUEUE_BYTES = 1024 * 1024;
/** Each NDJSON frame is {token, message}; token is only used on the private local IPC channel. */
export function connectObserver(path: string, token: string): { emit: (message: ObserverMessage) => void; close: () => void } {
  let socket: Socket | undefined;
  let closed = false, connected = false, blocked = false, bytes = 0;
  const queue: Buffer[] = [];
  const close = () => { closed = true; queue.length = 0; bytes = 0; socket?.destroy(); };
  const flush = () => {
    if (!connected || closed || blocked || !socket) return;
    while (queue.length && !blocked) {
      const frame = queue.shift()!; bytes -= frame.length;
      blocked = !socket.write(frame);
    }
  };
  socket = createConnection({path});
  socket.unref();
  socket.on('connect', () => { connected = true; flush(); });
  socket.on('drain', () => { blocked = false; flush(); });
  socket.on('error', close); socket.on('close', close);
  return { close, emit(message) {
    if (closed) return;
    const frame = Buffer.from(JSON.stringify({token, message}) + '\n');
    if (frame.length > MAX_OBSERVER_FRAME_BYTES || bytes + frame.length + (socket?.writableLength ?? 0) > MAX_QUEUE_BYTES) { close(); return; }
    queue.push(frame); bytes += frame.length; flush();
  }};
}

// Missing IPC opts means a transparent no-op: no loader or config discovery.
const path = process.env.HAZE_REMOTE_OBSERVER_SOCKET;
const token = process.env.HAZE_REMOTE_OBSERVER_TOKEN;
if (path && token && token.length <= 1024) {
  const transport = connectObserver(path, token);
  const runtime = new HazeObserver(transport.emit);
  let enabled = false;
  const symbol = Symbol.for('haze.remote.observer');
  (globalThis as any)[symbol] = {
    bindSession: (prompt: object, id: unknown) => enabled ? runtime.bindSession(prompt, id) : prompt,
    wrapTool: (options: any, coordinator: any, tool: any) => enabled ? runtime.wrapTool(options, coordinator, tool) : tool,
    streamOptions: (original: any) => enabled ? runtime.streamOptions(original) : original,
  };
  const {port1, port2} = new MessageChannel();
  port1.on('message', (message: any) => {
    if (message?.type !== 'observer-status') return;
    enabled = message.status === 'ready';
    transport.emit(message);
  });
  // Without unref, this port would keep the host process alive after Haze exits.
  port1.unref();
  try { register(new URL('./loader.js', import.meta.url), {parentURL: import.meta.url, data: {port: port2}, transferList: [port2]}); }
  catch { enabled = false; transport.emit({type: 'observer-status', status: 'unsupported', message: 'Node asynchronous loader registration unavailable'}); }
}
