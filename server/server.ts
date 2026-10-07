import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { AccessController } from './access.js';
import type { DeviceReview } from './pairing.js';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

export interface RemoteOptions {
  host: string;
  port: number;
  cwd: string;
  executable: string;
  args: string[];
  assets: string;
  // Used by tests to run Haze with an isolated HOME; production inherits unchanged.
  env?: Record<string, string>;
  onPin?: (pin: { pin: string; expiresAt: number } | null) => void;
  onPending?: (review: DeviceReview) => void;
}

export function privateAddress(host: string) {
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return isIP(host) === 6 && /^(fc|fd|fe[89ab])/i.test(host);
}
const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_INPUT = 16 * 1024;
const MAX_COLS = 240;
const MAX_ROWS = 100;

export async function startRemote(options: RemoteOptions) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('macOS and Linux are supported.');
  await stat(resolve(options.assets, 'index.html')); // Fail before starting Haze if build is missing.
  if (!(await stat(options.cwd)).isDirectory()) throw new Error('Working directory is not a directory.');
  if (!privateAddress(options.host)) throw new Error('Bind to a specific private/VPN or loopback address. Wildcard/public bindings are disabled.');
  await AccessController.ready();
  const hosts = new Set([options.host.includes(':') ? `[${options.host}]` : options.host]);
  if (options.host === 'localhost' || options.host.startsWith('127.') || options.host === '::1') for (const host of ['localhost', '127.0.0.1', '[::1]']) hosts.add(host);
  let port = options.port;
  let child: pty.IPty | undefined;
  let stopped = false;
  let exit: { exitCode: number; signal?: number } | null = null;
  let alive = true;
  let queuedBytes = 0;
  const term = new headless.Terminal({ cols: 100, rows: 30, scrollback: 2000, allowProposedApi: true });
  const snapshot = new serialize.SerializeAddon();
  term.loadAddon(snapshot);
  // SerializeAddon retains cell colors, but not OSC terminal default colors.
  // Haze themes use OSC 10/11, so retain those small, validated settings too.
  const colors = new Map<number, string>();
  for (const id of [10, 11]) term.parser.registerOscHandler(id, data => {
    if (/^rgb:[a-f0-9]{2,4}\/[a-f0-9]{2,4}\/[a-f0-9]{2,4}$/i.test(data)) colors.set(id, `\x1b]${id};${data}\x07`);
    return false;
  });
  for (const id of [110, 111]) term.parser.registerOscHandler(id, () => { colors.delete(id - 100); return false; });
  // Answer terminal device queries when no browser is attached. The active
  // browser answers them itself; ordinary keyboard input remains browser-owned.
  term.onData(data => { if (!access.active() && !exit && !stopped) child?.write(data); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const access = new AccessController({ onPin: options.onPin, onPending: options.onPending,
    onAuthenticated(ws) {
      alive = true;
      term.write('', () => {
        if (stopped || !access.isActive(ws)) return;
        send(ws, { type: 'snapshot', data: '\x1b]110\x07\x1b]111\x07' + [...colors.values()].join('') + snapshot.serialize(), cols: term.cols, rows: term.rows, exit, pid: child?.pid, cwd: options.cwd });
      });
    },
    onMessage(message, ws) {
      if (message?.type === 'input' && !exit && typeof message.data === 'string' && Buffer.byteLength(message.data) <= MAX_INPUT) child?.write(message.data);
      else if (message?.type === 'resize' && !exit && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 20 && message.cols <= MAX_COLS && message.rows >= 5 && message.rows <= MAX_ROWS) {
        if (term.cols !== message.cols || term.rows !== message.rows) { term.resize(message.cols, message.rows); child?.resize(message.cols, message.rows); }
      } else if (message?.type === 'ping') send(ws, { type: 'pong' });
      else throw new Error('Invalid terminal message');
    },
  });

  function validHost(req: IncomingMessage) {
    try {
      const url = new URL(`http://${req.headers.host}`);
      return hosts.has(url.hostname) && Number(url.port || 80) === port && url.host === req.headers.host;
    } catch { return false; }
  }
  function sameOrigin(req: IncomingMessage) {
    return validHost(req) && req.headers.origin === `http://${req.headers.host}`;
  }
  function reply(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  function send(ws: WebSocket | undefined, message: unknown) {
    access.send(ws, message);
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, { error: 'Request failed' });
      else res.destroy();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!validHost(req)) return reply(res, 403, { error: 'Unrecognized host' });
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/api/info' && req.method === 'GET') return reply(res, 200, access.info());
    // Pairing, approval, credentials, session metadata and terminal traffic
    // are never exposed through plaintext HTTP APIs or cookie authentication.
    if (url.pathname.startsWith('/api/')) return reply(res, 404, { error: 'Not found' });
    if (!['GET', 'HEAD'].includes(req.method ?? '')) return reply(res, 405, { error: 'Method not allowed' });
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return reply(res, 400, { error: 'Invalid path' }); }
    // Only compiled assets are served, never the project working directory.
    const file = resolve(options.assets, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!file.startsWith(resolve(options.assets) + sep)) return reply(res, 404, { error: 'Not found' });
    try {
      const data = await readFile(file);
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { reply(res, 404, { error: 'Not found' }); }
  }
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (stopped || req.url !== '/ws' || !sameOrigin(req) || !privateAddress(peer) || wss.clients.size >= 16) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      access.attach(ws, req);
      ws.on('pong', () => { if (access.isActive(ws)) alive = true; });
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => { server.removeListener('error', reject); accept(); });
  });
  port = (server.address() as { port: number }).port;
  try {
    child = pty.spawn(options.executable, options.args, {
      name: 'xterm-256color', cols: term.cols, rows: term.rows,
      cwd: options.cwd, env: { ...(options.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
  } catch (error) {
    server.close(); wss.close(); access.dispose(); term.dispose();
    throw new Error(`Could not start ${options.executable} in a PTY. Check installation and PATH.`, { cause: error });
  }
  let resolveExit: () => void;
  const exited = new Promise<void>(r => { resolveExit = r; });
  child.onData(data => {
    // Bound parser backlog even when a child emits output faster than it can render.
    const bytes = Buffer.byteLength(data);
    queuedBytes += bytes;
    if (queuedBytes > MAX_BUFFER) child!.pause();
    term.write(data, () => {
      queuedBytes -= bytes;
      if (queuedBytes < MAX_BUFFER / 2 && !exit && !stopped) child!.resume();
      send(access.active(), { type: 'output', data });
    });
  });
  child.onExit(event => {
    exit = event;
    resolveExit();
    term.write('', () => send(access.active(), { type: 'exit', ...event }));
  });
  const lifecycle = setInterval(() => access.tick(), 250);
  const heartbeat = setInterval(() => {
    const active = access.active();
    if (!active) return;
    if (!alive) { active.terminate(); return; }
    alive = false;
    active.ping();
  }, 15_000);
  lifecycle.unref(); heartbeat.unref();
  async function close() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat); clearInterval(lifecycle);
    access.dispose();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    const closed = new Promise<void>(r => server.close(() => r()));
    server.closeAllConnections();
    if (!exit) {
      child!.kill('SIGTERM');
      const force = setTimeout(() => { if (!exit) child!.kill('SIGKILL'); }, 2000);
      await exited;
      clearTimeout(force);
    }
    await closed;
    term.dispose();

  }
  return { port, pid: child.pid, close, exited,
    // These methods are local capabilities; no network endpoint exposes them.
    local: { pin: () => access.gate.localPin(), confirm: (code: string) => access.confirm(code), approve: (id: string) => access.approve(id), reject: () => access.reject(), pair: () => access.openPairing(), revoke: () => access.revoke() },
  };
}
