export type ProviderModel = { id: string; contextWindowTokens?: number; maxOutputTokens?: number };
export type ProviderInfo = { name: string; url: string; kind: 'openai-compatible' | 'chatgpt-codex'; hasKey: boolean; models: ProviderModel[]; images?: boolean; reasoningEffort?: boolean };
export type EditableSettings = {
  theme?: string; reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'provider-default';
  steeringProfile?: 'standard' | 'compact'; manualCompaction?: 'llm-summary' | 'heuristic';
  modelRetries?: number; retryBaseDelayMs?: number; contextWindowFallbackTokens?: number; localContextWindowFallbackTokens?: number;
  escalationModel?: string; tipsEnabled?: boolean; workerModel?: string; defaultProfile?: string;
};
export type Configuration = { revision: string; providers: ProviderInfo[]; provider?: string; model?: string; settings: EditableSettings };
export type ConfigurationCommand =
  | { type: 'configuration-read' }
  | { type: 'provider-save'; revision: string; originalName?: string; provider: Omit<ProviderInfo, 'hasKey'>; key?: string; clearKey?: boolean }
  | { type: 'provider-remove'; revision: string; name: string }
  | { type: 'provider-default'; revision: string; name: string; model: string }
  | { type: 'settings-save'; revision: string; settings: EditableSettings };
export type ConfigurationResponse = { type: 'configuration-result'; requestId: string; configuration: Configuration };
export type SessionInfo = { id: string; projectId: string; cwd: string; createdAt: string; updatedAt: string; sizeBytes: number; forkedFrom?: string };
export type SessionsCommand = { type: 'sessions-list'; projectId: string };
export type SessionsResponse = { type: 'sessions-result'; requestId: string; sessions: SessionInfo[]; warnings: string[]; canFork: boolean };
export type ManagementCommand = ConfigurationCommand | SessionsCommand;
export type ManagementResponse = ConfigurationResponse | SessionsResponse;
export type ManagementRequest = ManagementCommand & { requestId: string };
export function isManagementRequest(value: any): value is ManagementRequest {
  if (!value || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value.requestId)) return false;
  if (value.type === 'configuration-read') return true;
  if (value.type === 'sessions-list') return typeof value.projectId === 'string' && /^project-\d+$/.test(value.projectId);
  return ['provider-save', 'provider-remove', 'provider-default', 'settings-save'].includes(value.type)
    && typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision);
}
