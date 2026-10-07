import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { validSessionId, type WorkerState } from '../../shared/fleet.js';
import { MAX_WORKER_OUTPUT_BYTES, MAX_WORKER_RESULT_BYTES, type ObserverMessage } from '../../shared/observer.js';

type Owner = { sessionId: string; key?: string; id?: string; scope?: number; mode?: WorkerState['mode']; objective?: string; ended?: boolean; bytes?: number; execution?: 'settled' | 'quarantined' };
const modes = new Set(['inspect', 'research', 'implement', 'validate']);
const terminations = new Set(['completed', 'no_output', 'step_limit', 'tool_limit', 'deadline_exceeded', 'cancelled', 'provider_error', 'policy_blocked']);
const bounded = (text: string, bytes: number) => { let value = Buffer.from(text).subarray(0, bytes).toString('utf8'); if (value.endsWith('\ufffd')) value = value.slice(0, -1); return value; };

/** Private adapter for the ordinary (non-#private) 1.5.0 coordinator fields. */
export class HazeObserver {
  private sessions = new WeakMap<object, string>();
  private contexts = new AsyncLocalStorage<Owner>();
  private coordinators = new WeakMap<object, { scope: number; workers: Map<string, Owner> }>();
  private scope = 0;
  private serial = 0;
  private nonce = randomUUID();
  constructor(private readonly emit: (message: ObserverMessage) => void) {}
  private send(message: ObserverMessage) { try { this.emit(message); } catch { /* Observation never breaks Haze. */ } }
  bindSession<T extends object>(promptObject: T, durableId: unknown): T {
    let id = this.sessions.get(promptObject);
    if (validSessionId(durableId)) id = durableId;
    if (!id) id = `ephemeral-${randomUUID()}`;
    if (this.sessions.get(promptObject) !== id) {
      this.sessions.set(promptObject, id);
      this.send({ type: 'session', sessionId: id, durable: validSessionId(durableId) });
    }
    return promptObject;
  }
  wrapTool<T extends { execute?: (...args: any[]) => any }>(options: any, coordinator: any, tool: T): T {
    this.install(coordinator);
    if (typeof tool.execute !== 'function') return tool;
    const execute = tool.execute;
    const observer = this;
    return { ...tool, execute: function (this: unknown, input: any, ...rest: any[]) {
      const sessionId = options.session && observer.sessions.get(options.session);
      if (!sessionId) return execute.call(this, input, ...rest);
      const owner: Owner = { sessionId, mode: modes.has(options.forceMode ?? input?.mode) ? options.forceMode ?? input.mode : undefined,
        objective: typeof input?.objective === 'string' ? bounded(input.objective, 4000) : undefined };
      return observer.contexts.run(owner, async () => {
        const result = await execute.call(this, input, ...rest);
        if (owner.key) {
          // Policy-blocked invocations never enter submit, but their real capsule is authoritative.
          if (!owner.ended) observer.state(owner, 'terminal', 'settled');
          observer.result(owner, result);
          if (owner.execution !== 'quarantined' && owner.id) observer.coordinators.get(coordinator)?.workers.delete(owner.id);
        }
        return result;
      });
    } } as T;
  }
  private state(owner: Owner, state: WorkerState['state'], execution?: 'settled' | 'quarantined', event: any = {}) {
    if (!owner.key) return;
    if (state === 'terminal') { owner.ended = true; owner.execution = execution; }
    this.send({ type: 'worker-state', key: owner.key, state, ...(execution ? {execution} : {}),
      ...(terminations.has(event.termination) ? {termination: event.termination} : {}),
      ...(Number.isFinite(event.queueMs) ? {queueMs: event.queueMs} : {}), ...(Number.isFinite(event.durationMs) ? {durationMs: event.durationMs} : {}), at: new Date().toISOString() });
  }
  private result(owner: Owner, value: any) {
    const capsule = value?.capsule;
    if (!owner.key || typeof capsule?.deliverable !== 'string') return;
    this.send({ type: 'worker-result', key: owner.key, result: bounded(capsule.deliverable, MAX_WORKER_RESULT_BYTES),
      ...(terminations.has(capsule.termination) ? {termination: capsule.termination} : {}), execution: owner.execution ?? 'settled', at: new Date().toISOString() });
  }
  private install(coordinator: any) {
    if (!coordinator || this.coordinators.has(coordinator) || typeof coordinator.createId !== 'function' || typeof coordinator.submit !== 'function') return;
    const record = { scope: ++this.scope, workers: new Map<string, Owner>() };
    this.coordinators.set(coordinator, record);
    const observer = this, createId = coordinator.createId, submit = coordinator.submit, onEvent = coordinator.onEvent;
    coordinator.createId = function (...args: any[]) {
      const id = createId.apply(this, args), owner = observer.contexts.getStore();
      if (owner && typeof id === 'string' && owner.mode) {
        owner.id = id; owner.scope = record.scope; owner.key = `${observer.nonce}:${record.scope}:${++observer.serial}`;
        record.workers.set(id, owner);
        observer.send({type: 'worker-created', key: owner.key, id, scope: record.scope, sessionId: owner.sessionId, mode: owner.mode, objective: owner.objective, at: new Date().toISOString()});
      }
      return id;
    };
    coordinator.onEvent = function (event: any) {
      const owner = record.workers.get(event.id);
      if (owner && ['queued', 'started', 'terminal', 'settled'].includes(event.type)) {
        observer.state(owner, event.type, event.type === 'settled' ? 'settled' : event.execution, event);
        if (event.type === 'settled' || (event.type === 'terminal' && event.execution === 'settled')) record.workers.delete(event.id);
      }
      return onEvent?.call(this, event);
    };
    coordinator.submit = function (request: any) {
      // Capture before admission: a queue drained by another worker inherits the wrong ALS otherwise.
      const owner = observer.contexts.getStore();
      if (!owner?.key) return submit.call(this, request);
      const run = request.run;
      return submit.call(this, {...request, run: function (this: unknown, ...args: any[]) {
        return observer.contexts.run(owner, () => run.apply(this, args));
      }});
    };
  }
  streamOptions<T extends Record<string, any>>(original: T): T {
    const owner = this.contexts.getStore();
    if (!owner?.key) return original;
    const observer = this;
    const wrap = (name: string, capture: (event: any) => void) => function (this: unknown, event: any, ...args: any[]) {
      if (!owner.ended) capture(event);
      return original[name]?.call(this, event, ...args);
    };
    return { ...original,
      onChunk: wrap('onChunk', event => {
        if (event?.chunk?.type !== 'text-delta' || typeof event.chunk.text !== 'string') return;
        const text = bounded(event.chunk.text, Math.max(0, MAX_WORKER_OUTPUT_BYTES - (owner.bytes ?? 0)));
        owner.bytes = (owner.bytes ?? 0) + Buffer.byteLength(text);
        if (text) observer.send({type: 'worker-text', key: owner.key!, text, at: new Date().toISOString()});
      }),
      onToolExecutionStart: wrap('onToolExecutionStart', event => observer.tool(owner, event, 'start')),
      onToolExecutionEnd: wrap('onToolExecutionEnd', event => observer.tool(owner, event, 'end')),
    };
  }
  private tool(owner: Owner, event: any, phase: 'start' | 'end') {
    if (typeof event?.toolCall?.toolName === 'string') this.send({type: 'worker-tool', key: owner.key!, name: bounded(event.toolCall.toolName, 200), phase, at: new Date().toISOString()});
  }
}
