export const MAX_INSTANCES = 8;
export const MAX_SUBAGENTS = 100;
export type WorkerState = {
  key: string; id: string; scope: number;
  mode: 'inspect' | 'research' | 'implement' | 'validate';
  state: 'queued' | 'started' | 'terminal' | 'settled';
  execution?: 'settled' | 'quarantined';
  termination?: 'completed' | 'no_output' | 'step_limit' | 'tool_limit' | 'deadline_exceeded' | 'cancelled' | 'provider_error' | 'policy_blocked';
  queueMs?: number; durationMs?: number; at: string;
};
export type SubagentFeed = {
  status: 'unlinked' | 'loading' | 'live' | 'error' | 'stopped';
  sessionId?: string; message?: string; workers: WorkerState[]; updatedAt?: number;
};
export type FleetProject = { id: string; name: string; cwd: string };
export type AgentInstance = {
  id: string; name: string; projectId: string; cwd: string; pid: number;
  createdAt: number; lastActivity?: number;
  state: 'running' | 'stopping' | 'exited';
  exit: { exitCode: number; signal?: number } | null;
  subagents: SubagentFeed;
};
export type FleetState = { instances: AgentInstance[]; projects: FleetProject[]; limit: number };
export type FleetRequest =
  | { type: 'instance-create'; requestId: string; name: string; projectId: string; allowShared: boolean }
  | { type: 'instance-select'; requestId: string; instanceId: string }
  | { type: 'instance-stop' | 'instance-close' | 'subagents-unlink'; requestId: string; instanceId: string }
  | { type: 'subagents-link'; requestId: string; instanceId: string; sessionId: string };
export const validSessionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && value !== '.' && value !== '..';
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);
export function isFleetRequest(message: any): message is FleetRequest {
  if (!message || !id(message.requestId)) return false;
  if (message.type === 'instance-create') return id(message.projectId) && typeof message.name === 'string'
    && message.name.trim().length > 0 && message.name.length <= 80 && !/[\x00-\x1f\x7f]/.test(message.name) && typeof message.allowShared === 'boolean';
  if (!id(message.instanceId)) return false;
  if (message.type === 'subagents-link') return validSessionId(message.sessionId);
  return ['instance-select', 'instance-stop', 'instance-close', 'subagents-unlink'].includes(message.type);
}
