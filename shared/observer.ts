import type { WorkerState } from './fleet.js';

export const MAX_WORKER_OUTPUT_BYTES = 128 * 1024;
export const MAX_WORKER_RESULT_BYTES = 64 * 1024;
export const MAX_OBSERVER_FRAME_BYTES = 128 * 1024;
export type ObserverMessage =
  | { type: 'observer-status'; status: 'ready' | 'unsupported'; message?: string }
  | { type: 'session'; sessionId: string; durable: boolean }
  | { type: 'worker-created'; key: string; id: string; sessionId: string; scope: number; mode: WorkerState['mode']; objective?: string; at: string }
  | { type: 'worker-state'; key: string; state: WorkerState['state']; execution?: WorkerState['execution']; termination?: WorkerState['termination']; queueMs?: number; durationMs?: number; at: string }
  | { type: 'worker-text'; key: string; text: string; at?: string }
  | { type: 'worker-tool'; key: string; name: string; phase: 'start' | 'end'; at?: string }
  | { type: 'worker-result'; key: string; result: string; termination?: WorkerState['termination']; execution: 'settled' | 'quarantined'; at: string };
export type WorkerOutput = {
  type: 'subagent-output'; instanceId: string; workerKey: string;
  revision: number; output: string; result: string; truncated: boolean;
};
const key = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:-]{1,80}$/.test(value);
const at = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const mode = (value: unknown) => typeof value === 'string' && ['inspect', 'research', 'implement', 'validate'].includes(value);
const state = (value: unknown) => typeof value === 'string' && ['queued', 'started', 'terminal', 'settled'].includes(value);
const termination = (value: unknown) => value === undefined || (typeof value === 'string' && ['completed', 'no_output', 'step_limit', 'tool_limit', 'deadline_exceeded', 'cancelled', 'provider_error', 'policy_blocked'].includes(value));
const number = (value: unknown) => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
// Frames cross a process boundary; every field is revalidated before use.
export function isObserverMessage(value: any): value is ObserverMessage {
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'observer-status') return ['ready', 'unsupported'].includes(value.status)
    && (value.message === undefined || (typeof value.message === 'string' && value.message.length <= 300));
  if (value.type === 'session') return typeof value.sessionId === 'string' && value.sessionId.length <= 200 && typeof value.durable === 'boolean';
  if (!key(value.key) || !at(value.at)) return false;
  if (value.type === 'worker-created') return typeof value.id === 'string' && value.id.length <= 80 && typeof value.sessionId === 'string'
    && value.sessionId.length <= 200 && Number.isInteger(value.scope) && mode(value.mode)
    && (value.objective === undefined || typeof value.objective === 'string');
  if (value.type === 'worker-state') return state(value.state) && termination(value.termination) && number(value.queueMs) && number(value.durationMs)
    && (value.execution === undefined || ['settled', 'quarantined'].includes(value.execution));
  if (value.type === 'worker-text' || value.type === 'worker-tool') return value.type === 'worker-tool'
    ? typeof value.name === 'string' && value.name.length <= 200 && ['start', 'end'].includes(value.phase)
    : typeof value.text === 'string' && value.text.length <= MAX_WORKER_OUTPUT_BYTES;
  if (value.type === 'worker-result') return typeof value.result === 'string' && value.result.length <= MAX_WORKER_RESULT_BYTES
    && termination(value.termination) && ['settled', 'quarantined'].includes(value.execution);
  return false;
}
