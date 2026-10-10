import { useEffect, useRef, useState } from 'react';
import { SPEECH_DOWNLOAD_BYTES, SPEECH_MODEL, type SpeechStatus } from '../shared/speech.js';
import { SpeechCapture, encodeAudio } from './speech-audio';
import type { SpeechRpc } from './speech-rpc';
import type { InputResult } from './input';
import './speech.css';
import { MicrophoneHelp } from './MicrophoneHelp';
import { microphoneBlock, microphoneErrorBlock, type MicrophoneBlock } from './microphone-help';

type Target = { id: string; name: string };
type Phase = 'closed' | 'checking' | 'consent' | 'downloading' | 'preparing' | 'recording' | 'transcribing' | 'draft';
export function SpeechInput({ rpc, target, enabled, send }: {
  rpc: SpeechRpc; target: Target; enabled: boolean; send: (targetId: string, text: string) => InputResult;
}) {
  const [phase, setPhase] = useState<Phase>('closed');
  const [model, setModel] = useState<SpeechStatus>();
  const [destination, setDestination] = useState<Target>(target);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [uncertain, setUncertain] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [microphoneFailure, setMicrophoneFailure] = useState<MicrophoneBlock>();
  const capture = useRef<SpeechCapture | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const held = useRef(false);
  const overlayRecording = useRef(false);
  const phaseRef = useRef<Phase>('closed');
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  function transition(next: Phase) { phaseRef.current = next; setPhase(next); }
  function stopAudio() { held.current = false; capture.current?.cancel(); capture.current = undefined; }
  function close() {
    generation.current++; stopAudio(); controller.current?.abort(); controller.current = undefined;
    setDraft(''); setError(''); setUncertain(false); transition('closed'); button.current?.focus();
  }
  useEffect(() => () => { generation.current++; stopAudio(); controller.current?.abort(); }, []);
  useEffect(() => {
    let disposed = false;
    let permission: PermissionStatus | undefined;
    const update = () => {
      if (disposed || !permission) return;
      setPermissionDenied(permission.state === 'denied');
      if (permission.state === 'granted') setMicrophoneFailure(undefined);
    };
    void navigator.permissions?.query({ name: 'microphone' as PermissionName }).then(value => {
      if (disposed) return;
      permission = value; update(); permission.addEventListener('change', update);
    }).catch(() => { /* Some browsers do not expose microphone permission status. */ });
    return () => { disposed = true; permission?.removeEventListener('change', update); };
  }, []);

  useEffect(() => {
    const cancel = () => {
      if (['preparing', 'recording'].includes(phaseRef.current)) {
        generation.current++; stopAudio(); setError('Recording discarded because focus or connection was lost.'); transition('draft');
      }
    };
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', cancel); document.addEventListener('visibilitychange', hidden);
    if (!enabled) {
      cancel(); controller.current?.abort();
      if (['checking', 'transcribing'].includes(phaseRef.current)) {
        generation.current++; setError('Connection unavailable. Your text draft is preserved.'); transition('draft');
      }
      if (phaseRef.current === 'downloading') setError('Connection unavailable. An approved download continues on the host; reconnect to check progress.');
    }
    return () => { window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', hidden); };
  }, [enabled]);
  useEffect(() => {
    if (phase !== 'recording') return;
    setSeconds(0); const timer = setInterval(() => setSeconds(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    const modal = dialog.current;
    if (phase !== 'closed' && (!['preparing', 'recording'].includes(phase) || overlayRecording.current)) { if (!modal?.open) modal?.showModal(); }
    else modal?.close();
  }, [phase]);
  useEffect(() => {
    if (phase !== 'downloading' || !enabled) return;
    const abort = new AbortController();
    const current = generation.current;
    const refresh = () => {
      void rpc.request({ type: 'speech-status' }, abort.signal).then(response => {
        if (abort.signal.aborted || current !== generation.current) return;
        setModel(response.status); setError('');
        if (response.status.state === 'ready') transition('draft');
        else if (response.status.state === 'missing') {
          setError(response.status.error ?? 'Download stopped. Try again.'); transition('consent');
        }
      }).catch(() => {});
    };
    const poll = setInterval(refresh, 1000);
    return () => { clearInterval(poll); abort.abort(); };
  }, [phase, rpc, enabled]);
  async function start() {
    if (!enabled || ['checking', 'downloading', 'preparing', 'recording', 'transcribing'].includes(phaseRef.current)) return;
    held.current = true; setError(''); setNotice('');
    if (phaseRef.current === 'closed') { setDestination(target); setDraft(''); setUncertain(false); }
    const current = ++generation.current;
    if (model?.state !== 'ready') {
      transition('checking');
      try {
        const response = await rpc.request({ type: 'speech-status' });
        if (current !== generation.current) return;
        setModel(response.status);
        // A status round-trip loses the user gesture. Ask for a new press after setup.
        held.current = false; transition(response.status.state === 'ready' ? 'draft' : response.status.state === 'downloading' ? 'downloading' : 'consent');
      } catch (error) {
        if (current === generation.current) { held.current = false; setError((error as Error).message); transition('draft'); }
      }
      return;
    }
    overlayRecording.current = phaseRef.current === 'draft';
    const recording = new SpeechCapture(); capture.current = recording; transition('preparing');
    try {
      await recording.start(() => { void release(); });
      if (current !== generation.current || !held.current) { recording.cancel(); return; }
      setMicrophoneFailure(undefined); setPermissionDenied(false); transition('recording');
    } catch (error) {
      recording.cancel();
      if (current === generation.current) { stopAudio(); setMicrophoneFailure(microphoneErrorBlock(error)); setError((error as Error).message); transition('draft'); }
    }
  }
  async function release() {
    held.current = false;
    if (phaseRef.current === 'preparing') {
      generation.current++; stopAudio(); setError('Hold until the microphone is ready, then speak.'); transition('draft'); return;
    }
    if (phaseRef.current !== 'recording' || !capture.current) return;
    const current = generation.current;
    const recording = capture.current;
    transition('transcribing');
    const abort = new AbortController(); controller.current = abort;
    let audio: Uint8Array | undefined;
    try {
      audio = await recording.finish(); capture.current = undefined;
      if (current !== generation.current) return;
      const pending = rpc.request({ type: 'speech-transcribe', audio: encodeAudio(audio) }, abort.signal);
      audio.fill(0); audio = undefined;
      const response = await pending;
      if (current !== generation.current) return;
      const text = response.text?.trim();
      if (!text) setError('No speech recognized. Hold to record again.');
      else setDraft(previous => previous ? `${previous}\n${text}` : text);
      transition('draft');
    } catch (error) {
      if (current === generation.current) { setError((error as Error).message); transition('draft'); }
    } finally { audio?.fill(0); recording.cancel(); }
  }
  async function download() {
    const current = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    setError(''); transition('downloading');
    try {
      const response = await rpc.request({ type: 'speech-download' }, abort.signal);
      if (current !== generation.current) return;
      setModel(response.status);
      if (response.status.state === 'ready') transition('draft');
      else if (response.status.state === 'missing') { setError(response.status.error ?? 'Download could not start. Try again.'); transition('consent'); }
    } catch (error) {
      if (current === generation.current) setError(`${(error as Error).message} Reconnect to check download status; nothing will restart automatically.`);
    }
  }
  async function cancelDownload() {
    const current = ++generation.current; controller.current?.abort(); transition('checking');
    try {
      const response = await rpc.request({ type: 'speech-download-cancel' });
      if (current !== generation.current) return;
      setModel(response.status); setError(''); transition(response.status.state === 'ready' ? 'draft' : 'consent');
    } catch (error) { if (current === generation.current) { setError((error as Error).message); transition('downloading'); } }
  }
  const hold = {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); void start();
    },
    onPointerUp: () => { void release(); },
    onPointerCancel: () => { if (['preparing', 'recording'].includes(phaseRef.current)) { generation.current++; stopAudio(); setError('Recording cancelled.'); transition('draft'); } },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (![' ', 'Enter'].includes(event.key)) return;
      event.preventDefault(); if (!event.repeat) void start();
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLButtonElement>) => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); void release(); } },
  };
  const recording = phase === 'preparing' || phase === 'recording';
  const blocked = microphoneBlock(window.isSecureContext, !!navigator.mediaDevices?.getUserMedia, permissionDenied) ?? microphoneFailure;
  return <>
    <button ref={button} className={`ptt-button ${recording ? 'recording' : ''}`} disabled={!enabled && phase === 'closed'} {...hold} onClick={() => { if (phaseRef.current === 'closed') void start(); }} aria-label="Push to talk">{phase === 'preparing' ? 'Starting microphone… keep holding' : recording ? `Release to transcribe · ${seconds}s / 30s` : 'Hold to talk'}</button>
    {recording && <button onClick={close}>Cancel recording</button>}
    {notice && <span className="speech-notice" role="status">{notice}</span>}
    <dialog ref={dialog} className="speech-dialog" aria-labelledby="speech-title" onCancel={event => { event.preventDefault(); close(); }}>
      <h2 id="speech-title">Voice input · {destination.name}</h2>
      {phase === 'checking' && <p>Checking the local speech service…</p>}
      {phase === 'consent' && <>
        <p>Download {SPEECH_MODEL} to the computer running haze-remote?</p>
        <p>Approximately {Math.round(SPEECH_DOWNLOAD_BYTES / 1_000_000)} MB from Hugging Face, plus runtime memory. Only model files are cached. Recordings stay in memory and are discarded after transcription, Send, or Cancel. Audio is never uploaded to a cloud transcription provider.</p>
        <button className="primary" disabled={!enabled} onClick={() => void download()}>Download Parakeet</button>
      </>}
      {phase === 'downloading' && <><p>Downloading Parakeet… {Math.round((model?.downloadedBytes ?? 0) / 1_000_000)} / {Math.round(SPEECH_DOWNLOAD_BYTES / 1_000_000)} MB</p><progress max={SPEECH_DOWNLOAD_BYTES} value={model?.downloadedBytes ?? 0} /><p>The download continues on the host if you close or restart this browser.</p><button disabled={!enabled} onClick={() => void cancelDownload()}>Cancel download</button></>}
      {phase === 'transcribing' && <p>Transcribing locally… Audio is discarded when transcription finishes.</p>}
      {(phase === 'draft' || (recording && overlayRecording.current)) && <>
        <label htmlFor="speech-draft">Review and edit your message</label>
        <textarea id="speech-draft" value={draft} onChange={event => setDraft(event.target.value)} rows={7} maxLength={8000} disabled={recording} autoFocus />
        <p>Send pastes this text and presses Enter in {destination.name}. Check that Haze is at the intended prompt. Releasing the microphone never sends.</p>
        {model?.state === 'ready' ? <button className={`ptt-button ${recording ? 'recording' : ''}`} disabled={!enabled || destination.id !== target.id} {...hold}>{phase === 'preparing' ? 'Starting microphone… keep holding' : recording ? `Release to transcribe · ${seconds}s / 30s` : `Hold to record${draft ? ' more' : ''}`}</button> : <button disabled={!enabled} onClick={() => { void start(); }}>Set up speech</button>}
        <button className="primary" disabled={phase !== 'draft' || !enabled || destination.id !== target.id || !draft.trim() || uncertain} onClick={() => {
          stopAudio(); controller.current?.abort();
          const result = send(destination.id, draft);
          if (result === 'queued') { close(); setNotice('Sent to terminal; model processing is not acknowledged.'); }
          else { setUncertain(result === 'partial'); setError(result === 'partial' ? 'Delivery is uncertain. Inspect Haze before sending again; nothing is retried automatically.' : result === 'too-large' ? 'Message is too large. Shorten it and retry.' : 'Not sent. Reconnect or select the original instance, then retry.'); }
        }}>Send to Haze</button>
        {destination.id !== target.id && <p className="error">Select {destination.name} again before sending this draft.</p>}
        {uncertain && <button onClick={() => { setUncertain(false); setError(''); }}>I checked Haze; allow another send</button>}
      </>}
      {blocked && !recording && <MicrophoneHelp block={blocked} />}
      {error && <p className="error" role="alert">{error}</p>}
      <button onClick={close}>{phase === 'downloading' ? 'Close' : 'Cancel'}</button>
    </dialog>
  </>;
}
