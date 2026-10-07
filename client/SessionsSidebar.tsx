import { useEffect, useState } from 'react';
import type { AgentInstance } from '../shared/fleet.js';
import type { ManagementCommand, ManagementResponse, SessionInfo } from '../shared/configuration.js';

export type SidebarTab = 'sessions' | 'subagents';
function when(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function SessionsSidebar({ visible, instance, connected, busy, request, onLaunch }: {
  visible: boolean; instance?: AgentInstance; connected: boolean; busy: boolean;
  request: (command: ManagementCommand) => Promise<ManagementResponse>;
  onLaunch: (session: SessionInfo, mode: 'resume' | 'fork') => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [canFork, setCanFork] = useState(false);
  const [busyList, setBusyList] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible || !connected || !instance) return;
    let cancelled = false;
    setBusyList(true); setError('');
    void request({ type: 'sessions-list', projectId: instance.projectId }).then(result => {
      if (cancelled || result.type !== 'sessions-result') return;
      setSessions(result.sessions); setWarnings(result.warnings); setCanFork(result.canFork);
    }).catch(cause => { if (!cancelled) setError((cause as Error).message); })
      .finally(() => { if (!cancelled) setBusyList(false); });
    return () => { cancelled = true; };
  }, [visible, connected, instance?.projectId, request]);
  return <div className="sessions-sidebar" aria-busy={busyList}>
    <header><h2>Sessions</h2><p>Saved Haze conversations for this workspace. Resume continues one; fork copies it first.</p></header>
    {error && <p role="alert" className="error">{error}</p>}
    {warnings.map(warning => <p className="notice" key={warning}>{warning}</p>)}
    {!connected && <p className="notice">Reconnect to load sessions.</p>}
    {connected && !busyList && !sessions?.length && !warnings.length && <p>No saved sessions yet for this workspace.</p>}
    <ul className="session-list">{(sessions ?? []).map(session => <li key={session.id}>
      <div className="session-item">
        <button className="session-main" disabled={!connected || busy} onClick={() => { if (window.confirm(`Resume session ${session.id} in a new tab? It continues this saved conversation in the selected project.`)) onLaunch(session, 'resume'); }}>
          <strong>{session.id}</strong>
          <span>{when(session.updatedAt)} · {(session.sizeBytes / 1024).toFixed(0)} KiB</span>
          {instance?.subagents.sessionId === session.id && <small>Current instance session</small>}
        </button>
        {canFork && <button disabled={!connected || busy} onClick={() => { if (window.confirm(`Fork session ${session.id}? A copy is created first, then the copy opens in a new tab. The original stays unchanged.`)) onLaunch(session, 'fork'); }}>Fork</button>}
      </div>
    </li>)}</ul>
    <footer className="fine-print">Forking copies the conversation to a new session id using installed Haze. Resume appends to the saved session. Both open a new instance tab.</footer>
  </div>;
}

export function SidebarTabs({ tab, onSelect }: { tab: SidebarTab; onSelect: (tab: SidebarTab) => void }) {
  return <div className="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
    <button role="tab" aria-selected={tab === 'sessions'} id="sidebar-sessions-tab" aria-controls="sidebar-sessions-panel" tabIndex={tab === 'sessions' ? 0 : -1} onClick={() => onSelect('sessions')}>Sessions</button>
    <button role="tab" aria-selected={tab === 'subagents'} id="sidebar-subagents-tab" aria-controls="subagent-panel" tabIndex={tab === 'subagents' ? 0 : -1} onClick={() => onSelect('subagents')}>Subagents</button>
  </div>;
}
