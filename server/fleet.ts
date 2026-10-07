import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { MAX_INSTANCES, type AgentInstance, type FleetProject, type FleetState } from '../shared/fleet.js';
import { SubagentReader } from './subagents.js';

type Run = {
  info: AgentInstance; child: pty.IPty; term: headless.Terminal;
  serializer: serialize.SerializeAddon; colors: Map<number, string>;
  queuedBytes: number; exited: Promise<void>; resolveExit: () => void;
  reader?: SubagentReader; polling: boolean; stopping?: Promise<void>;
};
export type FleetOptions = {
  executable: string; args: string[]; newArgs: string[]; projects: FleetProject[];
  env?: Record<string, string>;
  isViewed: (id: string) => boolean;
  onEvent: (message: { type: 'output'; instanceId: string; data: string } | { type: 'exit'; instanceId: string; exitCode: number; signal?: number } | { type: 'fleet'; fleet: FleetState }) => void;
};
export class FleetManager {
  private runs = new Map<string, Run>();
  private disposed = false;
  private lastPublished = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: FleetOptions) {
    this.timer = setInterval(() => { void this.pollSubagents(); }, 1000);
    this.timer.unref();
  }
  get(id: string) { return this.runs.get(id)?.info; }
  first() { return this.runs.values().next().value?.info; }
  state(): FleetState {
    return { instances: [...this.runs.values()].map(run => ({ ...run.info, subagents: { ...run.info.subagents, workers: run.info.subagents.workers.map(worker => ({ ...worker })) } })),
      projects: this.options.projects.map(project => ({ ...project })), limit: MAX_INSTANCES };
  }
  private publish(force = true) {
    if (this.disposed || (!force && Date.now() - this.lastPublished < 1000)) return;
    this.lastPublished = Date.now(); this.options.onEvent({ type: 'fleet', fleet: this.state() });
  }
  async create(name: string, projectId: string, allowShared: boolean, initial = false, authorized: () => boolean = () => true) {
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
    let child: pty.IPty;
    try {
      child = pty.spawn(this.options.executable, initial ? this.options.args : this.options.newArgs, {
        name: 'xterm-256color', cols: term.cols, rows: term.rows, cwd: project.cwd,
        env: { ...(this.options.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch { term.dispose(); throw new Error('Could not start Haze in a PTY. Check the installed executable and project directory.'); }
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const info: AgentInstance = { id: randomUUID(), name, projectId, cwd: project.cwd, pid: child.pid,
      createdAt: Date.now(), state: 'running', exit: null, subagents: { status: 'unlinked', workers: [] } };
    const run: Run = { info, child, term, serializer, colors, queuedBytes: 0, exited, resolveExit, polling: false };
    this.runs.set(info.id, run);
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
      info.subagents = { ...info.subagents, status: run.reader ? 'stopped' : 'unlinked' };
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
    this.runs.delete(id); run.reader = undefined; run.term.dispose(); this.publish();
  }
  exited(id: string) { return this.runs.get(id)!.exited; }
  async link(id: string, sessionId: string) {
    const run = this.runs.get(id); if (!run || run.info.state !== 'running') throw new Error('Select a running instance to link its session.');
    if ([...this.runs.values()].some(other => other !== run && other.info.subagents.sessionId === sessionId && other.info.cwd === run.info.cwd))
      throw new Error('That session is already linked to another instance.');
    const reader = new SubagentReader(run.info.cwd, sessionId, this.options.env?.HOME ?? homedir());
    run.reader = reader; run.info.subagents = { status: 'loading', sessionId, workers: [] }; this.publish();
    const feed = await reader.poll();
    if (run.reader === reader && run.info.state === 'running' && !this.disposed) { run.info.subagents = feed; this.publish(); }
  }
  unlink(id: string) {
    const run = this.runs.get(id); if (!run) throw new Error('Instance no longer exists.');
    run.reader = undefined; run.info.subagents = { status: 'unlinked', workers: [] }; this.publish();
  }
  private async pollSubagents() {
    for (const run of this.runs.values()) {
      const reader = run.reader;
      if (!reader || run.polling || run.info.state !== 'running' || this.disposed) continue;
      run.polling = true;
      void reader.poll().then(feed => {
        if (run.reader !== reader || this.disposed || !this.runs.has(run.info.id) || run.info.state !== 'running') return;
        const old = run.info.subagents;
        if (JSON.stringify({ ...old, updatedAt: 0 }) !== JSON.stringify({ ...feed, updatedAt: 0 })) { run.info.subagents = feed; this.publish(); }
      }).finally(() => { run.polling = false; });
    }
  }
  async close() {
    if (this.disposed) return;
    this.disposed = true; clearInterval(this.timer);
    await Promise.all([...this.runs.keys()].map(id => this.stop(id)));
    for (const run of this.runs.values()) { run.reader = undefined; run.term.dispose(); }
    this.runs.clear();
  }
}
