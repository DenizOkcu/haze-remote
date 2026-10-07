import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClientSession } from '../shared/session.js';
import { CONFIRM_MS, REVIEW_MS, PIN_MS, type DeviceCredential } from '../shared/crypto.js';
import { loadCredential, saveCredential, forgetCredential } from './credentials';
import { sendTerminalInput, type InputResult } from './input';
import { SubagentSidebar, SubagentOverlay } from './SubagentSidebar';
import type { FleetState, FleetRequest } from '../shared/fleet.js';
import type { WorkerOutput } from '../shared/observer.js';

type Status = 'Connecting' | 'Connected' | 'Reconnecting' | 'Already connected' | 'Exited' | 'Switching' | 'Stopping';
type FleetCommand = FleetRequest extends infer R ? R extends FleetRequest ? Omit<R, 'requestId'> : never : never;
const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
export function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<{ code?: string; stage: 'confirm' | 'review'; expiresAt: number }>();
  const [remaining, setRemaining] = useState(CONFIRM_MS / 1000);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [serverPaired, setServerPaired] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>('Connecting');
  const [project, setProject] = useState('');
  const [pid, setPid] = useState<number>();
  const [exitCode, setExitCode] = useState<number>();
  const [epoch, setEpoch] = useState(0);
  const [fleet, setFleet] = useState<FleetState>();
  const [activeId, setActiveId] = useState('');
  const [operation, setOperation] = useState<string>();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newProject, setNewProject] = useState('');
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
  const serverId = useRef('');
  const session = useRef<ClientSession | undefined>(undefined);
  const closed = useRef<((code: number) => void) | undefined>(undefined);
  const input = useRef<(data: string) => InputResult>(() => 'not-sent');
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
    const connection = new ClientSession(new WebSocket(`ws://${location.host}/ws`), {
      serverId: serverId.current, password, credential: remembered,
      onPending(code, _expiresAt, remainingMs) {
        setPending({ code, stage: 'confirm', expiresAt: Date.now() + Math.max(0, Math.min(CONFIRM_MS, remainingMs)) });
      },
      onReview(_expiresAt, remainingMs) {
        setPending({ stage: 'review', expiresAt: Date.now() + Math.max(0, Math.min(REVIEW_MS, remainingMs)) });
      },
      async onApproved(value) {
        credential.current = value;
        try { await saveCredential(value); }
        catch { setError('Cannot remember this device. This connection works, but reload will require local revocation and pairing again.'); }
        if (session.current !== connection || connection.socket.readyState !== WebSocket.OPEN) return;
        setPending(undefined); setBusy(false); setPaired(true);
      },
      onError(message) { if (session.current === connection) setError(message); },
      onClose(code) {
        if (session.current !== connection) return;
        session.current = undefined;
        if (closed.current) closed.current(code);
        else { setPending(undefined); setBusy(false); }
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
        const res = await fetch('/api/info');
        if (!res.ok) throw new Error('Cannot reach haze-remote');
        const info = await res.json();
        let stored: DeviceCredential | undefined;
        try { stored = await loadCredential(); } catch { /* Memory-only pairing still works. */ }
        if (cancelled) return;
        serverId.current = info.serverId;
        setPairingOpen(info.pairing.open); setServerPaired(info.paired);
        if (stored?.serverId === info.serverId && info.paired) { credential.current = stored; setPaired(true); }
        else { void forgetCredential().catch(() => {}); setPaired(false); }
      } catch { if (!cancelled) { setError('Cannot initialize encrypted connection. Check the computer and reload.'); setPaired(false); } }
    })();
    return () => { cancelled = true; session.current?.close(); };
  }, []);
  useEffect(() => {
    if (paired !== false || busy) return;
    const poll = setInterval(() => {
      void fetch('/api/info').then(r => r.json()).then(info => {
        serverId.current = info.serverId;
        setPairingOpen(info.pairing.open); setServerPaired(info.paired);
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(poll);
  }, [paired, busy]);
  useEffect(() => {
    if (!pending) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1000)));
    tick(); const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [pending]);

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
      const result = sendTerminalInput(data, ready && !processExited && session.current?.socket.readyState === WebSocket.OPEN,
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
      if (!ready || pendingOperation.current || session.current?.socket.readyState !== WebSocket.OPEN) return;
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
      void forgetCredential().catch(() => {}); setPending(undefined); setPaired(false);
      setProject(''); setPid(undefined); lastContact.current = undefined; setRetryAt(undefined);
      seen.current.clear(); display.current = { id: '', viewId: '' };
      setFleet(undefined); setActiveId(''); setShowCreate(false); setWatchedWorker(undefined); setWorkerOutput(undefined); finishOperation();
    };
    function attach(connection: ClientSession) {
      unsubscribe?.();
      unsubscribe = connection.subscribe(message => {
        if (disposed || session.current !== connection) return;
        lastContact.current = Date.now();
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
            if (disposed || session.current !== connection || display.current !== target || connection.socket.readyState !== WebSocket.OPEN) return;
            ready = true; attempt = 0; lastPong = Date.now(); setRetryAt(undefined);
            term.options.disableStdin = processExited; setStatus(processExited ? 'Exited' : 'Connected'); fitTerminal();
            if (focusSelectedTab) document.getElementById(`tab-${target.id}`)?.focus();
            else {
              // Startup and reconnect land the cursor in the terminal, but never steal it from a form field mid-entry.
              const active = document.activeElement;
              const inFormControl = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
              if (!inFormControl) term.focus();
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
      if (disposed || connecting || !reconnectAllowed || (session.current && session.current.socket.readyState !== WebSocket.CLOSED)) return;
      connecting = true; disconnectInput(); setRetryAt(undefined); setStatus(attempt ? 'Reconnecting' : 'Connecting');
      try {
        if (!credential.current) { dropCredential(); return; }
        const res = await fetch('/api/info', { signal: AbortSignal.timeout(10_000) }); if (!res.ok) throw new Error();
        const info = await res.json(); if (disposed) return;
        if (info.serverId !== credential.current.serverId || !info.paired) {
          setError(info.serverId !== credential.current.serverId
            ? 'The server restarted or changed. Approve this browser locally again.'
            : 'This device is no longer approved. On the computer, type pair to reopen pairing when no device is approved.');
          dropCredential(); return;
        }
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
      disconnectInput(); finishOperation();
      if (code === 4000) { reconnectAllowed = false; setStatus('Already connected'); return; }
      if (code === 4001 || code === 1008) { dropCredential(); return; }
      schedule();
    };
    retryNow.current = () => {
      if (disposed || !reconnectAllowed || connecting) return;
      clearTimeout(retry); void connect();
    };
    const heartbeat = setInterval(() => {
      if (session.current?.socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > 30_000) { session.current.close(); return; }
      if (ready) send({ type: 'ping' });
    }, 10_000);
    const wake = () => {
      if (document.visibilityState !== 'visible' || !reconnectAllowed || connecting) return;
      const socket = session.current?.socket;
      if (socket?.readyState === WebSocket.OPEN && Date.now() - lastPong > 30_000) session.current?.close();
      else if (!socket || socket.readyState === WebSocket.CLOSED) { clearTimeout(retry); void connect(); }
    };
    const offline = () => {
      if (disposed || !reconnectAllowed) return;
      // A WebSocket close handshake can stall while the browser is offline.
      // Do not advertise Connected or leave controls enabled until onclose fires.
      disconnectInput(); finishOperation(); setStatus('Reconnecting'); setRetryAt(undefined);
      session.current?.close();
    };
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake); window.addEventListener('offline', offline);
    if (session.current) attach(session.current); else void connect();
    return () => {
      disposed = true; closed.current = undefined; input.current = () => 'not-sent';
      retryNow.current = () => {}; fitCurrent.current = () => {}; fleetRequest.current = () => {}; finishOperation();
      clearTimeout(retry); clearInterval(heartbeat); unsubscribe?.();
      document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); window.removeEventListener('offline', offline);
      const old = session.current; session.current = undefined; old?.close();
      resize.disconnect(); dataListener.dispose(); term.dispose(); terminal.current = null;
    };
  }, [paired, epoch]);

  async function pair(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await ClientSession.ready(); openSession(code.trim()); setCode(''); }
    catch { setError('Cannot start encrypted pairing'); setBusy(false); }
  }
  function unpair() {
    if (!window.confirm('Unpair this browser? Haze keeps running, but remote access will end and pairing stays closed. To reconnect, type pair on the computer and approve locally again.')) return;
    try {
      if (!session.current?.send({ type: 'unpair' })) throw new Error('Not sent');
      credential.current = undefined; void forgetCredential().catch(() => {});
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
    <h1>Your terminal. Locally approved.</h1>
    {pending ? <>
      {pending.stage === 'confirm' ? <>
        <p>Enter this code B using the keyboard on the computer running haze-remote. You have two minutes; entering it starts a separate two-minute device review.</p>
        <div className="confirmation-code" aria-label="Code B">{remaining > 0 ? pending.code : 'Expired'}</div>
      </> : <p>Code B confirmed. Review the device information on the computer, then type <strong>approve</strong> or <strong>reject</strong>. Terminal access is still disabled.</p>}
      <p role="status">{pending.stage === 'confirm' ? 'Enter code B on computer' : 'Awaiting local approval'} · {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')} remaining</p>
    </> : <>
      <p>Enter the current PIN A from your computer. It rotates every {PIN_MS / 1000} seconds. No terminal access is granted until you also confirm on the computer.</p>
      {!pairingOpen && <p className="notice">{serverPaired ? 'A device is already paired. Revoke it locally before pairing another.' : 'Pairing closed. Type pair in the computer’s haze-remote terminal.'}</p>}
      <form onSubmit={pair}>
        <label htmlFor="code">PIN A</label>
        <input id="code" value={code} onChange={e => setCode(e.target.value)} placeholder="8 digits shown on the computer" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} autoComplete="off" required disabled={busy} />
        <button className="primary" type="submit" disabled={busy || !pairingOpen}>{busy ? 'Verifying PIN…' : 'Pair this browser'}</button>
      </form>
    </>}
    {busy && <button onClick={() => session.current?.close()}>Cancel pairing</button>}
    {error && <p role="alert" className="error">{error}</p>}
    <details className="readiness"><summary>Before pairing</summary><ul><li>Keep the computer awake and haze-remote running.</li><li>Use the printed address on a trusted private network.</li><li>Have the computer’s local terminal available for code B and approve.</li></ul></details>
    <p className="fine-print">Terminal transport is encrypted. The HTTP-delivered page can still be modified by an active network attacker. Pair only on trusted networks. Approval grants your computer’s permissions.</p>
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
    <div className="fleet-navigation">
      <nav className="fleet-tabs" role="tablist" aria-label="Haze instances">{fleet?.instances.map(instance => <button key={instance.id} role="tab" id={`tab-${instance.id}`} aria-controls="fleet-terminal" aria-selected={activeId === instance.id} tabIndex={activeId === instance.id ? 0 : -1} disabled={!canOperate || !!operation} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !fleet) return;
        event.preventDefault(); const index = fleet.instances.findIndex(item => item.id === instance.id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? fleet.instances.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + fleet.instances.length) % fleet.instances.length;
        const target = fleet.instances[next]; command({ type: 'instance-select', instanceId: target.id });
        document.getElementById(`tab-${target.id}`)?.focus();
      }} onClick={() => { if (instance.id !== activeId) command({ type: 'instance-select', instanceId: instance.id }); }}><strong>{instance.name}</strong><small>{instance.state}{instance.exit ? ` (${instance.exit.exitCode})` : ''}{instance.id !== activeId && (instance.lastActivity ?? 0) > (seen.current.get(instance.id) ?? instance.createdAt) ? ' · New output' : ''}</small></button>)}</nav>
      <button disabled={!canOperate || !!operation || !fleet || fleet.instances.length >= fleet.limit} onClick={() => { setNewName(`Haze ${(fleet?.instances.length ?? 0) + 1}`); setNewProject(activeInstance?.projectId ?? fleet?.projects[0]?.id ?? ''); setAllowShared(false); setShowCreate(true); }}>New instance</button>
      <button aria-expanded={sidebarOpen} aria-controls="subagent-panel" onClick={() => setSidebarOpen(open => !open)}>Subagents</button>
    </div>
    {showCreate && <section className="new-instance" aria-label="Create Haze instance"><form onSubmit={event => { event.preventDefault(); command({ type: 'instance-create', name: newName, projectId: newProject, allowShared: sharesCheckout && allowShared }); }}>
      <label>Instance name<input aria-label="Instance name" value={newName} onChange={event => setNewName(event.target.value)} maxLength={80} required disabled={!!operation} /></label>
      <label>Approved project<select aria-label="Approved project" value={newProject} onChange={event => { setNewProject(event.target.value); setAllowShared(false); }} disabled={!!operation}>{fleet?.projects.map(project => <option key={project.id} value={project.id}>{project.name} — {project.cwd}</option>)}</select></label>
      {sharesCheckout && <label className="check-row"><input type="checkbox" aria-label="Allow shared checkout" checked={allowShared} onChange={event => setAllowShared(event.target.checked)} disabled={!!operation} />Allow shared checkout. These instances can edit the same files; use separate locally approved worktrees for independent writers.</label>}
      <button className="primary" type="submit" disabled={!canOperate || !!operation || !newName.trim() || (sharesCheckout && !allowShared)}>{operation === 'instance-create' ? 'Starting…' : 'Start Haze'}</button><button type="button" disabled={!!operation} onClick={() => setShowCreate(false)}>Cancel</button>
    </form></section>}
    <div className={`fleet-shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
    <div id="subagent-panel" className="sidebar-container" hidden={!sidebarOpen}><SubagentSidebar instance={activeInstance} connected={canOperate} busy={!!operation} selectedKey={watchedWorker} output={workerOutput} onSelect={selectWorker} /></div>
    <section id="fleet-terminal" className="terminal-pane" role="tabpanel" aria-labelledby={activeId ? `tab-${activeId}` : undefined}>
    <div className="terminal-toolbar">
      <span className="window-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="terminal-title">{activeInstance?.name ?? 'Loading fleet…'}<small> · {fleet?.instances.filter(instance => instance.state === 'running').length ?? 0} running</small></span>
      <div className="toolbar-group" aria-label="Terminal readability"><button disabled={fontSize <= 12} onClick={() => setFontSize(size => Math.max(12, size - 2))} aria-label="Smaller terminal text">A−</button><span className="font-size">{fontSize}px</span><button disabled={fontSize >= 24} onClick={() => setFontSize(size => Math.min(24, size + 2))} aria-label="Larger terminal text">A+</button><button onClick={() => terminal.current?.scrollToBottom()}>Latest output</button></div>
      {activeInstance?.state === 'exited' ? <button disabled={!canOperate || !!operation || (fleet?.instances.length ?? 0) < 2} onClick={() => command({ type: 'instance-close', instanceId: activeId })}>Close tab</button> : <button className="danger" disabled={!canOperate || !!operation || activeInstance?.state !== 'running'} onClick={() => { if (window.confirm(`Stop ${activeInstance?.name}? Its Haze process will terminate. Other instances keep running. Recent output remains until you close this tab.`)) command({ type: 'instance-stop', instanceId: activeId }); }}>Stop instance</button>}
    </div>
    {status === 'Switching' && <p className="notice">Restoring instance screen. Input is disabled until its snapshot is ready.</p>}
    <div className="terminal" ref={host} aria-label="Haze terminal" title="Tap the terminal to type; use your device's paste to paste text into Haze." />
    {(() => { const worker = activeInstance?.subagents?.workers?.find(item => item.key === watchedWorker); return worker ? <SubagentOverlay worker={worker} output={workerOutput} onClose={() => selectWorker(undefined)} /> : null; })()}
    <footer>Encrypted terminal transport · Input never queued offline · Haze remains on your computer</footer>
    </section></div>
  </main>;
}
