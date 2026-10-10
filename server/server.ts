import { randomUUID } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { AccessController, type RemoteSocket } from './access.js';
import { startLanPeer } from './webrtc.js';
import { selectLanInterface, type LanSelection } from './lan.js';
import { AudioRecording } from './rtc-audio.js';
import { UI_ORIGIN } from '../shared/signaling.js';
import type { DeviceReview } from './pairing.js';
import { FleetManager } from './fleet.js';
import { isFleetRequest, type FleetProject } from '../shared/fleet.js';
import { isSkillRequest } from '../shared/skills.js';
import { SkillManager } from './skills.js';
import { isManagementRequest } from '../shared/configuration.js';
import { ConfigurationManager } from './configuration.js';
import { SessionCatalog } from './sessions.js';
import { SpeechService, type SpeechBackend } from './speech.js';
import { isSpeechRequest } from '../shared/speech.js';

export interface RemoteOptions {
  lan: LanSelection; cwd: string; executable: string; args: string[];
  signalingOrigin?: string;
  /** In-process test transport injection; never exposed by the CLI. */
  peerFactory?: typeof startLanPeer;
  onError?: (message: string) => void;
  newArgs?: string[];
  speech?: SpeechBackend;

  projects?: { name: string; cwd: string }[];
  // Tests use isolated HOME. Production inherits the Haze environment unchanged.
  env?: Record<string, string>;
  onPin?: (pin: { pin: string; expiresAt: number } | null) => void;
  onPending?: (review: DeviceReview) => void;
}
export async function startRemote(options: RemoteOptions) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('macOS and Linux are supported.');
  if (!options.peerFactory) selectLanInterface({ address: options.lan.address, subnet: options.lan.subnet, interfaceName: options.lan.interfaceName });
  const projects: FleetProject[] = [];
  for (const project of [{ cwd: options.cwd, name: basename(resolve(options.cwd)) || 'Project' }, ...(options.projects ?? [])]) {
    const cwd = await realpath(resolve(project.cwd));
    if (!(await stat(cwd)).isDirectory()) throw new Error('Working directory is not a directory.');
    if (!project.name.trim() || project.name.length > 80 || /[\x00-\x1f\x7f]/.test(project.name)) throw new Error('Project names must be printable and at most 80 characters.');
    if (!projects.some(existing => existing.cwd === cwd)) projects.push({ id: `project-${projects.length + 1}`, name: project.name, cwd });
  }
  if (projects.length > 16) throw new Error('At most 16 locally approved projects are supported.');
  await AccessController.ready();
  let stopped = false, alive = true;
  const recording = new AudioRecording();
  let peer: Awaited<ReturnType<typeof startLanPeer>> | undefined;
  let resetting = false;
  let fleet: FleetManager;
  let primaryId = '', lastSelectedId = '';
  let selection: { id: string; viewId: string; ws: RemoteSocket; ready: boolean } | undefined;
  const creations = new Map<string, Promise<string>>();
  const speech = options.speech ?? new SpeechService(options.env?.HOME);
  const speechJobs = new Map<RemoteSocket, { id: string; controller: AbortController }>();
  const recordingStarts = new Map<RemoteSocket, string>();
  let modelDownload: { controller: AbortController; done: Promise<void> } | undefined;
  let modelDownloadError: string | undefined;
  const speechStatus = async () => ({ ...await speech.status(), ...(modelDownloadError ? { error: modelDownloadError } : {}) });
  const skills = new SkillManager(projects, options.env?.HOME);
  const configuration = new ConfigurationManager(options.env?.HOME);
  const sessions = new SessionCatalog(projects, options.env?.HOME);
  const access = new AccessController<RemoteSocket>({ requireBinding: true, onPin: options.onPin, onPending: options.onPending,
    onAuthenticated(ws) {
      alive = true;
      void show(ws, fleet.get(lastSelectedId) ? lastSelectedId : fleet.first()!.id).catch(() => { if (access.isActive(ws)) ws.close(1011, 'Snapshot unavailable'); });
    },
    onMessage(message, ws) {
      if (message?.type === 'ping') { send(ws, { type: 'pong' }); return; }
      if (typeof message?.type === 'string' && message.type.startsWith('speech-')) {
        if (!isSpeechRequest(message)) { send(ws, { type: 'speech-error', requestId: message.requestId, message: 'Invalid speech request.' }); return; }
        if (message.type === 'speech-cancel') {
          if (recordingStarts.get(ws) === message.targetRequestId) recordingStarts.delete(ws);
          recording.cancel(message.targetRequestId);
          const job = speechJobs.get(ws);
          if (job?.id === message.targetRequestId) job.controller.abort();
          return;
        }
        if (message.type === 'speech-download' || message.type === 'speech-download-cancel') {
          void (async () => {
            if (message.type === 'speech-download-cancel') {
              const job = modelDownload;
              job?.controller.abort(); await job?.done;
              modelDownloadError = undefined;
            } else if (!modelDownload) {
              // Once approved, downloading belongs to the host, not a browser socket.
              modelDownloadError = undefined;
              const job = { controller: new AbortController(), done: Promise.resolve() };
              modelDownload = job;
              job.done = speech.download(job.controller.signal).catch(error => {
                if (!job.controller.signal.aborted) modelDownloadError = error instanceof Error && !('code' in error)
                  ? error.message.slice(0, 240) : 'Model download failed. Check internet access and retry.';
              }).finally(() => { if (modelDownload === job) modelDownload = undefined; });
            }
            const status = await speechStatus();
            if (access.isActive(ws)) send(ws, { type: 'speech-result', requestId: message.requestId, status });
          })().catch(() => { if (access.isActive(ws)) send(ws, { type: 'speech-error', requestId: message.requestId, message: 'Speech service unavailable.' }); });
          return;
        }
        if (message.type === 'speech-status') {
          void speechStatus().then(status => { if (access.isActive(ws)) send(ws, { type: 'speech-result', requestId: message.requestId, status }); })
            .catch(() => { if (access.isActive(ws)) send(ws, { type: 'speech-error', requestId: message.requestId, message: 'Speech service unavailable.' }); });
          return;
        }
        if (message.type === 'speech-record-start') {
          if (speechJobs.has(ws)) { send(ws, { type: 'speech-error', requestId: message.requestId, message: 'A speech operation is already running.' }); return; }
          if (recordingStarts.has(ws)) { send(ws, { type: 'speech-error', requestId: message.requestId, message: 'A recording is being prepared.' }); return; }
          recordingStarts.set(ws, message.requestId);
          void speechStatus().then(status => {
            if (!access.isActive(ws) || recordingStarts.get(ws) !== message.requestId) return;
            recordingStarts.delete(ws);
            if (status.state !== 'ready') { send(ws, { type: 'speech-error', requestId: message.requestId, message: 'Download the speech model first.' }); return; }
            try { recording.start(message.requestId); send(ws, { type: 'speech-result', requestId: message.requestId, status }); }
            catch { send(ws, { type: 'speech-error', requestId: message.requestId, message: 'A recording is already running.' }); }
          }).catch(() => {
            if (recordingStarts.get(ws) === message.requestId) recordingStarts.delete(ws);
            if (access.isActive(ws)) send(ws, { type: 'speech-error', requestId: message.requestId, message: 'Speech service unavailable.' });
          });
          return;
        }
        if (speechJobs.has(ws)) { send(ws, { type: 'speech-error', requestId: message.requestId, message: 'A speech operation is already running.' }); return; }
        const job = { id: message.requestId, controller: new AbortController() }; speechJobs.set(ws, job);
        void (async () => {
          try {
            let text: string | undefined;
            const samples = recording.finish(message.requestId);
            const audio = Buffer.alloc(samples.length * 2);
            try {
              for (let i = 0; i < samples.length; i++) audio.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), i * 2);
              samples.fill(0);
              text = await speech.transcribe(audio, job.controller.signal);
            } finally { samples.fill(0); audio.fill(0); }
            if (!job.controller.signal.aborted && access.isActive(ws)) send(ws, { type: 'speech-result', requestId: message.requestId, status: await speech.status(), ...(text !== undefined ? { text } : {}) });
          } catch (error) {
            if (!job.controller.signal.aborted && access.isActive(ws)) send(ws, { type: 'speech-error', requestId: message.requestId,
              message: error instanceof Error && !('code' in error) ? error.message.slice(0, 240) : 'Speech operation failed. Retry when the service is available.' });
          } finally { if (speechJobs.get(ws) === job) speechJobs.delete(ws); }
        })();
        return;
      }
      if (message?.type === 'input' || message?.type === 'resize') {
        const id = message.instanceId ?? primaryId;
        if (message.type === 'input' && (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 16 * 1024)) throw new Error('Invalid input');
        if (message.type === 'resize' && (!Number.isInteger(message.cols) || !Number.isInteger(message.rows) || message.cols < 20 || message.cols > 240 || message.rows < 5 || message.rows > 100)) throw new Error('Invalid resize');
        // Legacy clients without IDs only control the initial instance. Modern
        // input/resize requires the exact snapshot's view token, never a tab index.
        if (!selection?.ready || selection.ws !== ws || selection.id !== id || (message.instanceId !== undefined && selection.viewId !== message.viewId)) {
          send(ws, { type: 'fleet-error', message: 'Instance selection changed. Wait for its snapshot before sending input.' }); return;
        }
        if (message.type === 'input') {
          if (!fleet.input(id, message.data)) send(ws, { type: 'fleet-error', message: 'This Haze instance has stopped. Select or start a running instance.' });
        } else fleet.resize(id, message.cols, message.rows);
        return;
      }
      if (typeof message?.type === 'string' && /^(skills-|skill-)/.test(message.type)) {
        if (!isSkillRequest(message)) { send(ws, { type: 'skills-error', requestId: message.requestId, message: 'Invalid skill request.' }); return; }
        void skills.execute(message, () => access.isActive(ws)).then(result => {
          if (access.isActive(ws)) send(ws, { type: 'skills-result', requestId: message.requestId, ...result });
        }).catch(error => {
          const detail = error instanceof Error && !('code' in error) ? error.message : 'Skill operation failed. Check the skill directory and try again.';
          if (access.isActive(ws)) send(ws, { type: 'skills-error', requestId: message.requestId, message: detail.slice(0, 240) });
        });
        return;
      }
      if (typeof message?.type === 'string' && /^(configuration-|provider-|settings-|sessions-)/.test(message.type)) {
        if (!isManagementRequest(message)) { send(ws, { type: 'management-error', requestId: message.requestId, message: 'Invalid configuration request.' }); return; }
        void (message.type === 'sessions-list'
          ? sessions.list(projects.find(project => project.id === message.projectId)!).catch(() => ({ sessions: [], warnings: ['Session history is unavailable.'], canFork: false }))
            .then(result => { if (access.isActive(ws)) send(ws, { type: 'sessions-result', requestId: message.requestId, ...result }); })
          : configuration.execute(message, () => access.isActive(ws))
            .then(configurationResult => { if (access.isActive(ws)) send(ws, { type: 'configuration-result', requestId: message.requestId, configuration: configurationResult }); })
            .catch(error => {
              const detail = error instanceof Error && !('code' in error) ? error.message : 'Configuration operation failed. Check the settings file and try again.';
              if (access.isActive(ws)) send(ws, { type: 'management-error', requestId: message.requestId, message: detail.slice(0, 240) });
            }));
        return;
      }
      if (!isFleetRequest(message)) throw new Error('Invalid fleet message');
      void (async () => {
        try {
          if (message.type === 'instance-select') { await show(ws, message.instanceId, message.requestId); return; }
          if (message.type === 'instance-create') {
            let creation = creations.get(message.requestId);
            if (!creation) {
              // Never evict pending/successful IDs: an old retry must not spawn
              // another process. Failed launches have no side effect to dedupe.
              if (creations.size >= 256) throw new Error('Launch request history is full. Restart haze-remote before starting more instances.');
              creation = fleet.create(message.name.trim(), message.projectId, message.allowShared, false, () => access.isActive(ws),
                message.launch?.mode === 'resume' ? { mode: 'resume', sessionId: message.launch.sessionId } : { mode: 'fresh' }).then(instance => instance.id).catch(error => {
                creations.delete(message.requestId); throw error;
              });
              creations.set(message.requestId, creation);
            }
            const id = await creation;
            if (access.isActive(ws)) await show(ws, id, message.requestId);
            return;
          }
          if (!fleet.get(message.instanceId)) throw new Error('Instance no longer exists.');
          if (message.type === 'instance-stop') await fleet.stop(message.instanceId);
          else if (message.type === 'instance-close') {
            fleet.remove(message.instanceId);
            if (selection?.id === message.instanceId) await show(ws, fleet.first()!.id);
          } else if (message.type === 'worker-watch') fleet.watch(message.instanceId, message.workerKey!);
          else fleet.unwatch(message.instanceId);
          if (access.isActive(ws)) send(ws, { type: 'fleet-result', requestId: message.requestId });
        } catch (error) {
          if (access.isActive(ws)) send(ws, { type: 'fleet-error', requestId: message.requestId,
            message: (error instanceof Error ? error.message : 'Fleet operation failed.').slice(0, 240) });
        }
      })();
    },
  });
  function send(ws: RemoteSocket | undefined, message: unknown) { access.send(ws, message); }
  async function show(ws: RemoteSocket, id: string, requestId?: string) {
    if (!fleet.get(id)) throw new Error('Instance no longer exists.');
    const next = { id, viewId: randomUUID(), ws, ready: false };
    selection = next; lastSelectedId = id;
    const snapshot = await fleet.snapshot(id);
    if (stopped || !access.isActive(ws) || selection !== next) return;
    send(ws, { type: 'snapshot', ...snapshot, instanceId: id, viewId: next.viewId, requestId,
      capabilities: { fleet: 1, subagents: 'observed-v1' }, fleet: fleet.state() });
    next.ready = true;
  }
  fleet = new FleetManager({ executable: options.executable, args: options.args, newArgs: options.newArgs ?? [], projects, env: options.env,
    isViewed: id => !!selection?.ready && selection.id === id && access.isActive(selection.ws),
    onEvent(message) {
      if (!selection?.ready || !access.isActive(selection.ws)) return;
      if (message.type === 'fleet') send(selection.ws, message);
      else if (message.instanceId === selection.id) send(selection.ws, message.type === 'subagent-output' ? { ...message } : { ...message, viewId: selection.viewId });
    },
  });
  let initial;
  try { initial = await fleet.create('Haze 1', projects[0].id, true, true); primaryId = lastSelectedId = initial.id; }
  catch (error) { await fleet.close(); access.dispose(); speech.close(); throw error; }
  try {
    peer = await (options.peerFactory ?? startLanPeer)({ lan: options.lan, roomId: access.gate.serverId, signalingOrigin: options.signalingOrigin,
      onError: options.onError,
      onSocket(ws, metadata) {
        if (stopped) { ws.close(); return; }
        ws.on('close', () => {
          recording.cancel(); recordingStarts.delete(ws); speechJobs.get(ws)?.controller.abort(); speechJobs.delete(ws);
          // The native peer owns serialized disconnect recovery; Haze stays alive.
        });
        access.attach(ws, { ...metadata, autoApprove: true, requireBinding: true });
        ws.on('pong', () => { if (access.isActive(ws)) alive = true; });
      },
      onAudio(payload) {
        const active = access.active();
        if (!active || !access.isActive(active) || !recording.activeId()) return;
        const id = recording.activeId();
        try { recording.append(payload); }
        catch { send(active, { type: 'speech-error', requestId: id, message: 'Recording exceeded its limit. Record again.' }); }
      },
    });
  } catch (error) { await fleet.close(); access.dispose(); speech.close(); throw error; }
  async function resetPeer() {
    if (stopped || resetting) return;
    resetting = true;
    try { await peer?.resetPeer(); } finally { resetting = false; }
  }
  const lifecycle = setInterval(() => access.tick(), 250);
  const heartbeat = setInterval(() => {
    const active = access.active(); if (!active) return;
    if (!alive) { active.terminate(); return; } alive = false; active.ping();
  }, 15_000);
  lifecycle.unref(); heartbeat.unref();
  let closing: Promise<void> | undefined;
  function close() {
    if (closing) return closing;
    stopped = true; recording.cancel(); recordingStarts.clear(); modelDownload?.controller.abort(); speech.close(); for (const job of speechJobs.values()) job.controller.abort(); speechJobs.clear(); clearInterval(heartbeat); clearInterval(lifecycle); access.dispose();
    closing = (async () => { await peer?.close(); await fleet.close(); })();
    return closing;
  }
  return { serverId: access.gate.serverId, pid: initial.pid, instanceId: initial.id, close, exited: fleet.exited(initial.id),
    pairingUrl: () => { const value = access.gate.localPin(); return value ? `${UI_ORIGIN}/remote/#room=${access.gate.serverId}&secret=${value.pin}` : undefined; },
    local: { pin: () => access.gate.localPin(),
      pair: async () => { access.openPairing(); await resetPeer(); },
      cancel: async () => { access.gate.close(); await resetPeer(); },
      revoke: async () => { access.revoke(); await resetPeer(); } } };
}
