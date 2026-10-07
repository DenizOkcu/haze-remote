import { useEffect, useRef } from 'react';
import type { AgentInstance, WorkerState } from '../shared/fleet.js';

export type SubagentOutput = { output: string; result: string; truncated: boolean; revision: number };
export type SubagentSidebarProps = {
  instance?: AgentInstance;
  connected: boolean;
  busy: boolean;
  selectedKey?: string;
  output?: SubagentOutput;
  onSelect: (workerKey?: string) => void;
};

function isActive(worker: WorkerState): boolean {
  if (worker.execution === 'quarantined') return true;
  if (worker.execution === 'settled') return false;
  return worker.state === 'queued' || worker.state === 'started';
}
function workerStatus(worker: WorkerState): string {
  if (worker.execution === 'quarantined') return 'still executing (quarantined)';
  if (worker.state === 'settled' || worker.execution === 'settled') return 'finished';
  if (worker.state === 'terminal') return 'finished (settlement unconfirmed)';
  return worker.state === 'started' ? 'running' : worker.state;
}
function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function workerTitle(worker: WorkerState): string {
  return worker.objective ? worker.objective.split('\n')[0].slice(0, 80) : `${worker.mode} subagent`;
}

export function SubagentSidebar({ instance, connected, busy, selectedKey, onSelect }: SubagentSidebarProps) {
  const feed = instance?.subagents;
  const workers = feed?.workers ?? [];
  const active = workers.filter(isActive);
  const finished = workers.filter(worker => !isActive(worker));

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
                aria-pressed={selectedKey === worker.key}
                disabled={!connected || busy}
                onClick={() => onSelect(selectedKey === worker.key ? undefined : worker.key)}
              >
                <strong>{workerTitle(worker)}</strong>
                <span className="worker-meta">{worker.mode} · {workerStatus(worker)}
                  {worker.termination ? ` · ${worker.termination}` : ''}
                  {worker.durationMs !== undefined ? ` · ${duration(worker.durationMs)}` : ''}</span>
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
        <p>Session: {instance?.name ?? 'No Haze selected'}</p>
      </header>
      <p className="feed-status" aria-live="polite">Observation: {feed?.status ?? 'off'}{feed?.sessionId ? ` · ${feed.sessionId}` : ''}</p>
      {feed?.status === 'unsupported' && <p role="note">{feed.message ?? 'This Haze version or install does not support subagent observation.'} Terminal control is unaffected.</p>}
      {feed?.status === 'off' && <p role="note">{feed.message ?? 'Waiting for Haze to report subagent activity.'}</p>}
      {!instance && <p>Select a Haze instance to see its subagents.</p>}
      {!connected && <p>Control unavailable. Displayed runs may be stale until reconnected.</p>}
      {workers.length === 0 && <p>No subagent runs yet for this session.</p>}
      {workerGroup('Running', active)}
      {workerGroup('Finished', finished)}
      <p>Selecting a run opens its live output over the terminal; the same view replays finished runs.</p>
    </aside>
  );
}

/** Overlay over the session terminal: one transcript for live streaming and finished-run replay. */
export function SubagentOverlay({ worker, output, onClose }: { worker: WorkerState; output?: SubagentOutput; onClose: () => void }) {
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = transcript.current; if (el && isActive(worker)) el.scrollTop = el.scrollHeight; }, [output?.revision, worker.key]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  const result = output?.result?.trim() ?? '';
  const streamed = output?.output?.trim() ?? '';
  // The deliverable often repeats the streamed tail; show it once, appended to the same transcript.
  const duplicateResult = !!result && !!streamed && streamed.endsWith(result);
  return (
    <section className="worker-overlay" role="region" aria-label="Subagent run">
      <header>
        <div className="worker-overlay-title">
          <strong>{workerTitle(worker)}</strong>
          <span className="worker-meta">{worker.id} · {worker.mode} · {workerStatus(worker)}
            {worker.termination ? ` · ${worker.termination}` : ''}
            {worker.queueMs !== undefined ? ` · queued ${duration(worker.queueMs)}` : ''}
            {worker.durationMs !== undefined ? ` · ran ${duration(worker.durationMs)}` : ''}</span>
        </div>
        <button type="button" onClick={onClose}>Close (Esc)</button>
      </header>
      {worker.objective && <details className="worker-objective"><summary>Objective</summary><p>{worker.objective}</p></details>}
      {worker.execution === 'quarantined' && <p className="worker-note">Quarantined execution may still be running despite a terminal result.</p>}
      <div className="transcript" ref={transcript} tabIndex={0}>
        <pre aria-label="Subagent output">{output?.output || (isActive(worker) ? '(streaming — no output yet)' : '(no output retained)')}</pre>
        {result && !duplicateResult && <pre className="deliverable" aria-label="Subagent result">{'─'.repeat(3)} final deliverable {'\n'}{result}</pre>}
      </div>
      {output?.truncated && <p className="worker-note">Older output was dropped after the retention limit; the most recent text is shown.</p>}
      <footer>Read-only observation; steer the parent Haze terminal instead.</footer>
    </section>
  );
}
