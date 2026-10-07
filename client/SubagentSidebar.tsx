import { useEffect, useId, useState, type FormEvent } from 'react';
import { validSessionId, type AgentInstance, type WorkerState } from '../shared/fleet.js';

export type SubagentSidebarProps = {
  instance?: AgentInstance;
  connected: boolean;
  busy: boolean;
  onLink: (id: string) => void;
  onUnlink: () => void;
};

function isActive(worker: WorkerState): boolean {
  if (worker.execution === 'quarantined') return true;
  if (worker.execution === 'settled') return false;
  return worker.state === 'queued' || worker.state === 'started';
}

function workerStatus(worker: WorkerState): string {
  if (worker.execution === 'quarantined') return `${worker.state} · quarantined — still executing`;
  if (worker.execution === 'settled') return `${worker.state} · execution settled`;
  if (worker.state === 'terminal') return 'terminal · execution status not reported';
  if (worker.state === 'settled') return 'settled';
  return worker.state;
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function SubagentSidebar({ instance, connected, busy, onLink, onUnlink }: SubagentSidebarProps) {
  const [sessionId, setSessionId] = useState('');
  const [selectedKey, setSelectedKey] = useState<string>();
  const inputId = useId();
  const helpId = useId();
  const detailsId = useId();
  const feed = instance?.subagents;
  const workers = feed?.workers ?? [];
  const active = workers.filter(isActive);
  const inactive = workers.filter(worker => !isActive(worker));
  const selected = workers.find(worker => worker.key === selectedKey);
  const canChangeLink = Boolean(instance) && connected && !busy;
  const canLink = canChangeLink && instance?.state === 'running';
  const trimmedId = sessionId.trim();

  useEffect(() => {
    setSessionId('');
    setSelectedKey(undefined);
  }, [instance?.id, feed?.sessionId]);

  function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canLink || !validSessionId(trimmedId)) return;
    onLink(trimmedId);
  }

  function workerGroup(label: string, group: WorkerState[]) {
    if (!group.length) return null;
    return (
      <section aria-label={label}>
        <h3>{label} ({group.length})</h3>
        <ul className="worker-list">
          {group.map(worker => (
            <li key={worker.key}>
              <button
                type="button"
                aria-expanded={selectedKey === worker.key}
                aria-controls={detailsId}
                onClick={() => setSelectedKey(selectedKey === worker.key ? undefined : worker.key)}
              >
                <strong>{worker.id}</strong> · {worker.mode} · {workerStatus(worker)}
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <aside className="subagent-sidebar" aria-label="Subagents" aria-busy={busy}>
      <header>
        <h2>Subagents ({workers.length})</h2>
        <p>Parent: {instance?.name ?? 'No Haze selected'}</p>
      </header>
      <p className="feed-status" aria-live="polite">Feed status: {feed?.status ?? 'unlinked'}</p>
      {!instance && <p>Select a Haze instance to link its subagent feed.</p>}
      {!connected && <p>Control unavailable. Displayed metadata may be stale; linking is unavailable until the instance is ready.</p>}
      {feed?.status === 'loading' && <p>Loading linked session metadata.</p>}
      {feed?.status === 'error' && <p>The linked session feed is unavailable. Check the session ID and try linking again.</p>}
      {feed?.status === 'stopped' && <p>The feed has stopped. Displayed metadata is retained history, not a live execution view.</p>}
      <p>Only reported worker metadata is shown; session history may be incomplete.</p>
      {feed?.updatedAt !== undefined && <p>Last feed update: {new Date(feed.updatedAt).toLocaleString()}</p>}
      {feed?.sessionId && <p>User-linked session ID: <code>{feed.sessionId}</code></p>}
      <form onSubmit={link}>
        <label htmlFor={inputId}>Haze session ID</label>
        <input
          id={inputId}
          value={sessionId}
          onChange={event => setSessionId(event.target.value)}
          disabled={!canLink}
          aria-describedby={helpId}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={160}
          required
        />
        <button type="submit" disabled={!canLink || !validSessionId(trimmedId)}>Link session</button>
        <button type="button" disabled={!canChangeLink || !feed?.sessionId} onClick={onUnlink}>Unlink session</button>
      </form>
      <p id={helpId}>
        Run <code>/session</code> in the selected Haze and enter its session ID here.
        {' '}Linking is manual: there is no automatic PTY association or session discovery.
        {' '}Subagent feeds are unavailable for Haze launched with <code>--no-session</code>.
        {' '}IDs use letters, numbers, dots, underscores, or hyphens and start with a letter or number.
      </p>
      <p>Worker buttons reveal metadata only. No worker terminal or worker controls are available.</p>
      {workers.length === 0 && <p>No worker metadata reported.</p>}
      {workerGroup('Active workers', active)}
      {workerGroup('Settled / other reported workers', inactive)}
      <section id={detailsId} className="worker-details" hidden={!selected} aria-label="Worker details">
        {selected && <>
          <h3>Worker {selected.id}</h3>
          <dl>
            <dt>ID</dt><dd>{selected.id}</dd>
            <dt>Scope</dt><dd>{selected.scope}</dd>
            <dt>Mode</dt><dd>{selected.mode}</dd>
            <dt>State</dt><dd>{selected.state}</dd>
            <dt>Execution</dt><dd>{selected.execution ?? 'Not reported'}</dd>
            <dt>Termination</dt><dd>{selected.termination ?? 'Not reported'}</dd>
            <dt>Queue duration</dt><dd>{selected.queueMs === undefined ? 'Not reported' : duration(selected.queueMs)}</dd>
            <dt>Execution duration</dt><dd>{selected.durationMs === undefined ? 'Not reported' : duration(selected.durationMs)}</dd>
            <dt>Reported at</dt><dd>{selected.at}</dd>
          </dl>
          {selected.execution === 'quarantined' && <p>Quarantined execution is still executing, even if a terminal result was reported.</p>}
          {selected.execution === 'settled' && <p>Execution has settled and is no longer executing.</p>}
          {selected.state === 'terminal' && !selected.execution && <p>A terminal result alone does not confirm execution has settled.</p>}
        </>}
      </section>
    </aside>
  );
}
