import { useEffect, useRef, useState } from 'react';
import type { Configuration, ConfigurationCommand, EditableSettings, ManagementCommand, ManagementResponse, ProviderInfo } from '../shared/configuration.js';
import './configuration.css';

export type ConfigurationTabsProps = {
  view: 'terminal' | 'skills' | 'providers' | 'settings'; connected: boolean;
  request: (command: ManagementCommand) => Promise<ManagementResponse>;
  onNativeProvider: () => void;
};
type ModelDraft = { id: string; context: string; output: string };
type ProviderDraft = { name: string; url: string; kind: ProviderInfo['kind']; images: boolean; reasoningEffort: boolean; models: ModelDraft[] };
type SettingsDraft = Record<keyof EditableSettings, string>;
const presets = {
  OpenAI: ['openai', 'https://api.openai.com/v1'], OpenRouter: ['openrouter', 'https://openrouter.ai/api/v1'],
  Ollama: ['ollama', 'http://localhost:11434/v1'], 'LM Studio': ['lm-studio', 'http://localhost:1234/v1'], Custom: ['', ''],
} as const;
const settingFields: { key: keyof EditableSettings; label: string; help: string; options?: string[]; numeric?: boolean; min?: number }[] = [
  { key: 'theme', label: 'Theme', help: 'Theme name used by the native terminal.' },
  { key: 'reasoning', label: 'Reasoning effort', help: 'Requested reasoning level for supported models.', options: ['minimal', 'low', 'medium', 'high', 'xhigh', 'provider-default'] },
  { key: 'steeringProfile', label: 'Steering profile', help: 'How instructions guide the conversation.', options: ['standard', 'compact'] },
  { key: 'manualCompaction', label: 'Manual compaction', help: 'How conversation history is compacted.', options: ['llm-summary', 'heuristic'] },
  { key: 'modelRetries', label: 'Model retries', help: 'Number of retry attempts.', numeric: true, min: 0 },
  { key: 'retryBaseDelayMs', label: 'Retry base delay (ms)', help: 'Initial delay between retries.', numeric: true, min: 0 },
  { key: 'contextWindowFallbackTokens', label: 'Context window fallback (tokens)', help: 'Fallback when the model context limit is unknown.', numeric: true, min: 1 },
  { key: 'localContextWindowFallbackTokens', label: 'Local context window fallback (tokens)', help: 'Fallback for local models.', numeric: true, min: 1 },
  { key: 'escalationModel', label: 'Escalation model', help: 'Model name to use for escalation.' },
  { key: 'tipsEnabled', label: 'Show tips', help: 'Enable helpful tips.', options: ['true', 'false'] },
  { key: 'workerModel', label: 'Worker model', help: 'Model name for delegated work.' },
  { key: 'defaultProfile', label: 'Default profile', help: 'Profile name for new sessions.' },
];
function settingsDraft(settings: EditableSettings): SettingsDraft {
  return Object.fromEntries(settingFields.map(({ key }) => [key, settings[key] === undefined ? '' : String(settings[key])])) as SettingsDraft;
}
function providerDraft(provider: ProviderInfo): ProviderDraft {
  return { name: provider.name, url: provider.url, kind: provider.kind, images: !!provider.images, reasoningEffort: !!provider.reasoningEffort,
    models: provider.models.map(model => ({ id: model.id, context: String(model.contextWindowTokens ?? ''), output: String(model.maxOutputTokens ?? '') })) };
}
function positiveInteger(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid-input');
  return number;
}

export function ConfigurationTabs({ view, connected, request, onNativeProvider }: ConfigurationTabsProps) {
  const [configuration, setConfiguration] = useState<Configuration>();
  const [draft, setDraft] = useState<ProviderDraft>();
  const [originalName, setOriginalName] = useState<string>();
  const [providerBaseline, setProviderBaseline] = useState('');
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [settings, setSettings] = useState<SettingsDraft>(() => settingsDraft({}));
  const [settingsBaseline, setSettingsBaseline] = useState('');
  const [defaultProvider, setDefaultProvider] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [preset, setPreset] = useState<keyof typeof presets>('OpenAI');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const loaded = useRef(false);
  const providerDirty = !!draft && (!originalName || JSON.stringify(draft) !== providerBaseline || !!key || clearKey);
  const settingsDirty = !!configuration && JSON.stringify(settings) !== settingsBaseline;
  const defaultDirty = !!configuration && (defaultProvider !== (configuration.provider ?? '') || defaultModel !== (configuration.model ?? ''));
  const dirty = providerDirty || settingsDirty || defaultDirty;
  const disabled = !connected || busy || !configuration;

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  function resetEditor() { setDraft(undefined); setOriginalName(undefined); setProviderBaseline(''); setKey(''); setClearKey(false); }
  function acceptRead(next: Configuration) {
    loaded.current = true; setConfiguration(next);
    const values = settingsDraft(next.settings);
    setSettings(values); setSettingsBaseline(JSON.stringify(values));
    setDefaultProvider(next.provider ?? ''); setDefaultModel(next.model ?? ''); resetEditor();
  }
  async function perform(command: ConfigurationCommand, accept: (next: Configuration) => void, success: string) {
    if (!connected || lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await requestRef.current(command);
      if (result.type !== 'configuration-result') throw new Error('unexpected-response');
      accept(result.configuration); setNotice(success);
    } catch (cause) {
      // Never echo server errors: they could contain submitted credentials.
      const message = cause instanceof Error ? cause.message : '';
      setError(/conflict|revision|changed/i.test(message)
        ? 'Configuration changed on your computer. Your drafts are preserved. Reload and discard drafts to use the latest version, then reapply your changes.'
        : 'Unable to complete this request. Check your connection and configuration, then try again. Your drafts are preserved (API keys must be re-entered).');
    } finally {
      if (command.type === 'provider-save') setKey('');
      lock.current = false; setBusy(false);
    }
  }
  useEffect(() => {
    if (connected && (view === 'providers' || view === 'settings') && !loaded.current) {
      void perform({ type: 'configuration-read' }, acceptRead, 'Configuration loaded.');
    }
    // Do not reload on reconnect after a successful read: preserve drafts and their revision.
  }, [connected, view]);
  function reload() {
    if (dirty && !window.confirm('Reload configuration and discard all unsaved provider, default model, and settings changes?')) return;
    void perform({ type: 'configuration-read' }, acceptRead, 'Configuration reloaded.');
  }
  function discardProvider() { return !providerDirty || window.confirm('Discard unsaved provider changes?'); }
  function openProvider(provider: ProviderInfo) {
    if (!discardProvider()) return;
    const next = providerDraft(provider);
    setDraft(next); setOriginalName(provider.name); setProviderBaseline(JSON.stringify(next)); setKey(''); setClearKey(false); setError(''); setNotice('');
  }
  function newProvider() {
    if (!discardProvider()) return;
    const [name, url] = presets[preset];
    setDraft({ name, url, kind: 'openai-compatible', images: false, reasoningEffort: false, models: [{ id: '', context: '', output: '' }] });
    setOriginalName(undefined); setProviderBaseline(''); setKey(''); setClearKey(false); setError(''); setNotice('');
  }
  function patchProvider(patch: Partial<ProviderDraft>) { setDraft(current => current && ({ ...current, ...patch })); }
  function patchModel(index: number, patch: Partial<ModelDraft>) {
    if (draft) patchProvider({ models: draft.models.map((model, i) => i === index ? { ...model, ...patch } : model) });
  }
  async function saveProvider() {
    if (!draft || !configuration || disabled) return;
    try {
      const models = draft.models.map(model => ({ id: model.id.trim(), contextWindowTokens: positiveInteger(model.context), maxOutputTokens: positiveInteger(model.output) }));
      if (!draft.name.trim() || !models.length || models.some(model => !model.id) || new Set(models.map(model => model.id)).size !== models.length) throw new Error('invalid-input');
      const url = new URL(draft.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid-input');
      await perform({ type: 'provider-save', revision: configuration.revision, originalName,
        provider: { name: draft.name.trim(), url: draft.url.trim(), kind: draft.kind, images: draft.images, reasoningEffort: draft.reasoningEffort, models },
        ...(clearKey ? { clearKey: true } : key ? { key } : {}) }, next => {
        setConfiguration(next);
        const saved = next.providers.find(provider => provider.name === draft.name.trim());
        if (saved) { const values = providerDraft(saved); setDraft(values); setOriginalName(saved.name); setProviderBaseline(JSON.stringify(values)); }
        setKey(''); setClearKey(false);
        if (!defaultDirty) { setDefaultProvider(next.provider ?? ''); setDefaultModel(next.model ?? ''); }
      }, 'Provider saved. Start a fresh Haze instance to use configuration changes.');
    } catch {
      setKey(''); setError('Enter a name, an HTTP(S) base URL without embedded credentials, and unique model IDs with positive whole-number limits.');
    }
  }
  function saveSettings() {
    if (!configuration || disabled) return;
    const values: Record<string, string | number | boolean> = {};
    for (const field of settingFields) {
      const value = settings[field.key].trim();
      if (!value) continue;
      if (field.numeric) {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < (field.min ?? 0)) { setError(`${field.label} must be a whole number of at least ${field.min ?? 0}.`); return; }
        values[field.key] = number;
      } else values[field.key] = field.key === 'tipsEnabled' ? value === 'true' : value;
    }
    void perform({ type: 'settings-save', revision: configuration.revision, settings: values as EditableSettings }, next => {
      setConfiguration(next); const values = settingsDraft(next.settings); setSettings(values); setSettingsBaseline(JSON.stringify(values));
    }, 'Settings saved. Start a fresh Haze instance to use configuration changes.');
  }
  function feedback() {
    return <>{!connected && <p className="notice">Disconnected. Reconnect to edit or save. Your drafts stay here.</p>}
      {busy && <p role="status">Working…</p>}{error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="configuration-success" role="status">{notice}</p>}</>;
  }
  const defaultModels = configuration?.providers.find(provider => provider.name === defaultProvider)?.models ?? [];
  return <>
    <section id="providers-panel" role="tabpanel" aria-labelledby="providers-tab" hidden={view !== 'providers'} className="configuration-panel" aria-busy={busy} tabIndex={0}>
      <header className="configuration-header"><div><h1>Providers</h1><p>Connect models on your computer. API keys are write-only and never stored in this browser.</p></div>
        <button disabled={!connected || busy} onClick={reload}>Reload configuration</button></header>
      {feedback()}
      <div className="configuration-layout"><aside className="configuration-card" aria-label="Provider list">
        <h2>Configured providers</h2>
        {!configuration?.providers.length && <p>No providers loaded yet.</p>}
        <ul className="configuration-list">{configuration?.providers.map(provider => <li key={provider.name}><button disabled={disabled} aria-pressed={originalName === provider.name} onClick={() => openProvider(provider)}>
          <strong>{provider.name}</strong><small>{provider.kind === 'chatgpt-codex' ? 'Native OAuth' : 'OpenAI compatible'} · {provider.models.length} models · {provider.hasKey ? 'Key configured' : 'No API key'}</small>
        </button></li>)}</ul>
        <label>New provider preset<select value={preset} disabled={disabled} onChange={event => setPreset(event.target.value as keyof typeof presets)}>{Object.keys(presets).map(name => <option key={name}>{name}</option>)}</select></label>
        <button className="primary" disabled={disabled} onClick={newProvider}>New provider</button>
        <h2>Native authentication</h2><p>Complete OAuth sign-in in Haze’s native provider picker. Tokens are not shown here.</p>
        <button disabled={!connected || busy} onClick={onNativeProvider}>Open native provider / OAuth picker</button>
      </aside><div className="configuration-card">
        {draft ? <form onSubmit={event => { event.preventDefault(); void saveProvider(); }} autoComplete="off">
          <div className="configuration-heading"><h2>{originalName ? 'Edit provider' : 'Create provider'}</h2><span>{providerDirty ? 'Unsaved changes' : 'Saved'}</span></div>
          <fieldset disabled={disabled}><legend>Connection</legend>
            <label>Provider name<input required value={draft.name} onChange={event => patchProvider({ name: event.target.value })} /></label>
            <label>Base URL<input required type="url" value={draft.url} placeholder="https://api.example.com/v1" onChange={event => patchProvider({ url: event.target.value })} /></label>
            <label>Provider kind<select value={draft.kind} onChange={event => { patchProvider({ kind: event.target.value as ProviderInfo['kind'] }); setKey(''); }}><option value="openai-compatible">OpenAI compatible</option><option value="chatgpt-codex">ChatGPT Codex (native OAuth)</option></select></label>
            <label>API key<input type="password" autoComplete="new-password" value={key} disabled={clearKey || draft.kind === 'chatgpt-codex'} onChange={event => setKey(event.target.value)} aria-describedby="configuration-key-help" /></label>
            <p id="configuration-key-help" className="fine-print">Leave blank to preserve the stored key. Keys are cleared from this form after each save attempt. Use the native picker for OAuth.</p>
            <label className="configuration-check"><input type="checkbox" checked={clearKey} onChange={event => { setClearKey(event.target.checked); setKey(''); }} />Clear stored API key on save</label>
          </fieldset>
          <fieldset disabled={disabled}><legend>Model capabilities</legend>
            <label className="configuration-check"><input type="checkbox" checked={draft.images} onChange={event => patchProvider({ images: event.target.checked })} />Supports images</label>
            <label className="configuration-check"><input type="checkbox" checked={draft.reasoningEffort} onChange={event => patchProvider({ reasoningEffort: event.target.checked })} />Supports reasoning effort</label>
          </fieldset>
          <fieldset disabled={disabled}><legend>Models</legend><p className="fine-print">Optional limits: leave blank to use defaults.</p>
            {draft.models.map((model, index) => <div className="configuration-model" key={index}>
              <label>Model ID {index + 1}<input required value={model.id} onChange={event => patchModel(index, { id: event.target.value })} /></label>
              <label>Context tokens {index + 1}<input type="number" min="1" step="1" value={model.context} onChange={event => patchModel(index, { context: event.target.value })} /></label>
              <label>Output tokens {index + 1}<input type="number" min="1" step="1" value={model.output} onChange={event => patchModel(index, { output: event.target.value })} /></label>
              <button type="button" aria-label={`Remove model ${index + 1}`} onClick={() => patchProvider({ models: draft.models.filter((_, i) => i !== index) })}>Remove</button>
            </div>)}
            <button type="button" onClick={() => patchProvider({ models: [...draft.models, { id: '', context: '', output: '' }] })}>Add model</button>
          </fieldset>
          <div className="configuration-actions"><button className="primary" type="submit" disabled={disabled || !providerDirty}>{busy ? 'Working…' : 'Save provider'}</button>
            <button type="button" disabled={disabled} onClick={() => { if (discardProvider()) resetEditor(); }}>Discard / close editor</button>
            {originalName && <button type="button" className="danger" disabled={disabled} onClick={() => {
              if (!window.confirm(`Remove provider “${originalName}”? Its stored key and models will be removed, and this provider draft will be discarded.`)) return;
              void perform({ type: 'provider-remove', revision: configuration!.revision, name: originalName }, next => {
                setConfiguration(next); resetEditor(); if (!defaultDirty || defaultProvider === originalName) { setDefaultProvider(next.provider ?? ''); setDefaultModel(next.model ?? ''); }
              }, 'Provider removed.');
            }}>Remove provider</button>}
          </div>
        </form> : <><h2>Provider editor</h2><p>Select a provider to edit, or choose a preset to add one. Local server URLs are reached from your computer, not this browser.</p></>}
      </div></div>
      <form className="configuration-card configuration-default" onSubmit={event => {
        event.preventDefault(); if (!configuration || disabled) return;
        void perform({ type: 'provider-default', revision: configuration.revision, name: defaultProvider, model: defaultModel }, next => {
          setConfiguration(next); setDefaultProvider(next.provider ?? ''); setDefaultModel(next.model ?? '');
        }, 'Default provider and model saved.');
      }}><h2>Default provider and model</h2><fieldset disabled={disabled}>
        <label>Default provider<select required value={defaultProvider} onChange={event => { setDefaultProvider(event.target.value); setDefaultModel(''); }}><option value="">Choose a provider</option>{configuration?.providers.map(provider => <option key={provider.name} value={provider.name}>{provider.name}</option>)}</select></label>
        <label>Default model<select required value={defaultModel} onChange={event => setDefaultModel(event.target.value)}><option value="">Choose a model</option>{defaultModels.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}</select></label>
        <button className="primary" disabled={!defaultDirty || !defaultProvider || !defaultModel}>Save default model</button>
      </fieldset></form>
    </section>
    <section id="settings-panel" role="tabpanel" aria-labelledby="settings-tab" hidden={view !== 'settings'} className="configuration-panel" aria-busy={busy} tabIndex={0}>
      <header className="configuration-header"><div><h1>Settings</h1><p>Preferences for Haze. Empty fields and “Use default” remove the override, allowing Haze’s defaults to apply.</p></div><button disabled={!connected || busy} onClick={reload}>Reload configuration</button></header>
      {feedback()}
      <form className="configuration-card" onSubmit={event => { event.preventDefault(); saveSettings(); }}>
        <div className="configuration-heading"><h2>Preferences</h2><span>{settingsDirty ? 'Unsaved changes' : 'Saved'}</span></div>
        <fieldset disabled={disabled} className="configuration-settings"><legend>Editable settings</legend>
          {settingFields.map(field => <label key={field.key}>{field.label}
            {field.options ? <select value={settings[field.key]} onChange={event => setSettings(current => ({ ...current, [field.key]: event.target.value }))}>
              <option value="">Use default (unset)</option>{field.options.map(value => <option key={value} value={value}>{value === 'true' ? 'Enabled' : value === 'false' ? 'Disabled' : value}</option>)}
            </select> : <input type={field.numeric ? 'number' : 'text'} min={field.min} step={field.numeric ? 1 : undefined} placeholder="Use default (unset)" value={settings[field.key]} onChange={event => setSettings(current => ({ ...current, [field.key]: event.target.value }))} />}
            <small>{field.help}</small>
          </label>)}
        </fieldset>
        <div className="configuration-actions"><button className="primary" disabled={disabled || !settingsDirty}>{busy ? 'Working…' : 'Save settings'}</button>
          <button type="button" disabled={disabled || !settingsDirty} onClick={() => { if (window.confirm('Discard unsaved settings changes?')) { const values = settingsDraft(configuration!.settings); setSettings(values); setSettingsBaseline(JSON.stringify(values)); setError(''); setNotice(''); } }}>Discard settings changes</button>
          <button type="button" disabled={disabled} onClick={() => { if (window.confirm('Unset all editable settings? Save settings to apply Haze defaults.')) setSettings(settingsDraft({})); }}>Use defaults for all</button>
        </div>
      </form>
    </section>
  </>;
}
