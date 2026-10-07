import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { MAX_INSTANCES, MAX_SUBAGENTS, validSessionId, type AgentInstance, type FleetProject, type FleetState, type WorkerState } from '../shared/fleet.js';
import { MAX_WORKER_OUTPUT_BYTES, type ObserverMessage, type WorkerOutput } from '../shared/observer.js';
import { hostObserver, observerEnvironment, type ObserverHost } from './haze-observer/host.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';

type TrackedWorker = WorkerState & { output: string; revision: number };
type Run = {
  info: AgentInstance; child: pty.IPty; term: headless.Terminal;
  serializer: serialize.SerializeAddon; colors: Map<number, string>;
  queuedBytes: number; exited: Promise<void>; resolveExit: () => void; stopping?: Promise<void>;
  host?: ObserverHost; workers: Map<string, TrackedWorker>; watched?: string;
};
export type FleetEvent =
  | { type: 'output'; instanceId: string; data: string }
  | { type: 'exit'; instanceId: string; exitCode: number; signal?: number }
  | { type: 'fleet'; fleet: FleetState }
  | ({ type: 'subagent-output' } & WorkerOutput);
export type FleetOptions = {
  executable: string; args: string[]; newArgs: string[]; projects: FleetProject[];
  env?: Record<string, string>;
  isViewed: (id: string) => boolean;
  onEvent: (message: FleetEvent) => void;
};
// Only the compiled preload can be --imported by the plain Node child.
async function resolvePreload(): Promise<string | undefined> {
  for (const candidate of [new URL('./haze-observer/preload.js', import.meta.url), new URL('dist/server/haze-observer/preload.js', pathToFileURL(process.cwd() + '/'))]) {
    try { const path = fileURLToPath(candidate); await access(path); return path; } catch { /* Next candidate. */ }
  }
  return undefined;
}
const now = () => new Date().toISOString();
const appendBounded = (current: string, text: string) => {
  const next = current + text;
  const bytes = Buffer.byteLength(next);
  return bytes <= MAX_WORKER_OUTPUT_BYTES ? { output: next, truncated: false } : { output: Buffer.from(next).subarray(bytes - MAX_WORKER_OUTPUT_BYTES).toString('utf8').replace(/^\ufffd/, ''), truncated: true };
};
export class FleetManager {
  private runs = new Map<string, Run>();
  private disposed = false;
  private lastPublished = 0;
  private preload?: Promise<string | undefined>;
  constructor(private readonly options: FleetOptions) {}
  get(id: string) { return this.runs.get(id)?.info; }
  first() { return this.runs.values().next().value?.info; }
  state(): FleetState {
    return { instances: [...this.runs.values()].map(run => ({ ...run.info,
        subagents: { ...run.info.subagents, updatedAt: undefined,
          workers: [...run.workers.values()].map(worker => ({ ...worker, output: undefined, revision: undefined, outputBytes: Buffer.byteLength(worker.output) })) } })),
      projects: this.options.projects.map(project => ({ ...project })), limit: MAX_INSTANCES };
  }
  private publish(force = true) {
    if (this.disposed || (!force && Date.now() - this.lastPublished < 1000)) return;
    this.lastPublished = Date.now(); this.options.onEvent({ type: 'fleet', fleet: this.state() });
  }
  private emitOutput(run: Run, worker: TrackedWorker) {
    if (run.watched !== worker.key) return;
    const message: WorkerOutput = { type: 'subagent-output', instanceId: run.info.id, workerKey: worker.key,
      revision: worker.revision, output: worker.output, result: worker.result ?? '', truncated: !!worker.truncated };
    this.options.onEvent(message);
  }
  private observe(message: ObserverMessage, run: Run) {
    const info = run.info;
    if (message.type === 'observer-status') {
      info.subagents = { ...info.subagents, status: message.status === 'ready' ? 'observing' : 'unsupported', message: message.message };
      this.publish(); return;
    }
    if (message.type === 'session') {
      info.subagents = { ...info.subagents, sessionId: message.sessionId, durable: message.durable, updatedAt: Date.now() };
      this.publish(); return;
    }
    let worker = run.workers.get(message.key);
    const at = (message as { at?: string }).at;
    if (message.type === 'worker-created') {
      if (run.workers.has(message.key)) return;
      worker = { key: message.key, id: message.id, scope: message.scope, sessionId: message.sessionId, mode: message.mode,
        state: 'queued', objective: message.objective, createdAt: message.at, updatedAt: message.at, output: '', revision: 0 };
      run.workers.set(message.key, worker);
      // Finished runs stay inspectable; drop only the oldest beyond the cap.
      while (run.workers.size > MAX_SUBAGENTS) {
        const oldest = [...run.workers.values()].filter(item => item.state === 'settled' || item.state === 'terminal')
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
        if (!oldest) break;
        run.workers.delete(oldest.key);
      }
      this.publish(); return;
    }
    if (!worker) return;
    worker.updatedAt = at ?? now();
    if (message.type === 'worker-state') {
      worker.state = message.state;
      if (message.execution) worker.execution = message.execution;
      if (message.termination) worker.termination = message.termination;
      if (Number.isFinite(message.queueMs)) worker.queueMs = message.queueMs;
      if (Number.isFinite(message.durationMs)) worker.durationMs = message.durationMs;
      this.publish();
    } else if (message.type === 'worker-text') {
      const appended = appendBounded(worker.output, message.text);
      worker.output = appended.output; worker.truncated = appended.truncated; worker.revision++;
      this.emitOutput(run, worker);
    } else if (message.type === 'worker-tool') {
      worker.output += message.phase === 'start' ? `\n[tool ${message.name}]\n` : `\n[/tool ${message.name}]\n`;
      const boundedTool = appendBounded(worker.output, '');
      worker.output = boundedTool.output; worker.truncated = worker.truncated || boundedTool.truncated; worker.revision++;
      this.emitOutput(run, worker);
    } else if (message.type === 'worker-result') {
      worker.result = message.result;
      if (message.termination) worker.termination = message.termination;
      worker.execution = message.execution;
      worker.revision++;
      this.emitOutput(run, worker);
      this.publish();
    }
  }
  async create(name: string, projectId: string, allowShared: boolean, initial = false, authorized: () => boolean = () => true, launch: { mode: 'fresh' | 'resume' | 'fork'; sessionId?: string } = { mode: 'fresh' }) {
    if (launch.mode !== 'fresh' && !validSessionId(launch.sessionId)) throw new Error('Invalid session id.');
    if (this.disposed || this.runs.size >= MAX_INSTANCES) throw new Error('Fleet limit reached. Close an exited tab before creating another instance.');
    const project = this.options.projects.find(project => project.id === projectId);
    if (!project || await realpath(project.cwd) !== project.cwd) throw new Error('The locally approved project directory is unavailable or changed.');
    // Recheck after the asynchronous directory validation.
    if (!authorized()) throw new Error('Controller authority ended before launch.');
    if (this.disposed || this.runs.size >= MAX_INSTANCES) throw new Error('Fleet limit reached.');
    if (!allowShared && [...this.runs.values()].some(run => run.info.cwd === project.cwd && run.info.state !== 'exited'))
      throw new Error('Another Haze instance uses this checkout. Choose another approved project/worktree, or explicitly allow shared files.');
    const term = new headless.Terminal({ cols: 100, rows: 30, scrollback: 2000, allowProposedApi: true });
    const serializer = new serialize.SerializeAddon(); term.loadAddon(serializer);
    const colors = new Map<number, string>();
    for (const id of [10, 11]) term.parser.registerOscHandler(id, data => {
      if (/^rgb:[a-f0-9]{2,4}\/[a-f0-9]{2,4}\/[a-f0-9]{2,4}$/i.test(data)) colors.set(id, `\x1b]${id};${data}\x07`);
      return false;
    });
    for (const id of [110, 111]) term.parser.registerOscHandler(id, () => { colors.delete(id - 100); return false; });
    this.preload ??= resolvePreload();
    const preload = await this.preload;
    const info: AgentInstance = { id: randomUUID(), name, projectId, cwd: project.cwd, pid: 0,
      createdAt: Date.now(), state: 'running', exit: null,
      subagents: { status: preload ? 'off' : 'unsupported', message: preload ? undefined : 'Subagent observation requires the compiled haze-remote preload.', workers: [] } };
    let host: ObserverHost | undefined;
    let child: pty.IPty;
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const run: Run = { info, child: undefined!, term, serializer, colors, queuedBytes: 0, exited, resolveExit, host: undefined, workers: new Map() };
    try {
      const env: Record<string, string> = { ...(this.options.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      if (preload) {
        host = hostObserver(message => { if (!this.disposed && this.runs.get(info.id)) this.observe(message, run); });
        run.host = host;
        await host.listening;
        Object.assign(env, observerEnvironment(host));
        // NODE_OPTIONS reaches both direct-node and shebang executables.
        env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--import ${JSON.stringify(preload)}`;
      }
      const args = initial ? this.options.args : [...this.options.newArgs];
      if (!initial && launch.mode !== 'fresh') {
        // Resume reattaches to the durable session file. Fork launches were
        // pre-created on disk by the server with a fresh id, so they also resume.
        args.push('--resume', launch.sessionId!);
      }
      child = pty.spawn(this.options.executable, args, {
        name: 'xterm-256color', cols: term.cols, rows: term.rows, cwd: project.cwd, env,
      });
      run.child = child;
    } catch { term.dispose(); host?.unsubscribe(); this.runs.delete(info.id); throw new Error('Could not start Haze in a PTY. Check the installed executable and project directory.'); }
    info.pid = child.pid;
    this.runs.set(info.id, run);
    if (host) this.observe({ type: 'observer-status', status: 'ready' }, run);
    term.onData(data => { if (!this.options.isViewed(info.id) && info.state === 'running' && !this.disposed) child.write(data); });
    child.onData(data => {
      if (this.disposed) return;
      info.lastActivity = Date.now(); run.queuedBytes += Buffer.byteLength(data);
      if (run.queuedBytes > 4 * 1024 * 1024) child.pause();
      term.write(data, () => {
        run.queuedBytes -= Buffer.byteLength(data);
        if (run.queuedBytes < 2 * 1024 * 1024 && info.state === 'running' && !this.disposed) child.resume();
        if (!this.disposed) { this.options.onEvent({ type: 'output', instanceId: info.id, data }); this.publish(false); }
      });
    });
    child.onExit(event => {
      info.state = 'exited'; info.exit = event;
      info.subagents = { ...info.subagents, status: info.subagents.status === 'unsupported' ? 'unsupported' : 'off', message: 'Haze exited; retained worker runs remain inspectable.' };
      resolveExit();
      term.write('', () => {
        if (!this.disposed) { this.options.onEvent({ type: 'exit', instanceId: info.id, ...event }); this.publish(); }
      });
    });
    this.publish(); return info;
  }
  async snapshot(id: string) {
    const run = this.runs.get(id); if (!run) throw new Error('Instance no longer exists.');
    await new Promise<void>(resolve => run.term.write('', resolve));
    if (!this.runs.has(id) || this.disposed) throw new Error('Instance no longer exists.');
    return { data: '\x1b]110\x07\x1b]111\x07' + [...run.colors.values()].join('') + run.serializer.serialize(),
      cols: run.term.cols, rows: run.term.rows, pid: run.info.pid, cwd: run.info.cwd, exit: run.info.exit };
  }
  input(id: string, data: string) {
    const run = this.runs.get(id); if (!run || run.info.state !== 'running') return false;
    run.child.write(data); return true;
  }
  resize(id: string, cols: number, rows: number) {
    const run = this.runs.get(id); if (!run || run.info.state !== 'running') return;
    if (run.term.cols !== cols || run.term.rows !== rows) { run.term.resize(cols, rows); run.child.resize(cols, rows); }
  }
  watch(id: string, workerKey: string) {
    const run = this.runs.get(id); if (!run) throw new Error('Instance no longer exists.');
    run.watched = workerKey;
    const worker = run.workers.get(workerKey);
    if (worker) this.emitOutput(run, worker);
  }
  unwatch(id: string) {
    const run = this.runs.get(id); if (!run) throw new Error('Instance no longer exists.');
    run.watched = undefined;
  }
  async stop(id: string) {
    const run = this.runs.get(id); if (!run) throw new Error('Instance no longer exists.');
    if (run.info.state === 'exited') return;
    if (run.stopping) return run.stopping;
    run.info.state = 'stopping'; this.publish();
    run.stopping = (async () => {
      run.child.kill('SIGTERM');
      const force = setTimeout(() => { if (!run.info.exit) run.child.kill('SIGKILL'); }, 2000);
      try { await run.exited; } finally { clearTimeout(force); }
    })();
    return run.stopping;
  }
  remove(id: string) {
    const run = this.runs.get(id); if (!run) throw new Error('Instance no longer exists.');
    if (run.info.state !== 'exited') throw new Error('Stop this instance before closing its tab.');
    if (this.runs.size === 1) throw new Error('Keep at least one tab. Start another instance first.');
    this.runs.delete(id); run.host?.unsubscribe(); run.term.dispose(); this.publish();
  }
  exited(id: string) { return this.runs.get(id)!.exited; }
  async close() {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([...this.runs.keys()].map(id => this.stop(id)));
    for (const run of this.runs.values()) { run.host?.unsubscribe(); run.term.dispose(); }
    this.runs.clear();
  }
}
