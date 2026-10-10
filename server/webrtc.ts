import { EventEmitter } from 'node:events';
import { RTCPeerConnection, RTCRtpCodecParameters, type RTCDataChannel } from 'werift';
import { SignalingClient } from '../shared/signaling.js';
import { encodeFrames, Framer, RTC_WIRE_LIMIT } from '../shared/rtc-framing.js';
import { validateIceCandidate, validateSelectedRemotePath, type LanSelection } from './lan.js';
import type { AttachMetadata, RemoteSocket } from './access.js';

export interface LanPeerOptions {
  lan: LanSelection;
  roomId: string;
  signalingOrigin?: string;
  onSocket(socket: RemoteSocket, metadata: AttachMetadata): void;
  /** Raw PCMU (G.711 mu-law), 8kHz mono RTP payload, not PCM samples. */
  onAudio?(payload: Buffer): void;
  onError?(message: string): void;
}

/** Reject conflicting, non-SHA256, malformed or absent description bindings. */
export function descriptionFingerprint(sdp: string): string {
  const lines = sdp.split(/\r?\n/).filter(line => /^a=fingerprint:/i.test(line));
  if (!lines.length) throw new Error('DTLS fingerprint required');
  const values = lines.map(line => {
    const match = /^a=fingerprint:sha-256 ((?:[a-f0-9]{2}:){31}[a-f0-9]{2})$/i.exec(line);
    if (!match) throw new Error('SHA256 DTLS fingerprint required');
    return match[1].toUpperCase();
  });
  if (new Set(values).size !== 1) throw new Error('Conflicting DTLS fingerprints');
  return values[0];
}

/** ICE-lite pairing strategy: the native peer advertises its own numeric host
 *  candidate in the offer; the browser connects TO it, so remote .local mDNS
 *  candidates never need resolution and are simply ignored. Network membership is
 *  proven by the actual selected pair's source address, which must be a permitted
 *  LAN peer before any authentication or application data flows.
 */
export function admitsRemoteCandidate(lan: LanSelection, candidate: string): boolean {
  try {
    const parsed = validateIceCandidate(lan, candidate);
    return parsed.component === 1 && parsed.status === 'numeric-validated';
  } catch { return false; }
}


export class RtcRemoteSocket extends EventEmitter implements RemoteSocket {
  private ended = false;
  private framer = new Framer();
  private queue: string[] = [];
  private queued = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly channel: RTCDataChannel, private readonly approved: () => boolean) {
    super();
    this.timer = setInterval(() => { if (!this.approved()) this.close(); else this.flush(); }, 25);
    channel.onMessage.subscribe(data => {
      if (this.ended) return;
      try {
        if (!this.approved() || typeof data !== 'string') throw new Error('Invalid RTC path or frame');
        const wire = this.framer.push(data);
        if (wire !== undefined) this.emit('message', Buffer.from(wire), false);
      } catch { this.close(); }
    });
    channel.stateChange.subscribe(state => { if (state === 'closed' || state === 'closing') this.close(); });
    channel.error.subscribe(() => this.close());
  }
  get readyState() { return this.ended ? 3 : this.channel.readyState === 'open' ? 1 : 0; }
  get bufferedAmount() { return this.queued + this.channel.bufferedAmount; }
  send(data: string) {
    if (this.readyState !== 1 || !this.approved()) { this.close(); return; }
    try {
      const frames = encodeFrames(data);
      const size = frames.reduce((n, frame) => n + Buffer.byteLength(frame), 0);
      if (this.bufferedAmount + size > RTC_WIRE_LIMIT + 256 * 1024) throw new Error('RTC backpressure');
      this.queue.push(...frames); this.queued += size; this.flush();
    } catch { this.close(1013); }
  }
  private flush() {
    if (this.ended) return;
    try {
      while (this.queue.length && this.channel.bufferedAmount < 256 * 1024) {
        if (!this.approved()) { this.close(); return; }
        const frame = this.queue.shift()!;
        this.queued -= Buffer.byteLength(frame); this.channel.send(frame);
      }
    } catch { this.close(); }
  }
  ping() { if (!this.approved()) this.close(); else this.emit('pong'); }
  terminate() { this.close(); }
  close(code = 1000, _reason?: string) {
    if (this.ended) return;
    this.ended = true; clearInterval(this.timer); this.queue = []; this.queued = 0; this.framer.reset();
    this.channel.close(); this.emit('close', code, Buffer.alloc(0));
  }
}

/** Read the native nominated pair(s), never SDP c= or an advertised candidate. */
export function selectedPeerAddress(peer: RTCPeerConnection, lan: LanSelection): string {
  if (peer.connectionState !== 'connected' || !peer.iceTransports.length || !peer.dtlsTransports.length ||
      peer.dtlsTransports.some(t => t.state !== 'connected')) throw new Error('Native transport not connected');
  const addresses = peer.iceTransports.map(transport => {
    const pair = transport.connection.nominated;
    if (!pair) throw new Error('No nominated ICE path');
    validateSelectedRemotePath(lan, { localAddress: pair.localCandidate.host, remoteAddress: pair.remoteAddr[0],
      protocol: pair.localCandidate.transport, localCandidateType: pair.localCandidate.type, remoteCandidateType: pair.remoteCandidate.type });
    return pair.remoteAddr[0];
  });
  if (new Set(addresses).size !== 1) throw new Error('Inconsistent nominated peers');
  return addresses[0];
}

/** werift falls back to ALL interfaces when its interface filter has no match.
 * Restrict the actual gathering input too, and fail closed if the address vanished.
 * Install after creating media/data transports and before setLocalDescription.
 */
export function restrictHostGathering(peer: RTCPeerConnection, lan: LanSelection) {
  for (const { connection } of peer.iceTransports) {
    // Native werift 0.25 hook is intentionally absent from its public IceConnection interface.
    const native = connection as unknown as { getCandidatePromises(addresses: string[], timeout?: number): Promise<unknown>[] };
    const gather = native.getCandidatePromises.bind(connection);
    native.getCandidatePromises = (addresses, timeout) => {
      if (!addresses.includes(lan.address)) throw new Error('Selected LAN address is no longer available');
      return gather([lan.address], timeout);
    };
  }
}

export function validateLocalCandidates(sdp: string, lan: LanSelection) {
  const candidates = sdp.split(/\r?\n/).filter(line => /^a=candidate:/i.test(line));
  if (!candidates.length) throw new Error('No selected LAN host candidate gathered');
  for (const line of candidates) {
    const fields = line.slice(2).split(/\s+/);
    if (fields[1] !== '1' || fields[2].toLowerCase() !== 'udp' || fields[4] !== lan.address || fields[7] !== 'host') {
      throw new Error('Unexpected local LAN candidate');
    }
  }
}

export async function startLanPeer(options: LanPeerOptions): Promise<{ close(): Promise<void>; resetPeer(): Promise<void> }> {
  const signaling = await SignalingClient.create(options.roomId, options.signalingOrigin);
  let stopped = false;
  let pc: RTCPeerConnection | undefined;
  let socket: RtcRemoteSocket | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let operation = Promise.resolve();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  // A rejected candidate is evidence about one address, not a fatal protocol error.
  // Counting keeps hostile candidates bounded while valid permitted peers still connect.
  let rejectedCandidates = 0;
  let lastFailure = '';
  const note = (reason: string) => { lastFailure = reason; };
  const report = (message?: string) => options.onError?.(message ?? 'LAN WebRTC connection failed. Check guest Wi-Fi isolation and UDP firewall rules; no relay is used. Reset pairing and retry.');
  const release = async () => {
    generation++;
    if (poll) clearTimeout(poll); if (watch) clearInterval(watch);
    if (deadline) clearTimeout(deadline); if (retry) clearTimeout(retry);
    poll = undefined; watch = undefined; deadline = undefined; retry = undefined;
    // Detach before close: close listeners enqueue recovery, never await this operation.
    const oldSocket = socket; socket = undefined; oldSocket?.close();
    const old = pc; pc = undefined; await old?.close();
  };
  const launch = async () => {
    const id = generation;
    const alive = () => !stopped && generation === id;
    const pairAllowed = (pair: any) => {
      try {
        validateSelectedRemotePath(options.lan, { localAddress: pair.localCandidate.host, remoteAddress: pair.remoteAddr[0],
          protocol: pair.localCandidate.transport, localCandidateType: pair.localCandidate.type, remoteCandidateType: pair.remoteCandidate.type });
        if (pair.remoteCandidate.host !== pair.remoteAddr[0]) return false;
        return true;
      } catch { return false; }
    };
    const peer = new RTCPeerConnection({ iceServers: [], iceLite: true, iceUseIpv4: true, iceUseIpv6: false, iceUseTcp: false,
      iceInterfaceAddresses: { udp4: options.lan.address }, bundlePolicy: 'max-bundle', maxMessageSize: 65536,
      iceFilterCandidatePair: pairAllowed,
      iceFilterStunResponse: (_message, addr) => {
        try { validateIceCandidate(options.lan, `candidate:1 1 udp 1 ${addr[0]} ${addr[1]} typ host`); return true; } catch { return false; }
      }, codecs: { audio: [new RTCRtpCodecParameters({ mimeType: 'audio/PCMU', clockRate: 8000, channels: 1, payloadType: 0 })] } });
    pc = peer;
    const approved = () => {
      if (!alive()) return false;
      try { selectedPeerAddress(peer, options.lan); return true; } catch { return false; }
    };
    const channel = peer.createDataChannel('terminal', { ordered: true });
    let attached = false;
    const attach = () => {
      if (attached || channel.readyState !== 'open' || !approved()) return;
      try {
        const clientFingerprint = descriptionFingerprint(peer.remoteDescription!.sdp);
        const serverFingerprint = descriptionFingerprint(peer.localDescription!.sdp);
        attached = true; socket = new RtcRemoteSocket(channel, approved);
        socket.once('close', () => { if (alive()) recover(id); });
        options.onSocket(socket, { peer: selectedPeerAddress(peer, options.lan),
          channelBinding: { clientFingerprint, serverFingerprint }, autoApprove: true, requireBinding: true });
        if (socket.readyState === 1) {
          if (deadline) clearTimeout(deadline); deadline = undefined;
          retries = 0;
          // AccessController listeners must exist before the browser starts OPAQUE.
          socket.send(JSON.stringify({ type: 'transport-ready' }));
        }
      } catch { if (alive()) recover(id); }
    };
    channel.stateChange.subscribe(attach);
    peer.onDataChannel.subscribe(extra => extra.close());
    const audio = peer.addTransceiver('audio', { direction: 'recvonly' });
    audio.receiver.track.onReceiveRtp.subscribe(packet => {
      if (!attached || !approved() || packet.header.payloadType !== 0 || packet.payload.length > 1600) return;
      options.onAudio?.(Buffer.from(packet.payload));
    });
    watch = setInterval(() => { if (!alive()) return; attach(); if (attached && !approved()) socket?.close(); }, 50);
    restrictHostGathering(peer, options.lan);
    deadline = setTimeout(() => { if (alive()) recover(id, `no direct LAN connection within 30 seconds${lastFailure ? ` (${lastFailure})` : ''}. Disable guest Wi-Fi/client isolation, allow UDP and local-network access on both devices, and ensure both are on ${options.lan.subnet}. No relay is available.`); }, 30_000);
    await peer.setLocalDescription(await peer.createOffer());
    if (!alive()) return;
    validateLocalCandidates(peer.localDescription!.sdp, options.lan);
    await signaling.send({ type: 'offer', sdp: peer.localDescription!.sdp });
    let answered = false;
    let candidates = 0;
    const tick = async () => {
      if (!alive()) return;
      try {
        for (const signal of await signaling.receive()) {
          if (!alive()) return;
          if (signal.type === 'answer') {
            if (answered) throw new Error('Unexpected answer');
            descriptionFingerprint(signal.sdp);
            // ICE-lite: the browser connects to our numeric host candidate. Drop every
            // remote candidate (numeric or .local) instead of feeding any to ICE; the
            // selected pair's source address remains the sole network authorization.
            const lines = signal.sdp.split(/\r?\n/).filter(line => !/^a=candidate:/i.test(line));
            if (!alive()) return;
            await peer.setRemoteDescription({ type: 'answer', sdp: lines.join('\r\n') }); answered = true;
          } else if (signal.type === 'candidate') {
            if (++candidates > 128) throw new Error('Too many candidates');
            if (!admitsRemoteCandidate(options.lan, signal.candidate)) {
              // mDNS (.local) and out-of-subnet candidates are expected and ignored.
              if (++rejectedCandidates > 64) throw new Error('Too many rejected candidates');
              return;
            }
            rejectedCandidates = 0;
            if (!alive()) return;
            await peer.addIceCandidate({ candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex });
          } else throw new Error('Unexpected offer');
        }
      } catch { if (alive()) recover(id); return; }
      if (alive()) poll = setTimeout(() => void tick(), 500);
    };
    poll = setTimeout(() => void tick(), 500);
  };
  // Recovery is serialized with explicit reset/close. Invalidating synchronously
  // prevents stale polls, deadlines and socket-close callbacks queuing duplicates.
  const recover = (id: number, message?: string) => {
    if (stopped || generation !== id) return;
    generation++;
    operation = operation.catch(() => {}).then(async () => {
      await release();
      if (stopped) return;
      report(message ?? (lastFailure
        ? `LAN WebRTC connection failed: ${lastFailure}. Both devices must be on ${options.lan.subnet} with guest Wi-Fi/client isolation off and local network access allowed. No relay is used.`
        : 'LAN WebRTC connection failed. Check guest Wi-Fi isolation and UDP firewall rules; no relay is used. Reset pairing and retry.'));
      if (retries >= 3) { report('LAN pairing stopped after 3 retries. Check Wi-Fi isolation/firewall and generate a new pairing link. No relay is used.'); return; }
      const delay = 500 * 2 ** retries++;
      const next = generation;
      retry = setTimeout(() => {
        retry = undefined;
        operation = operation.catch(() => {}).then(async () => {
          if (stopped || generation !== next) return;
          try { await signaling.leave(); if (!stopped && generation === next) await launch(); }
          catch { recover(next); }
        });
      }, delay);
    });
  };
  try { await launch(); } catch (cause) { await release(); await signaling.close().catch(() => {}); throw new Error('Unable to start LAN WebRTC pairing; check the selected interface address and UDP firewall.', { cause }); }
  return {
    close() { stopped = true; generation++; operation = operation.catch(() => {}).then(async () => { await release(); await signaling.close().catch(report); }); return operation; },
    resetPeer() {
      generation++; retries = 0;
      operation = operation.catch(() => {}).then(async () => {
        if (stopped) return;
        await release(); await signaling.leave(); if (!stopped) await launch();
      }).catch(() => { if (!stopped) recover(generation); });
      return operation;
    },
  };
}
