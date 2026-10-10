import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { randomUUID, X509Certificate } from 'node:crypto';
import { readFile, stat, realpath } from 'node:fs/promises';
import { resolve, sep, extname, basename } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { AccessController } from './access.js';
import type { DeviceReview } from './pairing.js';
import { FleetManager } from './fleet.js';
import { isFleetRequest, type FleetProject } from '../shared/fleet.js';
import { isSkillRequest } from '../shared/skills.js';
import { SkillManager } from './skills.js';
import { isManagementRequest } from '../shared/configuration.js';
import { ConfigurationManager } from './configuration.js';
import { SessionCatalog } from './sessions.js';
import { SpeechService, decodeAudio, type SpeechBackend } from './speech.js';
import { isSpeechRequest } from '../shared/speech.js';

export interface RemoteOptions {
  host: string; port: number; cwd: string; executable: string; args: string[]; assets: string;
  newArgs?: string[];
  speech?: SpeechBackend;
  tls?: { cert: Buffer; key: Buffer };
  hostname?: string;
  projects?: { name: string; cwd: string }[];
  // Tests use isolated HOME. Production inherits the Haze environment unchanged.
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
export async function startRemote(options: RemoteOptions) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('macOS and Linux are supported.');
  await stat(resolve(options.assets, 'index.html'));
  if (!privateAddress(options.host)) throw new Error('Bind to a specific private/VPN or loopback address. Wildcard/public bindings are disabled.');
  if (options.hostname !== undefined) {
    if (options.hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(options.hostname)) throw new Error('Use an exact lowercase DNS hostname, not a URL or wildcard.');
    if (!options.tls) throw new Error('A DNS hostname requires TLS.');
    const certificate = new X509Certificate(options.tls.cert);
    if (!certificate.checkHost(options.hostname, { wildcards: false }) || Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()) throw new Error('TLS certificate must be valid for the configured hostname.');
  }
  const projects: FleetProject[] = [];
  for (const project of [{ cwd: options.cwd, name: basename(resolve(options.cwd)) || 'Project' }, ...(options.projects ?? [])]) {
    const cwd = await realpath(resolve(project.cwd));
    if (!(await stat(cwd)).isDirectory()) throw new Error('Working directory is not a directory.');
    if (!project.name.trim() || project.name.length > 80 || /[\x00-\x1f\x7f]/.test(project.name)) throw new Error('Project names must be printable and at most 80 characters.');
    if (!projects.some(existing => existing.cwd === cwd)) projects.push({ id: `project-${projects.length + 1}`, name: project.name, cwd });
  }
  if (projects.length > 16) throw new Error('At most 16 locally approved projects are supported.');
  await AccessController.ready();
  const hosts = new Set([options.host.includes(':') ? `[${options.host}]` : options.host]);
  if (options.host === 'localhost' || options.host.startsWith('127.') || options.host === '::1') for (const host of ['localhost', '127.0.0.1', '[::1]']) hosts.add(host);
  if (options.hostname) hosts.add(options.hostname);
  const protocol = options.tls ? 'https' : 'http';
  let port = options.port, stopped = false, alive = true;
  let fleet: FleetManager;
  let primaryId = '', lastSelectedId = '';
  let selection: { id: string; viewId: string; ws: WebSocket; ready: boolean } | undefined;
  const creations = new Map<string, Promise<string>>();
  const speech = options.speech ?? new SpeechService(options.env?.HOME);
  const speechJobs = new Map<WebSocket, { id: string; controller: AbortController }>();
  let modelDownload: { controller: AbortController; done: Promise<void> } | undefined;
  let modelDownloadError: string | undefined;
  const speechStatus = async () => ({ ...await speech.status(), ...(modelDownloadError ? { error: modelDownloadError } : {}) });
  const skills = new SkillManager(projects, options.env?.HOME);
  const configuration = new ConfigurationManager(options.env?.HOME);
  const sessions = new SessionCatalog(projects, options.env?.HOME);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  const access = new AccessController({ onPin: options.onPin, onPending: options.onPending,
    onAuthenticated(ws) {
      alive = true;
      void show(ws, fleet.get(lastSelectedId) ? lastSelectedId : fleet.first()!.id).catch(() => { if (access.isActive(ws)) ws.close(1011, 'Snapshot unavailable'); });
    },
    onMessage(message, ws) {
      if (message?.type === 'ping') { send(ws, { type: 'pong' }); return; }
      if (typeof message?.type === 'string' && message.type.startsWith('speech-')) {
        if (!isSpeechRequest(message)) { send(ws, { type: 'speech-error', requestId: message.requestId, message: 'Invalid speech request.' }); return; }
        if (message.type === 'speech-cancel') {
          const job = speechJobs.get(ws);
          if (job?.id === message.targetRequestId) job.controller.abort();
          return;
        }
        if (message.type === 'speech-download' || message.type === 'speech-download-cancel') {
          void (async () => {
            if (message.type === 'speech-download-cancel') {
              const job = modelDownload;
              job?.controller.abort(); await job?.done;
              modelDownloadError = undefined;
            } else if (!modelDownload) {
              // Once approved, downloading belongs to the host, not a browser socket.
              modelDownloadError = undefined;
              const job = { controller: new AbortController(), done: Promise.resolve() };
              modelDownload = job;
              job.done = speech.download(job.controller.signal).catch(error => {
                if (!job.controller.signal.aborted) modelDownloadError = error instanceof Error && !('code' in error)
                  ? error.message.slice(0, 240) : 'Model download failed. Check internet access and retry.';
              }).finally(() => { if (modelDownload === job) modelDownload = undefined; });
            }
            const status = await speechStatus();
            if (access.isActive(ws)) send(ws, { type: 'speech-result', requestId: message.requestId, status });
          })().catch(() => { if (access.isActive(ws)) send(ws, { type: 'speech-error', requestId: message.requestId, message: 'Speech service unavailable.' }); });
          return;
        }
        if (message.type === 'speech-status') {
          void speechStatus().then(status => { if (access.isActive(ws)) send(ws, { type: 'speech-result', requestId: message.requestId, status }); })
            .catch(() => { if (access.isActive(ws)) send(ws, { type: 'speech-error', requestId: message.requestId, message: 'Speech service unavailable.' }); });
          return;
        }
        if (speechJobs.has(ws)) { send(ws, { type: 'speech-error', requestId: message.requestId, message: 'A speech operation is already running.' }); return; }
        const job = { id: message.requestId, controller: new AbortController() }; speechJobs.set(ws, job);
        void (async () => {
          try {
            let text: string | undefined;
            const audio = decodeAudio(message.audio);
            message.audio = ''; // Drop the transport's audio reference before inference.
            try { text = await speech.transcribe(audio, job.controller.signal); }
            finally { audio.fill(0); }
            if (!job.controller.signal.aborted && access.isActive(ws)) send(ws, { type: 'speech-result', requestId: message.requestId, status: await speech.status(), ...(text !== undefined ? { text } : {}) });
          } catch (error) {
            if (!job.controller.signal.aborted && access.isActive(ws)) send(ws, { type: 'speech-error', requestId: message.requestId,
              message: error instanceof Error && !('code' in error) ? error.message.slice(0, 240) : 'Speech operation failed. Retry when the service is available.' });
          } finally { if (speechJobs.get(ws) === job) speechJobs.delete(ws); }
        })();
        return;
      }
      if (message?.type === 'input' || message?.type === 'resize') {
        const id = message.instanceId ?? primaryId;
        if (message.type === 'input' && (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 16 * 1024)) throw new Error('Invalid input');
        if (message.type === 'resize' && (!Number.isInteger(message.cols) || !Number.isInteger(message.rows) || message.cols < 20 || message.cols > 240 || message.rows < 5 || message.rows > 100)) throw new Error('Invalid resize');
        // Legacy clients without IDs only control the initial instance. Modern
        // input/resize requires the exact snapshot's view token, never a tab index.
        if (!selection?.ready || selection.ws !== ws || selection.id !== id || (message.instanceId !== undefined && selection.viewId !== message.viewId)) {
          send(ws, { type: 'fleet-error', message: 'Instance selection changed. Wait for its snapshot before sending input.' }); return;
        }
        if (message.type === 'input') {
          if (!fleet.input(id, message.data)) send(ws, { type: 'fleet-error', message: 'This Haze instance has stopped. Select or start a running instance.' });
        } else fleet.resize(id, message.cols, message.rows);
        return;
      }
      if (typeof message?.type === 'string' && /^(skills-|skill-)/.test(message.type)) {
        if (!isSkillRequest(message)) { send(ws, { type: 'skills-error', requestId: message.requestId, message: 'Invalid skill request.' }); return; }
        void skills.execute(message, () => access.isActive(ws)).then(result => {
          if (access.isActive(ws)) send(ws, { type: 'skills-result', requestId: message.requestId, ...result });
        }).catch(error => {
          const detail = error instanceof Error && !('code' in error) ? error.message : 'Skill operation failed. Check the skill directory and try again.';
          if (access.isActive(ws)) send(ws, { type: 'skills-error', requestId: message.requestId, message: detail.slice(0, 240) });
        });
        return;
      }
      if (typeof message?.type === 'string' && /^(configuration-|provider-|settings-|sessions-)/.test(message.type)) {
        if (!isManagementRequest(message)) { send(ws, { type: 'management-error', requestId: message.requestId, message: 'Invalid configuration request.' }); return; }
        void (message.type === 'sessions-list'
          ? sessions.list(projects.find(project => project.id === message.projectId)!).catch(() => ({ sessions: [], warnings: ['Session history is unavailable.'], canFork: false }))
            .then(result => { if (access.isActive(ws)) send(ws, { type: 'sessions-result', requestId: message.requestId, ...result }); })
          : configuration.execute(message, () => access.isActive(ws))
            .then(configurationResult => { if (access.isActive(ws)) send(ws, { type: 'configuration-result', requestId: message.requestId, configuration: configurationResult }); })
            .catch(error => {
              const detail = error instanceof Error && !('code' in error) ? error.message : 'Configuration operation failed. Check the settings file and try again.';
              if (access.isActive(ws)) send(ws, { type: 'management-error', requestId: message.requestId, message: detail.slice(0, 240) });
            }));
        return;
      }
      if (!isFleetRequest(message)) throw new Error('Invalid fleet message');
      void (async () => {
        try {
          if (message.type === 'instance-select') { await show(ws, message.instanceId, message.requestId); return; }
          if (message.type === 'instance-create') {
            let creation = creations.get(message.requestId);
            if (!creation) {
              // Never evict pending/successful IDs: an old retry must not spawn
              // another process. Failed launches have no side effect to dedupe.
              if (creations.size >= 256) throw new Error('Launch request history is full. Restart haze-remote before starting more instances.');
              creation = fleet.create(message.name.trim(), message.projectId, message.allowShared, false, () => access.isActive(ws),
                message.launch?.mode === 'resume' ? { mode: 'resume', sessionId: message.launch.sessionId } : { mode: 'fresh' }).then(instance => instance.id).catch(error => {
                creations.delete(message.requestId); throw error;
              });
              creations.set(message.requestId, creation);
            }
            const id = await creation;
            if (access.isActive(ws)) await show(ws, id, message.requestId);
            return;
          }
          if (!fleet.get(message.instanceId)) throw new Error('Instance no longer exists.');
          if (message.type === 'instance-stop') await fleet.stop(message.instanceId);
          else if (message.type === 'instance-close') {
            fleet.remove(message.instanceId);
            if (selection?.id === message.instanceId) await show(ws, fleet.first()!.id);
          } else if (message.type === 'worker-watch') fleet.watch(message.instanceId, message.workerKey!);
          else fleet.unwatch(message.instanceId);
          if (access.isActive(ws)) send(ws, { type: 'fleet-result', requestId: message.requestId });
        } catch (error) {
          if (access.isActive(ws)) send(ws, { type: 'fleet-error', requestId: message.requestId,
            message: (error instanceof Error ? error.message : 'Fleet operation failed.').slice(0, 240) });
        }
      })();
    },
  });
  function send(ws: WebSocket | undefined, message: unknown) { access.send(ws, message); }
  async function show(ws: WebSocket, id: string, requestId?: string) {
    if (!fleet.get(id)) throw new Error('Instance no longer exists.');
    const next = { id, viewId: randomUUID(), ws, ready: false };
    selection = next; lastSelectedId = id;
    const snapshot = await fleet.snapshot(id);
    if (stopped || !access.isActive(ws) || selection !== next) return;
    send(ws, { type: 'snapshot', ...snapshot, instanceId: id, viewId: next.viewId, requestId,
      capabilities: { fleet: 1, subagents: 'observed-v1' }, fleet: fleet.state() });
    next.ready = true;
  }
  function validHost(req: IncomingMessage) {
    try { const url = new URL(`${protocol}://${req.headers.host}`); return hosts.has(url.hostname) && Number(url.port || (options.tls ? 443 : 80)) === port && url.host === req.headers.host; }
    catch { return false; }
  }
  function sameOrigin(req: IncomingMessage) { return validHost(req) && req.headers.origin === `${protocol}://${req.headers.host}`; }
  function reply(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  }
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => { if (!res.headersSent) reply(res, 500, { error: 'Request failed' }); else res.destroy(); });
  };
  const server = options.tls ? createHttpsServer(options.tls, handler) : createServer(handler);
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!validHost(req)) return reply(res, 403, { error: 'Unrecognized host' });
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/api/info' && req.method === 'GET') return reply(res, 200, access.info());
    if (url.pathname.startsWith('/api/')) return reply(res, 404, { error: 'Not found' });
    if (!['GET', 'HEAD'].includes(req.method ?? '')) return reply(res, 405, { error: 'Method not allowed' });
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return reply(res, 400, { error: 'Invalid path' }); }
    const file = resolve(options.assets, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!file.startsWith(resolve(options.assets) + sep)) return reply(res, 404, { error: 'Not found' });
    try {
      const data = await readFile(file);
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch { reply(res, 404, { error: 'Not found' }); }
  }
  server.on('upgrade', (req, socket, head) => {
    const peer = req.socket.remoteAddress ?? 'Unknown';
    if (stopped || req.url !== '/ws' || !sameOrigin(req) || !privateAddress(peer.replace(/^::ffff:/, '')) || wss.clients.size >= 16) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('close', () => { speechJobs.get(ws)?.controller.abort(); speechJobs.delete(ws); });
      access.attach(ws, req); ws.on('pong', () => { if (access.isActive(ws)) alive = true; });
    });
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port, options.host, () => { server.removeListener('error', reject); accept(); }); });
  port = (server.address() as { port: number }).port;
  fleet = new FleetManager({ executable: options.executable, args: options.args, newArgs: options.newArgs ?? [], projects, env: options.env,
    isViewed: id => !!selection?.ready && selection.id === id && access.isActive(selection.ws),
    onEvent(message) {
      if (!selection?.ready || !access.isActive(selection.ws)) return;
      if (message.type === 'fleet') send(selection.ws, message);
      else if (message.instanceId === selection.id) send(selection.ws, message.type === 'subagent-output' ? { ...message } : { ...message, viewId: selection.viewId });
    },
  });
  let initial;
  try { initial = await fleet.create('Haze 1', projects[0].id, true, true); primaryId = lastSelectedId = initial.id; }
  catch (error) { await fleet.close(); server.close(); wss.close(); access.dispose(); throw error; }
  const lifecycle = setInterval(() => access.tick(), 250);
  const heartbeat = setInterval(() => {
    const active = access.active(); if (!active) return;
    if (!alive) { active.terminate(); return; } alive = false; active.ping();
  }, 15_000);
  lifecycle.unref(); heartbeat.unref();
  let closing: Promise<void> | undefined;
  function close() {
    if (closing) return closing;
    stopped = true; modelDownload?.controller.abort(); speech.close(); for (const job of speechJobs.values()) job.controller.abort(); speechJobs.clear(); clearInterval(heartbeat); clearInterval(lifecycle); access.dispose();
    for (const ws of wss.clients) ws.terminate(); wss.close();
    closing = (async () => {
      const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections();
      await fleet.close(); await closed;
    })();
    return closing;
  }
  return { port, pid: initial.pid, instanceId: initial.id, close, exited: fleet.exited(initial.id),
    local: { pin: () => access.gate.localPin(), confirm: (code: string) => access.confirm(code), approve: (id: string) => access.approve(id), reject: () => access.reject(), pair: () => access.openPairing(), revoke: () => access.revoke() } };
}
