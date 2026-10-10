import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClientSession } from '../shared/session.js';
import { type DeviceCredential } from '../shared/crypto.js';
import { loadCredential, saveCredential, forgetCredential } from './credentials';
import { sendTerminalInput, type InputResult } from './input';
import { SubagentSidebar, SubagentOverlay } from './SubagentSidebar';
import type { FleetState, FleetRequest } from '../shared/fleet.js';
import type { WorkerOutput } from '../shared/observer.js';
import type { SkillResponse } from '../shared/skills.js';
import type { ManagementCommand, ManagementResponse, SessionInfo } from '../shared/configuration.js';
import { SkillsTab, type SkillCommand } from './SkillsTab';
import { ConfigurationTabs } from './ConfigurationTabs';
import { SessionsSidebar, SidebarTabs, type SidebarTab } from './SessionsSidebar';
import { SpeechInput } from './SpeechInput';
import { SpeechRpc } from './speech-rpc';
import { BrowserLanSocket } from './browser-lan-socket';
import { consumePairingFragment } from './pairing-link';
const pairingLink = consumePairingFragment(window.location, window.history);

type Status = 'Connecting' | 'Connected' | 'Reconnecting' | 'Already connected' | 'Exited' | 'Switching' | 'Stopping';
type FleetCommand = FleetRequest extends infer R ? R extends FleetRequest ? Omit<R, 'requestId'> : never : never;
const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
export function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>('Connecting');
  const [project, setProject] = useState('');
  const [pid, setPid] = useState<number>();
  const [exitCode, setExitCode] = useState<number>();
  const [epoch, setEpoch] = useState(0);
  const [fleet, setFleet] = useState<FleetState>();
  const [view, setView] = useState<'terminal' | 'skills' | 'providers' | 'settings'>('terminal');
  const viewRef = useRef(view); viewRef.current = view;
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('subagents');
  const skillPending = useRef(new Map<string, { resolve: (value: SkillResponse & { type: 'skills-result' }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const managementPending = useRef(new Map<string, { resolve: (value: ManagementResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const [activeId, setActiveId] = useState('');
  const [operation, setOperation] = useState<string>();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newProject, setNewProject] = useState('');
  const [resumeSession, setResumeSession] = useState<string>();
  const [allowShared, setAllowShared] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const [watchedWorker, setWatchedWorker] = useState<string>();
  const [workerOutput, setWorkerOutput] = useState<WorkerOutput>();
  const display = useRef<{ id: string; viewId: string }>({ id: '', viewId: '' });
  const seen = useRef(new Map<string, number>());
  const pendingOperation = useRef<{ id: string; type: FleetRequest['type'] } | undefined>(undefined);
  const operationTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fleetRequest = useRef<(request: FleetRequest) => void>(() => {});
  const [fontSize, setFontSize] = useState(() => {
    try { const value = Number(localStorage.getItem('haze-remote-font-size')); return value >= 12 && value <= 24 ? value : 14; }
    catch { return 14; }
  });
  const [retryAt, setRetryAt] = useState<number>();
  const [clock, setClock] = useState(Date.now());
  const lastContact = useRef<number | undefined>(undefined);
  const retryNow = useRef<() => void>(() => {});
  const fitCurrent = useRef<() => void>(() => {});
  const currentFontSize = useRef(fontSize);
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const credential = useRef<DeviceCredential | undefined>(undefined);
  const serverId = useRef(pairingLink.room);
  const pairingSecret = useRef(pairingLink.secret);
  const session = useRef<ClientSession | undefined>(undefined);
  const [speechRpc] = useState(() => new SpeechRpc(message => session.current?.send(message) ?? false));
  const closed = useRef<((code: number) => void) | undefined>(undefined);
  const input = useRef<(data: string) => InputResult>(() => 'not-sent');
  const requestManagement = useCallback((command: ManagementCommand) => new Promise<ManagementResponse>((resolve, reject) => {
    const id = requestId();
    const timer = setTimeout(() => {
      managementPending.current.delete(id);
      reject(new Error('Operation was not confirmed. Reload or retry after reconnecting; nothing is replayed automatically.'));
    }, 12_000);
    managementPending.current.set(id, { resolve, reject, timer });
    try {
      if (!session.current?.send({ ...command, requestId: id })) throw new Error('Request not sent');
    } catch {
      clearTimeout(timer); managementPending.current.delete(id);
      reject(new Error('Request was not sent. Reconnect and try again.'));
    }
  }), []);
  const requestSkill = useCallback((command: SkillCommand) => new Promise<SkillResponse & { type: 'skills-result' }>((resolve, reject) => {
    const id = requestId();
    const timer = setTimeout(() => {
      skillPending.current.delete(id);
      reject(new Error('Skill operation was not confirmed. Refresh or reopen the skill before retrying; nothing is replayed automatically.'));
    }, 12_000);
    skillPending.current.set(id, { resolve, reject, timer });
    try {
      if (!session.current?.send({ ...command, requestId: id })) throw new Error('Request not sent');
    } catch {
      clearTimeout(timer); skillPending.current.delete(id);
      reject(new Error('Skill request was not sent. Reconnect and try again.'));
    }
  }), []);
  function disconnectSkills() {
    speechRpc.disconnect();
    for (const pending of skillPending.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection lost. Reopen the skill to check whether a save completed; your draft is preserved.'));
    }
    skillPending.current.clear();
    for (const pending of managementPending.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection lost. Check whether the change completed by reloading; your drafts are preserved.'));
    }
    managementPending.current.clear();
  }
  function finishOperation(id?: string) {
    if (id && pendingOperation.current?.id !== id) return;
    clearTimeout(operationTimeout.current); pendingOperation.current = undefined; setOperation(undefined);
  }
  const watchedWorkerRef = useRef<string | undefined>(undefined);
  const command = (request: FleetCommand) => fleetRequest.current({ ...request, requestId: requestId() });
  function selectWorker(key?: string) {
    // Keep any prior streaming view until the new selection's first frame arrives.
    watchedWorkerRef.current = key;
    setWatchedWorker(key);
    command({ type: key ? 'worker-watch' : 'worker-unwatch', instanceId: display.current.id, ...(key ? { workerKey: key } : {}) });
  }

  useEffect(() => {
    currentFontSize.current = fontSize;
    if (terminal.current) { terminal.current.options.fontSize = fontSize; fitCurrent.current(); }
    try { localStorage.setItem('haze-remote-font-size', String(fontSize)); } catch { /* Preference storage is optional. */ }
  }, [fontSize]);
  useEffect(() => {
    if (!paired) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.style.setProperty('--viewport-height', `${viewport?.height ?? window.innerHeight}px`);
    const narrow = window.matchMedia('(max-width: 760px)');
    const collapseSidebar = () => { if (narrow.matches) setSidebarOpen(false); };
    resize(); viewport?.addEventListener('resize', resize); narrow.addEventListener('change', collapseSidebar);
    return () => { clearInterval(timer); viewport?.removeEventListener('resize', resize); narrow.removeEventListener('change', collapseSidebar); document.documentElement.style.removeProperty('--viewport-height'); };
  }, [paired]);

  function openSession(password: string, remembered?: DeviceCredential) {
    const connection = new ClientSession(new BrowserLanSocket(serverId.current), {
      serverId: serverId.current, requireBinding: true, password, credential: remembered,
      async onApproved(value) {
        credential.current = value;
        try { await saveCredential(value); }
        catch { setError('Cannot remember this device. This connection works, but reload will require local revocation and pairing again.'); }
        if (session.current !== connection || connection.socket.readyState !== 1) return;
        setBusy(false); setPaired(true);
      },
      onError(message) { if (session.current === connection) setError(message); },
      onClose(code) {
        if (session.current !== connection) return;
        session.current = undefined;
        if (closed.current) closed.current(code);
        else { setBusy(false); }
      },
    });
    session.current = connection;
    return connection;
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ClientSession.ready();
        if (!serverId.current) throw new Error('Open the pairing link from your computer.');
        let stored: DeviceCredential | undefined;
        try { stored = await loadCredential(serverId.current); } catch { /* Memory-only pairing still works. */ }
        if (cancelled) return;
        if (stored?.serverId === serverId.current) { credential.current = stored; pairingSecret.current = ''; pairingLink.secret = ''; setPaired(true); }
        else {
          setPaired(false);
          if (pairingSecret.current) { setBusy(true); openSession(pairingSecret.current); pairingSecret.current = ''; pairingLink.secret = ''; }
        }
      } catch { if (!cancelled) { setError('Cannot initialize encrypted connection. Check the computer and reload.'); setPaired(false); } }
    })();
    return () => { cancelled = true; session.current?.close(); };
  }, []);
  useEffect(() => {
    if (!paired || !host.current) return;
    let disposed = false, connecting = false, reconnectAllowed = true, ready = false, processExited = false;
    let attempt = 0, lastPong = Date.now();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const term = new Terminal({ cursorBlink: true, fontSize: currentFontSize.current, scrollback: 2000, disableStdin: true,
      theme: { background: '#0f141b', foreground: '#e6edf3', cursor: '#7ee2b8', selectionBackground: '#26433a' },
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); terminal.current = term;
    const send = (message: unknown) => session.current?.send(message) ?? false;
    input.current = data => {
      const target = display.current;
      const result = sendTerminalInput(data, ready && !processExited && viewRef.current === 'terminal' && session.current?.socket.readyState === 1,
        message => send({ ...message, instanceId: target.id, viewId: target.viewId }));
      if (result === 'too-large') setError('Paste is too large (64 KiB maximum). Split it into smaller pieces.');
      else if (result !== 'queued') setError(result === 'partial'
        ? 'Input delivery is uncertain or partial. Inspect the terminal before retrying; nothing will be replayed automatically.'
        : 'Input was not sent. Reconnect or wait for the connection to catch up, then retry.');
      return result;
    };
    const fitTerminal = () => {
      if (!ready || !host.current?.offsetParent) return;
      const dimensions = fit.proposeDimensions(); if (!dimensions) return;
      const cols = Math.min(240, Math.max(20, dimensions.cols)), rows = Math.min(100, Math.max(5, dimensions.rows));
      term.resize(cols, rows); if (!processExited) send({ type: 'resize', cols, rows, instanceId: display.current.id, viewId: display.current.viewId });
    };
    fitCurrent.current = fitTerminal;
    const resize = new ResizeObserver(fitTerminal); resize.observe(host.current);
    const dataListener = term.onData(data => { input.current(data); });
    const disconnectInput = () => { ready = false; term.options.disableStdin = true; };
    fleetRequest.current = request => {
      if (!ready || pendingOperation.current || session.current?.socket.readyState !== 1) return;
      const navigation = request.type === 'instance-create' || request.type === 'instance-select';
      pendingOperation.current = { id: request.requestId, type: request.type }; setOperation(request.type); setError('');
      if (navigation) { disconnectInput(); setStatus('Switching'); }
      try {
        if (!send(request)) throw new Error('Request not sent');
        operationTimeout.current = setTimeout(() => {
          finishOperation(request.requestId); setError('Fleet operation was not confirmed. Reconnecting to restore the actual fleet; no launch or input will be replayed.');
          session.current?.close();
        }, 12_000);
      } catch {
        finishOperation(request.requestId); setError('Fleet request was not sent or delivery is uncertain. Inspect the fleet after reconnecting before retrying.');
        if (navigation) { ready = true; term.options.disableStdin = processExited; setStatus(processExited ? 'Exited' : 'Connected'); }
      }
    };
    const dropCredential = () => {
      reconnectAllowed = false; credential.current = undefined;
      void forgetCredential(serverId.current).catch(() => {}); setPaired(false);
      setProject(''); setPid(undefined); lastContact.current = undefined; setRetryAt(undefined);
      seen.current.clear(); display.current = { id: '', viewId: '' };
      setFleet(undefined); setActiveId(''); setShowCreate(false); setWatchedWorker(undefined); setWorkerOutput(undefined); finishOperation();
    };
    function attach(connection: ClientSession) {
      unsubscribe?.();
      unsubscribe = connection.subscribe(message => {
        if (disposed || session.current !== connection) return;
        lastContact.current = Date.now();
        if (message.type === 'speech-result' || message.type === 'speech-error') { speechRpc.receive(message); return; }
        if (message.type === 'skills-result' || message.type === 'skills-error') {
          const pending = skillPending.current.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timer); skillPending.current.delete(message.requestId);
            if (message.type === 'skills-error') pending.reject(new Error(message.message));
            else pending.resolve(message);
          }
          return;
        }
        if (message.type === 'configuration-result' || message.type === 'sessions-result' || message.type === 'management-error') {
          const pending = managementPending.current.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timer); managementPending.current.delete(message.requestId);
            if (message.type === 'management-error') pending.reject(new Error(message.message));
            else pending.resolve(message);
          }
          return;
        }
        if (message.type === 'snapshot') {
          const pending = pendingOperation.current;
          const focusSelectedTab = pending?.type === 'instance-select';
          if (pending && (pending.type === 'instance-select' || pending.type === 'instance-create') && message.requestId !== pending.id) return;
          disconnectInput();
          const target = { id: message.instanceId, viewId: message.viewId }; display.current = target;
          setActiveId(target.id); setFleet(message.fleet); seen.current.set(target.id, Date.now());
          setWatchedWorker(undefined); setWorkerOutput(undefined);
          if (pending?.type === 'instance-create') setShowCreate(false);
          if (message.requestId) finishOperation(message.requestId);
          term.reset(); term.resize(message.cols, message.rows);
          setProject(message.cwd); setPid(message.pid);
          processExited = message.exit !== null; setExitCode(message.exit?.exitCode);
          term.write(message.data, () => {
            if (disposed || session.current !== connection || display.current !== target || connection.socket.readyState !== 1) return;
            ready = true; attempt = 0; lastPong = Date.now(); setRetryAt(undefined);
            term.options.disableStdin = processExited; setStatus(processExited ? 'Exited' : 'Connected'); fitTerminal();
            if (focusSelectedTab) document.getElementById(`tab-${target.id}`)?.focus();
            else {
              // Startup and reconnect land the cursor in the terminal, but never steal it from a form field mid-entry.
              const active = document.activeElement;
              const inFormControl = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
              if (!inFormControl && viewRef.current === 'terminal') term.focus();
            }
          });
        } else if (message.type === 'output') {
          if (message.instanceId === display.current.id && message.viewId === display.current.viewId) term.write(message.data);
        } else if (message.type === 'exit') {
          if (message.instanceId === display.current.id && message.viewId === display.current.viewId) {
            processExited = true; term.options.disableStdin = true; setExitCode(message.exitCode); setStatus('Exited');
          }
        } else if (message.type === 'subagent-output') {
          if (message.instanceId === display.current.id && message.workerKey === watchedWorkerRef.current) setWorkerOutput(message);
        } else if (message.type === 'fleet') {
          setFleet(message.fleet);
          const active = message.fleet.instances.find((instance: any) => instance.id === display.current.id);
          if (active) {
            seen.current.set(active.id, active.lastActivity ?? Date.now());
            if (ready && active.state !== 'running') { processExited = true; term.options.disableStdin = true; setExitCode(active.exit?.exitCode); setStatus(active.state === 'stopping' ? 'Stopping' : 'Exited'); }
          }
        } else if (message.type === 'fleet-result') finishOperation(message.requestId);
        else if (message.type === 'fleet-error') {
          setError(message.message);
          if (message.requestId && pendingOperation.current && message.requestId === pendingOperation.current.id) {
            const navigation = ['instance-create', 'instance-select'].includes(pendingOperation.current!.type);
            finishOperation(message.requestId);
            if (navigation) { ready = true; term.options.disableStdin = processExited; setStatus(processExited ? 'Exited' : 'Connected'); }
          }
        } else if (message.type === 'pong') lastPong = Date.now();
      });
    }
    async function connect() {
      if (disposed || connecting || !reconnectAllowed || (session.current && session.current.socket.readyState !== 3)) return;
      connecting = true; disconnectInput(); setRetryAt(undefined); setStatus(attempt ? 'Reconnecting' : 'Connecting');
      try {
        if (!credential.current) { dropCredential(); return; }
        attach(openSession(credential.current.password, credential.current));
      } catch { if (!disposed) schedule(); }
      finally { connecting = false; }
    }
    function schedule() {
      if (disposed || !reconnectAllowed) return;
      setStatus('Reconnecting'); clearTimeout(retry);
      const delay = Math.min(8000, 500 * 2 ** Math.min(attempt++, 4));
      setRetryAt(Date.now() + delay);
      retry = setTimeout(() => { void connect(); }, delay);
    }
    closed.current = code => {
      if (disposed) return;
      disconnectInput(); finishOperation(); disconnectSkills();
      if (code === 4000) { reconnectAllowed = false; setStatus('Already connected'); return; }
      if (code === 4001 || code === 1008) { dropCredential(); return; }
      schedule();
    };
    retryNow.current = () => {
      if (disposed || !reconnectAllowed || connecting) return;
      clearTimeout(retry); void connect();
    };
    const heartbeat = setInterval(() => {
      if (session.current?.socket.readyState !== 1) return;
      if (Date.now() - lastPong > 30_000) { session.current.close(); return; }
      if (ready) send({ type: 'ping' });
    }, 10_000);
    const wake = () => {
      if (document.visibilityState !== 'visible' || !reconnectAllowed || connecting) return;
      const socket = session.current?.socket;
      if (socket?.readyState === 1 && Date.now() - lastPong > 30_000) session.current?.close();
      else if (!socket || socket.readyState === 3) { clearTimeout(retry); void connect(); }
    };
    const offline = () => {
      if (disposed || !reconnectAllowed) return;
      // A connection can stall while the browser is offline.
      // Do not advertise Connected or leave controls enabled until onclose fires.
      disconnectInput(); finishOperation(); disconnectSkills(); setStatus('Reconnecting'); setRetryAt(undefined);
      session.current?.close();
    };
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake); window.addEventListener('offline', offline);
    if (session.current) attach(session.current); else void connect();
    return () => {
      disposed = true; closed.current = undefined; input.current = () => 'not-sent'; disconnectSkills();
      retryNow.current = () => {}; fitCurrent.current = () => {}; fleetRequest.current = () => {}; finishOperation();
      clearTimeout(retry); clearInterval(heartbeat); unsubscribe?.();
      document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', offline);
      const old = session.current; session.current = undefined; old?.close();
      resize.disconnect(); dataListener.dispose(); term.dispose(); terminal.current = null;
    };
  }, [paired, epoch]);

  async function pair(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await ClientSession.ready(); openSession(pairingSecret.current); pairingSecret.current = ''; pairingLink.secret = ''; }
    catch { setError('Cannot start encrypted pairing'); setBusy(false); }
  }
  function unpair() {
    if (!window.confirm('Unpair this browser? Haze keeps running, but remote access will end and pairing stays closed. To reconnect, type pair on the computer and generate a new pairing link.')) return;
    try {
      if (!session.current?.send({ type: 'unpair' })) throw new Error('Not sent');
      credential.current = undefined; void forgetCredential(serverId.current).catch(() => {});
    } catch { setError('Unpair was not confirmed. Reconnect or revoke locally on the computer.'); }
  }
  const connected = status === 'Connected';
  const canOperate = ['Connected', 'Exited', 'Stopping'].includes(status);
  const activeInstance = fleet?.instances.find(instance => instance.id === activeId);
  const chosenProject = fleet?.projects.find(project => project.id === newProject);
  const sharesCheckout = fleet?.instances.some(instance => instance.cwd === chosenProject?.cwd && instance.state !== 'exited') ?? false;
  if (paired === null) return <main className="pair-screen"><p role="status">Initializing encrypted connection…</p></main>;
  if (!paired) return <main className="pair-screen"><section className="pair-card">
    <div className="wordmark">haze<span> / remote</span></div>
    <h1>Your terminal. On your network.</h1>
    <p>Open the pairing link shown on your computer. Keep both devices on the same trusted private network.</p>
    <form onSubmit={pair}><button className="primary" disabled={busy || !pairingSecret.current}>{busy ? 'Connecting securely…' : 'Connect'}</button></form>
    {busy && <button onClick={() => session.current?.close()}>Cancel connection</button>}
    {error && <p role="alert" className="error">{error}</p>}
    <p className="fine-print">Terminal transport is encrypted. Keep the computer awake and remote access running. A pairing link grants access to your computer; do not share it.</p>
  </section></main>;
  return <main className="workspace">
    <header className="app-header">
      <div className="wordmark">haze<span> / remote</span></div>
      <div className={`status ${connected ? 'live' : ''}`} role="status">{status}{status === 'Exited' ? ` (${exitCode ?? '?'})` : ''}</div>
      <div className="connection-meta">{location.host} · {lastContact.current ? `Last authenticated contact ${Math.max(0, Math.floor((clock - lastContact.current) / 1000))}s ago` : 'Waiting for authenticated contact'}</div>
      <button onClick={unpair}>Unpair</button>
    </header>
    <div className="session-meta"><span title={project}>{project || 'Authenticating approved device…'}</span><span>{pid ? `PID ${pid}` : 'PTY'}</span></div>
    {status === 'Already connected' && <div className="notice">This device is connected in another tab. Close that tab first. <button onClick={() => setEpoch(e => e + 1)}>Reconnect</button></div>}
    {status === 'Reconnecting' && <div className="notice">Connection lost. Disconnecting the browser does not stop Haze. Check that the host is awake, haze-remote is running, and the network is reachable. {retryAt ? `Retry in ${Math.max(0, Math.ceil((retryAt - clock) / 1000))}s.` : 'Re-authenticating…'} <button onClick={() => retryNow.current()}>Retry now</button></div>}
    {status === 'Exited' && <div className="notice">Haze exited. Recent output is available until haze-remote stops.</div>}
    {error && <div className="error" role="alert">{error}</div>}
    <nav className="workspace-tabs" role="tablist" aria-label="Workspace sections" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const order = ['terminal', 'skills', 'providers', 'settings'] as const;
      const index = order.indexOf(view);
      const next = event.key === 'Home' ? order[0] : event.key === 'End' ? order[order.length - 1]
        : order[(index + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length];
      setView(next); document.getElementById(`${next}-tab`)?.focus();
    }}>
      <button role="tab" id="terminal-tab" aria-selected={view === 'terminal'} aria-controls="terminal-panel" tabIndex={view === 'terminal' ? 0 : -1} onClick={() => setView('terminal')}>Terminal</button>
      <button role="tab" id="skills-tab" aria-selected={view === 'skills'} aria-controls="skills-panel" tabIndex={view === 'skills' ? 0 : -1} onClick={() => setView('skills')}>Skills</button>
      <button role="tab" id="providers-tab" aria-selected={view === 'providers'} aria-controls="providers-panel" tabIndex={view === 'providers' ? 0 : -1} onClick={() => setView('providers')}>Providers</button>
      <button role="tab" id="settings-tab" aria-selected={view === 'settings'} aria-controls="settings-panel" tabIndex={view === 'settings' ? 0 : -1} onClick={() => setView('settings')}>Settings</button>
    </nav>
    <SkillsTab active={view === 'skills'} connected={canOperate} projectId={activeInstance?.projectId} request={requestSkill} onManage={() => {
      if (!connected || activeInstance?.state !== 'running') { setError('Select a running Haze instance in the Terminal tab to open /skills.'); return; }
      if (!window.confirm('Type /skills into the selected Haze terminal? Continue only when Haze is idle at an empty prompt. Review it and press Enter to open the picker.')) return;
      viewRef.current = 'terminal'; setView('terminal');
      input.current('/skills'); requestAnimationFrame(() => terminal.current?.focus());
    }} />
    <ConfigurationTabs view={view} connected={canOperate} request={requestManagement} onNativeProvider={() => {
      if (!connected || activeInstance?.state !== 'running') { setError('Select a running Haze instance in the Terminal tab to open the native provider picker.'); return; }
      if (!window.confirm('Type /provider into the selected Haze terminal? Continue only when Haze is idle at an empty prompt. Review it and press Enter to open the picker (needed for OAuth sign-in).')) return;
      viewRef.current = 'terminal'; setView('terminal');
      input.current('/provider'); requestAnimationFrame(() => terminal.current?.focus());
    }} />
    <div id="terminal-panel" role="tabpanel" aria-labelledby="terminal-tab" className="terminal-section" hidden={view !== 'terminal'}>
    <div className="fleet-navigation">
      <nav className="fleet-tabs" role="tablist" aria-label="Haze instances">{fleet?.instances.map(instance => <button key={instance.id} role="tab" id={`tab-${instance.id}`} aria-controls="fleet-terminal" aria-selected={activeId === instance.id} tabIndex={activeId === instance.id ? 0 : -1} disabled={!canOperate || !!operation} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !fleet) return;
        event.preventDefault(); const index = fleet.instances.findIndex(item => item.id === instance.id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? fleet.instances.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + fleet.instances.length) % fleet.instances.length;
        const target = fleet.instances[next]; command({ type: 'instance-select', instanceId: target.id });
        document.getElementById(`tab-${target.id}`)?.focus();
      }} onClick={() => { if (instance.id !== activeId) command({ type: 'instance-select', instanceId: instance.id }); }}><strong>{instance.name}</strong><small>{instance.state}{instance.exit ? ` (${instance.exit.exitCode})` : ''}{instance.id !== activeId && (instance.lastActivity ?? 0) > (seen.current.get(instance.id) ?? instance.createdAt) ? ' · New output' : ''}</small></button>)}</nav>
      <button disabled={!canOperate || !!operation || !fleet || fleet.instances.length >= fleet.limit} onClick={() => { setNewName(`Haze ${(fleet?.instances.length ?? 0) + 1}`); setNewProject(activeInstance?.projectId ?? fleet?.projects[0]?.id ?? ''); setAllowShared(false); setShowCreate(true); }}>New instance</button>
      <button aria-expanded={sidebarOpen} aria-controls="subagent-panel" onClick={() => setSidebarOpen(open => !open)}>Sidebar</button>
    </div>
    {showCreate && <section className="new-instance" aria-label="Create Haze instance"><form onSubmit={event => { event.preventDefault(); command({ type: 'instance-create', name: newName, projectId: newProject, allowShared: sharesCheckout && allowShared, ...(resumeSession ? { launch: { mode: 'resume' as const, sessionId: resumeSession } } : {}) }); setResumeSession(undefined); }}>
      <label>Instance name<input aria-label="Instance name" value={newName} onChange={event => setNewName(event.target.value)} maxLength={80} required disabled={!!operation} /></label>
      <label>Approved project<select aria-label="Approved project" value={newProject} onChange={event => { setNewProject(event.target.value); setAllowShared(false); }} disabled={!!operation}>{fleet?.projects.map(project => <option key={project.id} value={project.id}>{project.name} — {project.cwd}</option>)}</select></label>
      {sharesCheckout && <label className="check-row"><input type="checkbox" aria-label="Allow shared checkout" checked={allowShared} onChange={event => setAllowShared(event.target.checked)} disabled={!!operation} />Allow shared checkout. These instances can edit the same files; use separate locally approved worktrees for independent writers.</label>}
      <button className="primary" type="submit" disabled={!canOperate || !!operation || !newName.trim() || (sharesCheckout && !allowShared)}>{operation === 'instance-create' ? 'Starting…' : resumeSession ? 'Resume session' : 'Start Haze'}</button><button type="button" disabled={!!operation} onClick={() => { setShowCreate(false); setResumeSession(undefined); }}>Cancel</button>
    </form></section>}
    <div className={`fleet-shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
    <div id="subagent-panel" className="sidebar-container" hidden={!sidebarOpen}><div className="sidebar-content">
      <SidebarTabs tab={sidebarTab} onSelect={setSidebarTab} />
      {sidebarTab === 'subagents'
        ? <SubagentSidebar instance={activeInstance} connected={canOperate} busy={!!operation} selectedKey={watchedWorker} output={workerOutput} onSelect={selectWorker} />
        : <SessionsSidebar visible={sidebarOpen && sidebarTab === 'sessions'} instance={activeInstance} connected={canOperate} busy={!!operation} request={requestManagement} onLaunch={(session: SessionInfo, mode) => {
          if (mode === 'fork') { setError('Forking is prepared on the server; use Resume for now, or fork from Haze’s native /sessions picker.'); return; }
          setNewName(`Session ${session.id.slice(0, 8)}`); setNewProject(activeInstance?.projectId ?? ''); setAllowShared(true); setShowCreate(true); setResumeSession(session.id);
        }} />}
    </div></div>
    <section id="fleet-terminal" className="terminal-pane" role="tabpanel" aria-labelledby={activeId ? `tab-${activeId}` : undefined}>
    <div className="terminal-toolbar">
      <span className="window-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="terminal-title">{activeInstance?.name ?? 'Loading fleet…'}<small> · {fleet?.instances.filter(instance => instance.state === 'running').length ?? 0} running</small></span>
      <SpeechInput setMicrophone={track => { const socket = session.current?.socket; if (!(socket instanceof BrowserLanSocket)) { track?.stop(); return Promise.reject(new Error('Audio connection unavailable')); } return socket.setMicrophone(track); }} rpc={speechRpc} target={{ id: activeId, name: activeInstance?.name ?? 'Haze' }} enabled={connected && !operation && view === 'terminal' && activeInstance?.state === 'running'} send={(id, text) => {
        if (id !== display.current.id || !text.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return 'not-sent';
        if (new TextEncoder().encode(text).byteLength > 8000) return 'too-large';
        return input.current(`\x1b[200~${text}\x1b[201~\r`);
      }} />
      <div className="toolbar-group" aria-label="Terminal readability"><button disabled={fontSize <= 12} onClick={() => setFontSize(size => Math.max(12, size - 2))} aria-label="Smaller terminal text">A−</button><span className="font-size">{fontSize}px</span><button disabled={fontSize >= 24} onClick={() => setFontSize(size => Math.min(24, size + 2))} aria-label="Larger terminal text">A+</button><button onClick={() => terminal.current?.scrollToBottom()}>Latest output</button></div>
      {activeInstance?.state === 'exited' ? <button disabled={!canOperate || !!operation || (fleet?.instances.length ?? 0) < 2} onClick={() => command({ type: 'instance-close', instanceId: activeId })}>Close tab</button> : <button className="danger" disabled={!canOperate || !!operation || activeInstance?.state !== 'running'} onClick={() => { if (window.confirm(`Stop ${activeInstance?.name}? Its Haze process will terminate. Other instances keep running. Recent output remains until you close this tab.`)) command({ type: 'instance-stop', instanceId: activeId }); }}>Stop instance</button>}
    </div>
    {status === 'Switching' && <p className="notice">Restoring instance screen. Input is disabled until its snapshot is ready.</p>}
    <div className="terminal" ref={host} aria-label="Haze terminal" title="Tap the terminal to type; use your device's paste to paste text into Haze." />
    {(() => { const worker = activeInstance?.subagents?.workers?.find(item => item.key === watchedWorker); return worker ? <SubagentOverlay worker={worker} output={workerOutput} onClose={() => selectWorker(undefined)} /> : null; })()}
    <footer>Encrypted terminal transport · Input never queued offline · Haze remains on your computer</footer>
    </section></div>
    </div>
  </main>;
}
