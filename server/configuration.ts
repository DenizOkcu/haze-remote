import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Configuration, EditableSettings, ProviderInfo } from '../shared/configuration.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const namePattern = /^[^\x00-\x1f\x7f]{1,80}$/;
const modelPattern = /^[^\x00-\x1f\x7f]{1,200}$/;
const numeric = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
function httpUrl(value: string) {
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password; }
  catch { return false; }
}
function sanitizeSettings(value: Record<string, unknown>): EditableSettings {
  const out: Record<string, unknown> = {};
  const enums: [keyof EditableSettings, string[]][] = [
    ['reasoning', ['minimal', 'low', 'medium', 'high', 'xhigh', 'provider-default']],
    ['steeringProfile', ['standard', 'compact']], ['manualCompaction', ['llm-summary', 'heuristic']],
  ];
  for (const [key, allowed] of enums) if (typeof value[key] === 'string' && allowed.includes(value[key] as string)) out[key] = value[key];
  if (typeof value.theme === 'string' && namePattern.test(value.theme)) out.theme = value.theme;
  if (typeof value.escalationModel === 'string' && /^[^\s:]+:.+$/.test(value.escalationModel) && value.escalationModel.length <= 240) out.escalationModel = value.escalationModel;
  if (typeof value.workerModel === 'string' && modelPattern.test(value.workerModel)) out.workerModel = value.workerModel;
  if (typeof value.defaultProfile === 'string' && namePattern.test(value.defaultProfile)) out.defaultProfile = value.defaultProfile;
  for (const key of ['modelRetries', 'retryBaseDelayMs', 'contextWindowFallbackTokens', 'localContextWindowFallbackTokens'] as const)
    if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0 && (key !== 'modelRetries' || (value[key] as number) <= 10)) out[key] = value[key];
  if (value.tips && typeof value.tips === 'object' && typeof (value.tips as { enabled?: unknown }).enabled === 'boolean') out.tipsEnabled = (value.tips as { enabled: boolean }).enabled;
  if (typeof value.tipsEnabled === 'boolean') out.tipsEnabled = value.tipsEnabled;
  const subagents = value.subagents as { workerModel?: unknown; defaultProfile?: unknown } | undefined;
  if (subagents && typeof subagents.workerModel === 'string' && modelPattern.test(subagents.workerModel)) out.workerModel = subagents.workerModel;
  if (subagents && typeof subagents.defaultProfile === 'string' && namePattern.test(subagents.defaultProfile)) out.defaultProfile = subagents.defaultProfile;
  return out as EditableSettings;
}
// Reads Haze's private settings.json only to serve stripped provider/config data
// over the approved encrypted channel. Keys never leave this process unhashed.
export class ConfigurationManager {
  private path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(home = homedir()) { this.path = join(home, '.haze', 'settings.json'); }
  private async read(): Promise<{ raw: Record<string, unknown>; revision: string }> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); } catch { text = '{}'; }
    const raw = JSON.parse(text) as Record<string, unknown>;
    return { raw, revision: hash(text) };
  }
  private async write(raw: Record<string, unknown>, previous: string) {
    const text = JSON.stringify(raw, null, 2) + '\n';
    const temp = join(dirname(this.path), `.remote-${randomUUID()}`);
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(text, 'utf8'); await file.close(); }
    catch (error) { await file.close(); await unlink(temp).catch(() => {}); throw error; }
    const current = await this.read();
    if (current.revision !== previous && previous !== '') {
      await unlink(temp).catch(() => {});
      throw new Error('Configuration changed on your computer. Reload it and reapply your changes.');
    }
    await stat(this.path).catch(() => null);
    await rename(temp, this.path);
  }
  private view(raw: Record<string, unknown>, revision: string): Configuration {
    const providers: ProviderInfo[] = [];
    for (const entry of Array.isArray(raw.providers) ? raw.providers as Record<string, unknown>[] : []) {
      if (typeof entry.name !== 'string' || typeof entry.url !== 'string') continue;
      const models = [] as ProviderInfo['models'];
      for (const model of Array.isArray(entry.models) ? entry.models as unknown[] : []) {
        if (typeof model !== 'string' || !modelPattern.test(model)) continue;
        const limits = (raw.modelLimits as Record<string, Record<string, unknown>> | undefined)?.[model] ?? (entry.modelLimits as Record<string, Record<string, unknown>> | undefined)?.[model];
        models.push({ id: model,
          ...(numeric(limits?.contextWindowTokens) ? { contextWindowTokens: limits!.contextWindowTokens as number } : {}),
          ...(numeric(limits?.maxOutputTokens) ? { maxOutputTokens: limits!.maxOutputTokens as number } : {}) });
      }
      providers.push({ name: entry.name, url: entry.url, kind: entry.kind === 'chatgpt-codex' ? 'chatgpt-codex' : 'openai-compatible',
        hasKey: typeof entry.key === 'string' && entry.key.length > 0, models,
        ...(entry.capabilities && typeof entry.capabilities === 'object' ? {
          ...(typeof (entry.capabilities as { images?: unknown }).images === 'boolean' ? { images: (entry.capabilities as { images: boolean }).images } : {}),
          ...(typeof (entry.capabilities as { reasoningEffort?: unknown }).reasoningEffort === 'boolean' ? { reasoningEffort: (entry.capabilities as { reasoningEffort: boolean }).reasoningEffort } : {}),
        } : {}) });
    }
    return { revision, providers,
      ...(typeof raw.provider === 'string' && providers.some(provider => provider.name === raw.provider) ? { provider: raw.provider } : {}),
      ...(typeof raw.model === 'string' && modelPattern.test(raw.model) ? { model: raw.model } : {}),
      settings: sanitizeSettings(raw) };
  }
  async readView(): Promise<Configuration> { const { raw, revision } = await this.read(); return this.view(raw, revision); }
  execute(command: import('../shared/configuration.js').ConfigurationCommand, authorized: () => boolean) {
    const result = this.queue.then(async () => {
      if (!authorized()) throw new Error('Connection is no longer approved.');
      const { raw, revision } = await this.read();
      if (command.type !== 'configuration-read' && command.revision !== revision) throw new Error('Configuration changed on your computer. Reload it and reapply your changes.');
      const providers = () => Array.isArray(raw.providers) ? raw.providers as Record<string, unknown>[] : [];
      if (command.type === 'provider-save') {
        const { provider, key, clearKey, originalName } = command;
        if (!namePattern.test(provider.name) || !httpUrl(provider.url)) throw new Error('Invalid provider name or base URL.');
        if (provider.models.length < 1 || provider.models.length > 100 || provider.models.some(model => !modelPattern.test(model.id))
          || new Set(provider.models.map(model => model.id)).size !== provider.models.length
          || provider.models.some(model => (model.contextWindowTokens !== undefined && !numeric(model.contextWindowTokens)) || (model.maxOutputTokens !== undefined && !numeric(model.maxOutputTokens))))
          throw new Error('Models need unique IDs and positive whole-number limits.');
        if (providers().some(entry => entry.name === provider.name && entry.name !== originalName)) throw new Error('A provider with this name already exists.');
        const index = originalName === undefined ? -1 : providers().findIndex(entry => entry.name === originalName);
        if (originalName !== undefined && index === -1) throw new Error('The edited provider no longer exists. Reload configuration.');
        const existing = index >= 0 ? providers()[index] : undefined;
        const modelLimits: Record<string, { contextWindowTokens?: number; maxOutputTokens?: number }> = {};
        for (const model of provider.models) {
          if (model.contextWindowTokens === undefined && model.maxOutputTokens === undefined) continue;
          modelLimits[model.id] = { ...(model.contextWindowTokens !== undefined ? { contextWindowTokens: model.contextWindowTokens } : {}), ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}) };
        }
        const entry: Record<string, unknown> = { name: provider.name, url: provider.url, kind: provider.kind,
          models: provider.models.map(model => model.id),
          ...(existing?.key !== undefined || key !== undefined ? {} : {}),
          ...(Object.keys(modelLimits).length ? { modelLimits } : {}),
          ...(provider.kind === 'openai-compatible' && (provider.images !== undefined || provider.reasoningEffort !== undefined) ? {
            capabilities: { ...(existing?.capabilities && typeof existing.capabilities === 'object' ? existing.capabilities as Record<string, unknown> : {}),
              ...(provider.images !== undefined ? { images: provider.images } : {}), ...(provider.reasoningEffort !== undefined ? { reasoningEffort: provider.reasoningEffort } : {}) } } : {}) };
        if (provider.kind === 'chatgpt-codex') { if (existing?.key !== undefined && !clearKey) entry.key = existing.key; }
        else if (clearKey) { /* dropped */ }
        else if (typeof key === 'string' && key.length > 0 && key.length <= 4096) entry.key = key;
        else if (existing?.key !== undefined) entry.key = existing.key;
        const list = providers();
        if (index >= 0) list[index] = entry; else list.push(entry);
        raw.providers = list;
        if (originalName !== undefined && originalName !== provider.name && raw.provider === originalName) raw.provider = provider.name;
        await this.write(raw, revision);
        return this.readView();
      }
      if (command.type === 'provider-remove') {
        if (!namePattern.test(command.name)) throw new Error('Invalid provider name.');
        const list = providers().filter(entry => entry.name !== command.name);
        if (list.length === providers().length) throw new Error('Provider not found. Reload configuration.');
        raw.providers = list;
        if (raw.provider === command.name) { delete raw.provider; delete raw.model; }
        await this.write(raw, revision);
        return this.readView();
      }
      if (command.type === 'provider-default') {
        if (!namePattern.test(command.name) || !modelPattern.test(command.model)) throw new Error('Invalid default provider or model.');
        const provider = providers().find(entry => entry.name === command.name);
        if (!provider || !Array.isArray(provider.models) || !(provider.models as unknown[]).includes(command.model)) throw new Error('The default model is not offered by this provider.');
        raw.provider = command.name; raw.model = command.model;
        await this.write(raw, revision);
        return this.readView();
      }
      if (command.type === 'settings-save') {
        const patch = command.settings as Record<string, unknown>;
        // An explicit empty string means "unset": drop the override entirely.
        for (const key of ['modelRetries', 'retryBaseDelayMs', 'contextWindowFallbackTokens', 'localContextWindowFallbackTokens'])
          if (patch[key] !== undefined && (!Number.isSafeInteger(patch[key]) || (patch[key] as number) < 0 || (key === 'modelRetries' && (patch[key] as number) > 10) || (key === 'retryBaseDelayMs' && (patch[key] as number) < 250)))
            throw new Error(`Invalid value for ${key}.`);
        if (patch.escalationModel !== undefined && !/^[^\s:]+:.+$/.test(String(patch.escalationModel))) throw new Error('Escalation model must be provider:model.');
        const enumFields: [string, string[]][] = [['reasoning', ['minimal', 'low', 'medium', 'high', 'xhigh', 'provider-default']], ['steeringProfile', ['standard', 'compact']], ['manualCompaction', ['llm-summary', 'heuristic']]];
        for (const [key, allowed] of enumFields)
          if (patch[key] !== undefined && patch[key] !== '' && !allowed.includes(patch[key] as string)) throw new Error(`Invalid value for ${key}.`);
        const clean = sanitizeSettings(patch);
        for (const [key, value] of Object.entries(clean)) {
          if (key === 'tipsEnabled') { raw.tips = { ...((raw.tips && typeof raw.tips === 'object') ? raw.tips as Record<string, unknown> : {}), enabled: value }; continue; }
          if (key === 'workerModel' || key === 'defaultProfile') {
            const subagents = { ...((raw.subagents && typeof raw.subagents === 'object') ? raw.subagents as Record<string, unknown> : {}), [key]: value };
            raw.subagents = subagents; continue;
          }
          raw[key] = value;
        }
        // Empty-string selections mean "unset": drop the override entirely.
        for (const field of ['theme', 'reasoning', 'steeringProfile', 'manualCompaction', 'escalationModel', 'modelRetries', 'retryBaseDelayMs', 'contextWindowFallbackTokens', 'localContextWindowFallbackTokens'] as const)
          if (patch[field] === '') delete raw[field];
        await this.write(raw, revision);
        return this.readView();
      }
      return this.view(raw, revision);
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
