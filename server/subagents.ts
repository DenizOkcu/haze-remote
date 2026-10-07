import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_SUBAGENTS, validSessionId, type SubagentFeed, type WorkerState } from '../shared/fleet.js';

const POLL_BYTES = 256 * 1024;
const LINE_BYTES = 64 * 1024;
const modes = new Set(['inspect', 'research', 'implement', 'validate']);
const states = new Set(['queued', 'started', 'terminal', 'settled']);
const executions = new Set(['settled', 'quarantined']);
const terminations = new Set(['completed', 'no_output', 'step_limit', 'tool_limit', 'deadline_exceeded', 'cancelled', 'provider_error', 'policy_blocked']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));

/** Reads one explicitly linked session. Never discovers sessions or returns source text. */
export class SubagentReader {
  private readonly cwd: string;
  private readonly directories: string[];
  private readonly path: string;
  private offset = 0;
  private identity = '';
  private modified = 0;
  private header = false;
  private pending = Buffer.alloc(0);
  private skipping = false;
  private scope = 0;
  private workers = new Map<string, WorkerState>();
  private serial: Promise<unknown> = Promise.resolve();

  constructor(cwd: string, private readonly sessionId: string, home: string) {
    this.cwd = resolve(cwd);
    const root = resolve(home);
    const haze = join(root, '.haze');
    const sessions = join(haze, 'sessions');
    const project = join(sessions, createHash('sha256').update(this.cwd).digest('hex').slice(0, 16));
    this.directories = [root, haze, sessions, project];
    // An invalid ID is never used for I/O.
    this.path = validSessionId(sessionId) ? join(project, `${sessionId}.jsonl`) : '';
  }

  poll(): Promise<SubagentFeed> {
    const next = this.serial.then(() => this.read());
    this.serial = next.catch(() => undefined);
    return next;
  }

  private reset(): void {
    this.offset = 0;
    this.identity = '';
    this.modified = 0;
    this.header = false;
    this.pending = Buffer.alloc(0);
    this.skipping = false;
    this.scope = 0;
    this.workers.clear();
  }

  private feed(status: SubagentFeed['status'], message?: string): SubagentFeed {
    return { status, ...(validSessionId(this.sessionId) ? { sessionId: this.sessionId } : {}),
      ...(message ? { message } : {}), workers: [...this.workers.values()].map(worker => ({ ...worker })), updatedAt: Date.now() };
  }

  private async checkDirectories(): Promise<void> {
    for (const path of this.directories) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe');
    }
  }

  private async read(): Promise<SubagentFeed> {
    if (!validSessionId(this.sessionId)) return this.feed('error', 'Invalid session ID.');
    try {
      await this.checkDirectories();
      const before = await lstat(this.path);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('unsafe');
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        await this.checkDirectories();
        const after = await lstat(this.path);
        if (!stat.isFile() || after.isSymbolicLink() || stat.dev !== before.dev || stat.ino !== before.ino
          || stat.dev !== after.dev || stat.ino !== after.ino) throw new Error('unsafe');
        const identity = `${stat.dev}:${stat.ino}`;
        if (identity !== this.identity || stat.size < this.offset
          || (stat.size === this.offset && stat.mtimeMs !== this.modified)) this.reset();
        this.identity = identity;
        this.modified = stat.mtimeMs;
        const length = Math.min(POLL_BYTES, Math.max(0, stat.size - this.offset));
        if (length) {
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await file.read(buffer, 0, length, this.offset);
          this.offset += bytesRead;
          this.consume(buffer.subarray(0, bytesRead));
        }
        return this.feed(this.header && this.offset >= stat.size ? 'live' : 'loading');
      } finally { await file.close(); }
    } catch (error) {
      this.reset();
      if (object(error) && error.code === 'ENOENT') return this.feed('loading', 'Waiting for the linked session.');
      return this.feed('error', 'Unable to read the linked session.');
    }
  }

  private consume(buffer: Buffer): void {
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start);
      const end = newline < 0 ? buffer.length : newline;
      const part = buffer.subarray(start, end);
      if (!this.skipping) {
        if (this.pending.length + part.length > LINE_BYTES) {
          if (!this.header) throw new Error('header');
          this.pending = Buffer.alloc(0);
          this.skipping = true;
        } else this.pending = Buffer.concat([this.pending, part]);
      }
      if (newline < 0) break;
      if (!this.skipping) this.line(this.pending);
      this.pending = Buffer.alloc(0);
      this.skipping = false;
      start = newline + 1;
    }
  }

  private line(bytes: Buffer): void {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { if (!this.header) throw new Error('header'); else return; }
    if (!this.header) {
      if (!object(value) || value.type !== 'header' || value.id !== this.sessionId || value.cwd !== this.cwd) throw new Error('header');
      this.header = true;
      return;
    }
    if (!object(value) || value.type !== 'event') return;
    // Haze event records only; messages, tools, and arbitrary JSON are not events.
    if (value.name === 'goal_start') { this.scope++; return; }
    if (value.name === 'clear') { this.workers.clear(); this.scope++; return; }
    if (value.name !== 'subagent_state' || typeof value.text !== 'string' || value.text.length > LINE_BYTES) return;
    let state: unknown;
    try { state = JSON.parse(value.text); } catch { return; }
    if (!object(state) || state.type !== 'subagent_state' || !validSessionId(state.id) || !modes.has(String(state.mode)) || !states.has(String(state.state))
      || !Number.isInteger(state.running) || (state.running as number) < 0) return;
    if (typeof state.mode !== 'string' || typeof state.state !== 'string') return;
    if (state.execution !== undefined && (typeof state.execution !== 'string' || !executions.has(state.execution))) return;
    if (state.termination !== undefined && (typeof state.termination !== 'string' || !terminations.has(state.termination))) return;
    for (const field of ['queueMs', 'durationMs']) {
      if (state[field] !== undefined && (typeof state[field] !== 'number' || !Number.isFinite(state[field]) || (state[field] as number) < 0)) return;
    }
    const at = time(state.at) ? state.at : value.at;
    if (!time(at)) return;
    const key = `${this.scope}:${state.id}`;
    // Construct, rather than spread, to quarantine every non-allowlisted field.
    const worker: WorkerState = { key, id: state.id, scope: this.scope,
      mode: state.mode as WorkerState['mode'], state: state.state as WorkerState['state'], at };
    if (typeof state.execution === 'string') worker.execution = state.execution as WorkerState['execution'];
    if (typeof state.termination === 'string') worker.termination = state.termination as WorkerState['termination'];
    if (typeof state.queueMs === 'number') worker.queueMs = state.queueMs;
    if (typeof state.durationMs === 'number') worker.durationMs = state.durationMs;
    this.workers.delete(key);
    this.workers.set(key, worker);
    if (this.workers.size > MAX_SUBAGENTS) this.workers.delete(this.workers.keys().next().value!);
  }
}
