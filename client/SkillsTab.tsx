import { useEffect, useState } from 'react';
import { MAX_SKILL_BYTES, type SkillCatalog, type SkillDocument, type SkillRequest, type SkillResponse } from '../shared/skills.js';

export type SkillCommand = SkillRequest extends infer R ? R extends SkillRequest ? Omit<R, 'requestId'> : never : never;
const template = (name: string) => `---\nname: ${name || 'my-skill'}\ndescription: Describe when Haze should use this workflow.\n---\n\n# Role\n\nYou are a focused assistant.\n\n# Procedure\n\n1. Inspect the relevant context.\n2. Complete the requested workflow.\n3. Verify the result.\n\n# Output template\n\n## Summary\n\n## Results\n\n## Verification\n`;
export function SkillsTab({ active, connected, projectId, request, onManage }: {
  active: boolean; connected: boolean; projectId?: string;
  request: (command: SkillCommand) => Promise<SkillResponse & { type: 'skills-result' }>;
  onManage: () => void;
}) {
  const [catalog, setCatalog] = useState<SkillCatalog>();
  const [document, setDocument] = useState<SkillDocument>();
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [directory, setDirectory] = useState('');
  const [scope, setScope] = useState('global');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = creating || (!!document && draft !== document.content);
  useEffect(() => {
    if (!active || !connected) return;
    let cancelled = false;
    setBusy(true); setError('');
    void request({ type: 'skills-list' }).then(result => { if (!cancelled) setCatalog(result.catalog); })
      .catch(error => { if (!cancelled) setError(error.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [active, connected, request]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  const discard = () => !dirty || window.confirm('Discard unsaved skill changes?');
  async function refresh() {
    setBusy(true); setError('');
    try { setCatalog((await request({ type: 'skills-list' })).catalog); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function open(id: string) {
    if (!discard()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request({ type: 'skill-read', skillId: id });
      setDocument(result.document); setDraft(result.document!.content); setCreating(false);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  function create() {
    if (!discard()) return;
    setDocument(undefined); setCreating(true); setDirectory(''); setScope(projectId ?? 'global');
    setDraft(template('')); setError(''); setNotice('');
  }
  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      if (new TextEncoder().encode(draft).length > MAX_SKILL_BYTES) throw new Error('Skill content must be at most 256 KiB.');
      const result = await request(creating
        ? { type: 'skill-create', scopeId: scope, directory, content: draft }
        : { type: 'skill-save', skillId: document!.id, revision: document!.revision, content: draft });
      setDocument(result.document); setDraft(result.document!.content); setCreating(false);
      setNotice('Saved to SKILL.md on your computer. Start a fresh Haze instance to load changes into its skill catalog.');
      setCatalog((await request({ type: 'skills-list' })).catalog);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  const skills = catalog?.skills.filter(skill => (filter === 'all' || skill.scopeId === filter)
    && `${skill.name} ${skill.description} ${skill.directory}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <section id="skills-panel" role="tabpanel" aria-labelledby="skills-tab" className="skills-panel" hidden={!active}>
    <header className="skills-header"><div><h1>Skills</h1><p>Reusable Markdown workflows for Haze. Browse every installed skill, create a new workflow, or edit its instructions.</p></div>
      <div className="skills-actions"><button disabled={!connected || busy} onClick={refresh}>Refresh skills</button><button className="primary" disabled={!connected || busy} onClick={create}>New skill</button></div>
    </header>
    <details className="skills-help" open><summary>What you can do with skills</summary>
      <p><strong>Here:</strong> browse and search all global and approved-project skill files, inspect their full Markdown, create from a template, and edit and save existing skills. Invalid frontmatter is flagged and can be repaired.</p>
      <p><strong>In Haze’s /skills picker:</strong> generate a skill from a description, inspect info, enable or disable, validate references, or remove a skill.</p>
      <button disabled={!connected} onClick={onManage}>Open /skills in Haze</button>
      <p>The shortcut types /skills in the selected terminal. Review the idle prompt, then press Enter to open the picker.</p>
      <p className="fine-print">Project skills override same-named global skills. This file catalog includes disabled skills; enabled status is managed in Haze. Instructions do not execute code. Linked files are not accessible remotely. Changes are not automatically loaded into running instances.</p>
    </details>
    {!connected && <p className="notice">Reconnect to load or save skills. Your unsaved draft stays here.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p className="skill-notice" aria-live="polite">{notice}</p>}
    {catalog?.warnings.map((warning, index) => <p className="notice" key={index}>{warning}</p>)}
    <div className="skills-layout"><aside className="skill-catalog" aria-label="Skill catalog">
      <label>Search skills<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name or description" /></label>
      <label>Skill scope<select aria-label="Skill scope" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All scopes</option>{catalog?.scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.name}</option>)}</select></label>
      <p className="skill-count" aria-live="polite">{busy ? 'Loading…' : `${skills.length} of ${catalog?.skills.length ?? 0} skills`}</p>
      {!busy && !skills.length && <p>{catalog?.skills.length ? 'No skills match your search.' : 'No skills installed yet. Create your first skill or generate one in Haze.'}</p>}
      <ul className="skill-list">{skills.map(skill => <li key={skill.id}><button disabled={!connected || busy} aria-pressed={!creating && document?.id === skill.id} onClick={() => void open(skill.id)}>
        <strong>/{skill.name}</strong><span>{skill.description || 'Missing or invalid description'}</span>
        <small>{catalog?.scopes.find(scope => scope.id === skill.scopeId)?.name}{skill.error ? ' · Needs repair' : ''}</small>
      </button></li>)}</ul>
    </aside><div className="skill-editor">
      {creating || document ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="skill-editor-heading"><h2>{creating ? 'Create a skill' : `/${document!.name}`}</h2><span>{dirty ? 'Unsaved changes' : 'Saved on disk'}</span></div>
        {creating ? <><label>Skill directory<input value={directory} onChange={event => {
          const next = event.target.value; setDirectory(next);
          setDraft(current => current.replace(/^name: .*$/m, `name: ${next || 'my-skill'}`));
        }} pattern="[a-zA-Z0-9_-]{1,80}" maxLength={80} placeholder="e.g. release-checklist" required disabled={busy} /></label>
          <label>Save in<select aria-label="Save in" value={scope} onChange={event => setScope(event.target.value)} disabled={busy}>{catalog?.scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.name} — {scope.path}</option>)}</select></label>
        </> : <><p className="skill-path">{document!.path}</p>{document!.error && <p className="notice">{document!.error}</p>}</>}
        <label>Skill Markdown<textarea aria-label="Skill Markdown" value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} required disabled={busy} /></label>
        <p className="fine-print">Start with YAML frontmatter containing name and description, then write the workflow in Markdown. Maximum 256 KiB. Existing references and other files are left untouched.</p>
        <div className="skills-actions"><button className="primary" type="submit" disabled={!connected || busy || !dirty || (creating && !directory)}>{busy ? 'Working…' : creating ? 'Create skill' : 'Save changes'}</button>
          <button type="button" disabled={busy} onClick={() => { if (discard()) { setCreating(false); setDocument(undefined); setDraft(''); setError(''); setNotice(''); } }}>Close editor</button></div>
      </form> : <div className="skill-empty"><h2>Your workflow library</h2><p>Select a skill to inspect and edit its complete instructions. Or create a skill for a task you repeat.</p><button disabled={!connected || busy} onClick={create}>Create your first workflow</button></div>}
    </div></div>
  </section>;
}
