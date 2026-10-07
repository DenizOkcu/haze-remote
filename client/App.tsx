import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClientSession } from '../shared/session.js';
import type { DeviceCredential } from '../shared/crypto.js';
import { loadCredential, saveCredential, forgetCredential } from './credentials';

type Status = 'Connecting' | 'Connected' | 'Reconnecting' | 'Already connected' | 'Exited';
export function App() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<{ code: string; expiresAt: number }>();
  const [remaining, setRemaining] = useState(20);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [serverPaired, setServerPaired] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>('Connecting');
  const [project, setProject] = useState('');
  const [pid, setPid] = useState<number>();
  const [exitCode, setExitCode] = useState<number>();
  const [epoch, setEpoch] = useState(0);
  const [draft, setDraft] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const credential = useRef<DeviceCredential | undefined>(undefined);
  const serverId = useRef('');
  const session = useRef<ClientSession | undefined>(undefined);
  const closed = useRef<((code: number) => void) | undefined>(undefined);
  const input = useRef<(data: string) => boolean>(() => false);

  function openSession(password: string, remembered?: DeviceCredential) {
    const connection = new ClientSession(new WebSocket(`ws://${location.host}/ws`), {
      serverId: serverId.current, password, credential: remembered,
      onPending(code, expiresAt) {
        setPending({ code, expiresAt: Math.min(Date.now() + 20_000, expiresAt) });
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
    const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 2000, disableStdin: true,
      theme: { background: '#11151b', foreground: '#e5eaf0', cursor: '#a5dcc9', selectionBackground: '#354e59' },
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); terminal.current = term;
    const send = (message: unknown) => session.current?.send(message) ?? false;
    input.current = data => {
      if (!ready || processExited || session.current?.socket.readyState !== WebSocket.OPEN || session.current.socket.bufferedAmount > 256 * 1024) return false;
      if (new TextEncoder().encode(data).byteLength > 64 * 1024) { setError('Paste is too large (64 KiB maximum). Split it into smaller pieces.'); return false; }
      const characters = Array.from(data);
      for (let i = 0; i < characters.length; i += 4096) if (!send({ type: 'input', data: characters.slice(i, i + 4096).join('') })) return false;
      return true;
    };
    const fitTerminal = () => {
      if (!ready) return;
      const dimensions = fit.proposeDimensions(); if (!dimensions) return;
      const cols = Math.min(240, Math.max(20, dimensions.cols)), rows = Math.min(100, Math.max(5, dimensions.rows));
      term.resize(cols, rows); if (!processExited) send({ type: 'resize', cols, rows });
    };
    const resize = new ResizeObserver(fitTerminal); resize.observe(host.current);
    const dataListener = term.onData(data => { input.current(data); });
    const disconnectInput = () => { ready = false; term.options.disableStdin = true; };
    const dropCredential = () => {
      reconnectAllowed = false; credential.current = undefined;
      void forgetCredential().catch(() => {}); setPending(undefined); setPaired(false);
    };
    function attach(connection: ClientSession) {
      unsubscribe?.();
      unsubscribe = connection.subscribe(message => {
        if (disposed || session.current !== connection) return;
        if (message.type === 'snapshot') {
          term.reset(); term.resize(message.cols, message.rows);
          setProject(message.cwd); setPid(message.pid);
          processExited = message.exit !== null; setExitCode(message.exit?.exitCode);
          term.write(message.data, () => {
            if (disposed || session.current !== connection || connection.socket.readyState !== WebSocket.OPEN) return;
            ready = true; attempt = 0; lastPong = Date.now();
            term.options.disableStdin = processExited; setStatus(processExited ? 'Exited' : 'Connected'); fitTerminal();
          });
        } else if (message.type === 'output') term.write(message.data);
        else if (message.type === 'exit') { processExited = true; term.options.disableStdin = true; setExitCode(message.exitCode); setStatus('Exited'); }
        else if (message.type === 'pong') lastPong = Date.now();
      });
    }
    async function connect() {
      if (disposed || connecting || !reconnectAllowed) return;
      connecting = true; disconnectInput(); setStatus(attempt ? 'Reconnecting' : 'Connecting');
      try {
        if (!credential.current) { dropCredential(); return; }
        const res = await fetch('/api/info'); if (!res.ok) throw new Error();
        const info = await res.json(); if (disposed) return;
        if (info.serverId !== credential.current.serverId || !info.paired) { dropCredential(); return; }
        attach(openSession(credential.current.password, credential.current));
      } catch { if (!disposed) schedule(); }
      finally { connecting = false; }
    }
    function schedule() {
      if (disposed || !reconnectAllowed) return;
      setStatus('Reconnecting'); clearTimeout(retry);
      retry = setTimeout(() => { void connect(); }, Math.min(8000, 500 * 2 ** Math.min(attempt++, 4)));
    }
    closed.current = code => {
      if (disposed) return;
      disconnectInput();
      if (code === 4000) { reconnectAllowed = false; setStatus('Already connected'); return; }
      if (code === 4001 || code === 1008) { dropCredential(); return; }
      schedule();
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
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake);
    if (session.current) attach(session.current); else void connect();
    return () => {
      disposed = true; closed.current = undefined; input.current = () => false;
      clearTimeout(retry); clearInterval(heartbeat); unsubscribe?.();
      document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake);
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
    if (!session.current?.send({ type: 'unpair' })) { setError('Reconnect or revoke locally on the computer before unpairing.'); return; }
    credential.current = undefined; void forgetCredential().catch(() => {});
  }
  const connected = status === 'Connected';
  const key = (data: string) => { if (input.current(data)) terminal.current?.focus(); };
  const submitDraft = (event: FormEvent) => {
    event.preventDefault(); if (!connected || !draft) return;
    if (new TextEncoder().encode(draft).byteLength > 64 * 1024 - 32) { setError('Paste is too large (64 KiB maximum). Split it into smaller pieces.'); return; }
    setError(''); terminal.current?.paste(draft); setDraft(''); terminal.current?.focus();
  };
  if (paired === null) return <main className="pair-screen"><p role="status">Initializing encrypted connection…</p></main>;
  if (!paired) return <main className="pair-screen"><section className="pair-card">
    <div className="wordmark">haze<span> / remote</span></div>
    <h1>Your terminal. Locally approved.</h1>
    {pending ? <>
      <p>Enter this code B using the keyboard on the computer running haze-remote, review the device there, then type <strong>approve</strong>.</p>
      <div className="confirmation-code" aria-label="Code B">{remaining > 0 ? pending.code : 'Expired'}</div>
      <p role="status">Awaiting local approval · {remaining}s remaining</p>
    </> : <>
      <p>Enter the current PIN A from your computer. It rotates every 20 seconds. No terminal access is granted until you also confirm on the computer.</p>
      {!pairingOpen && <p className="notice">{serverPaired ? 'A device is already paired. Revoke it locally before pairing another.' : 'Pairing closed. Type pair in the computer’s haze-remote terminal.'}</p>}
      <form onSubmit={pair}>
        <label htmlFor="code">PIN A</label>
        <input id="code" value={code} onChange={e => setCode(e.target.value)} placeholder="8 digits shown on the computer" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} autoComplete="off" required disabled={busy} />
        <button className="primary" type="submit" disabled={busy || !pairingOpen}>{busy ? 'Verifying PIN…' : 'Pair this browser'}</button>
      </form>
    </>}
    {busy && <button onClick={() => session.current?.close()}>Cancel pairing</button>}
    {error && <p role="alert" className="error">{error}</p>}
    <p className="fine-print">Terminal transport is encrypted. The HTTP-delivered page can still be modified by an active network attacker. Pair only on trusted networks. Approval grants your computer’s permissions.</p>
  </section></main>;
  return <main className="workspace">
    <header><div className="wordmark">haze<span> / remote</span></div><div className={`status ${connected ? 'live' : ''}`} role="status">{status}{status === 'Exited' ? ` (${exitCode ?? '?'})` : ''}</div><button onClick={unpair}>Unpair</button></header>
    <div className="session-meta"><span title={project}>{project || 'Authenticating approved device…'}</span><span>{pid ? `PID ${pid}` : 'PTY'}</span></div>
    {status === 'Already connected' && <div className="notice">This device is connected in another tab. Close that tab first. <button onClick={() => setEpoch(e => e + 1)}>Reconnect</button></div>}
    {status === 'Reconnecting' && <div className="notice">Connection lost. Haze keeps running. Re-authenticating and reconnecting…</div>}
    {status === 'Exited' && <div className="notice">Haze exited. Recent output is available until haze-remote stops.</div>}
    {error && <div className="error" role="alert">{error}</div>}
    <div className="terminal" ref={host} aria-label="Haze terminal" />
    <nav className="keys" aria-label="Terminal keys"><button disabled={!connected} onClick={() => terminal.current?.focus()}>Keyboard</button>
      {([['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Enter', '\r'], ['Ctrl+C', '\x03']] as const).map(([label, data]) => <button key={label} disabled={!connected} aria-label={label} onClick={() => key(data)}>{label}</button>)}
    </nav>
    <form className="composer" onSubmit={submitDraft}><textarea aria-label="Message to Haze" placeholder="Write a prompt, paste it, then tap Enter to submit…" value={draft} onChange={e => setDraft(e.target.value)} rows={2} autoCapitalize="none" spellCheck={false} /><button className="primary" disabled={!connected || !draft} type="submit">Paste</button></form>
    <footer>Encrypted terminal transport · Input never queued offline · Haze remains on your computer</footer>
  </main>;
}
