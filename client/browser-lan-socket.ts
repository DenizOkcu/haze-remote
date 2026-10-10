import type { SocketTransport } from '../shared/session.js';
import type { ChannelBinding } from '../shared/crypto.js';
import { SignalingClient } from '../shared/signaling.js';
import { encodeFrames, Framer, RTC_WIRE_LIMIT } from '../shared/rtc-framing.js';

export function descriptionFingerprint(sdp: string): string {
  const values = sdp.split(/\r?\n/).filter(line => /^a=fingerprint:/i.test(line)).map(line => {
    const match = /^a=fingerprint:sha-256 ((?:[a-f0-9]{2}:){31}[a-f0-9]{2})$/i.exec(line);
    if (!match) throw new Error('SHA256 DTLS fingerprint required');
    return match[1].toUpperCase();
  });
  if (!values.length || new Set(values).size !== 1) throw new Error('Invalid DTLS fingerprints');
  return values[0];
}
export function hostCandidate(candidate: string): boolean {
  const fields = candidate.trim().replace(/^a=/, '').split(/\s+/);
  return fields.length >= 8 && /^candidate:/.test(fields[0]) && fields[1] === '1' && fields[2].toLowerCase() === 'udp'
    && fields[6] === 'typ' && fields[7] === 'host'
    && (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(fields[4]) || /^[a-z0-9-]+\.local$/i.test(fields[4]));
}
/** Browser-side transport. Subnet and selected-path enforcement belongs to the native peer. */
export class BrowserLanSocket implements SocketTransport {
  channelBinding?: ChannelBinding;
  readyState = 0;
  onopen: SocketTransport['onopen'] = null;
  onmessage: SocketTransport['onmessage'] = null;
  onclose: SocketTransport['onclose'] = null;
  onerror: SocketTransport['onerror'] = null;
  private peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  private lease?: SignalingClient;
  private channel?: RTCDataChannel;
  private sender?: RTCRtpSender;
  private track?: MediaStreamTrack;
  private poll?: ReturnType<typeof setTimeout>;
  private deadline: ReturnType<typeof setTimeout>;
  private framer = new Framer();
  private queue: string[] = [];
  private queued = 0;
  private localCandidates = 0;
  private remoteCandidates = 0;
  private sending = Promise.resolve();
  get bufferedAmount() { return this.queued + (this.channel?.bufferedAmount ?? 0); }
  constructor(room: string) {
    this.deadline = setTimeout(() => this.fail(new Error('LAN connection timed out. Check the network and generate a new link.')), 30_000);
    this.peer.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(this.peer.connectionState)) this.close();
    };
    this.peer.ondatachannel = event => {
      const channel = event.channel;
      if (this.channel || channel.label !== 'terminal' || !channel.ordered || channel.maxRetransmits !== null || channel.maxPacketLifeTime !== null) {
        channel.close(); this.fail(new Error('Reliable terminal channel required')); return;
      }
      this.channel = channel;
      channel.bufferedAmountLowThreshold = 128 * 1024;
      channel.onbufferedamountlow = () => this.flush();
      channel.onopen = () => {
        try {
          this.channelBinding = {
            clientFingerprint: descriptionFingerprint(this.peer.localDescription!.sdp),
            serverFingerprint: descriptionFingerprint(this.peer.remoteDescription!.sdp),
          };
          if (this.readyState === 3) return;
          // Native readiness follows selected-path validation and listener attachment.
        } catch (error) { this.fail(error); }
      };
      channel.onmessage = event => {
        try {
          const wire = this.framer.push(event.data);
          if (wire === undefined) return;
          if (this.readyState === 0) {
            if (wire !== JSON.stringify({ type: 'transport-ready' }) || !this.channelBinding) throw new Error('Native transport readiness required');
            clearTimeout(this.deadline); this.readyState = 1; this.onopen?.({});
          } else if (this.readyState === 1) this.onmessage?.({ data: wire });
        }
        catch (error) { this.fail(error); }
      };
      channel.onclose = () => this.close(); channel.onerror = event => this.fail(event);
    };
    // Send trickled candidates only after the answer has been posted.
    this.peer.onicecandidate = event => {
      const c = event.candidate;
      if (!c || !hostCandidate(c.candidate)) return;
      if (++this.localCandidates > 128) { this.fail(new Error('Too many ICE candidates')); return; }
      this.sending = this.sending.then(async () => {
        if (this.readyState !== 3) await this.lease!.send({ type: 'candidate', candidate: c.candidate, sdpMid: c.sdpMid ?? '0', sdpMLineIndex: c.sdpMLineIndex ?? 0 });
      }).catch(error => this.fail(error));
    };
    void this.start(room).catch(error => this.fail(error));
  }
  private async start(room: string) {
    if (!/^[a-f0-9]{32}$/.test(room)) throw new Error('Invalid pairing room');
    const lease = await SignalingClient.join(room);
    if (this.readyState === 3) { await lease.leave().catch(() => {}); return; }
    this.lease = lease;
    let offered = false;
    const tick = async () => {
      try {
        for (const signal of await lease.receive()) {
          if (this.readyState === 3) return;
          if (signal.type === 'offer' && !offered) {
            descriptionFingerprint(signal.sdp);
            const lines = signal.sdp.split(/\r?\n/).filter(line => {
              if (!/^a=candidate:/i.test(line)) return true;
              if (++this.remoteCandidates > 128) throw new Error('Too many ICE candidates');
              return hostCandidate(line);
            });
            await this.peer.setRemoteDescription({ type: 'offer', sdp: lines.join('\r\n') });
            if (this.readyState === 3) return;
            const audio = this.peer.getTransceivers().find(t => t.receiver.track.kind === 'audio');
            if (!audio) throw new Error('Audio sender required');
            audio.direction = 'sendonly'; this.sender = audio.sender;
            const answer = await this.peer.createAnswer();
            // Queue the answer ahead of candidates emitted by setLocalDescription.
            this.sending = this.sending.then(async () => {
              await this.peer.setLocalDescription(answer);
              if (this.readyState !== 3) await lease.send({ type: 'answer', sdp: this.peer.localDescription!.sdp.split(/\r?\n/).filter(l => !/^a=candidate:/i.test(l)).join('\r\n') });
            });
            await this.sending; offered = true;
          } else if (signal.type === 'candidate' && offered) {
            if (++this.remoteCandidates > 128) throw new Error('Too many ICE candidates');
            if (hostCandidate(signal.candidate)) await this.peer.addIceCandidate(signal);
          } else throw new Error('Unexpected signaling message');
        }
        if (this.readyState !== 3) this.poll = setTimeout(() => void tick(), 500);
      } catch (error) { this.fail(error); }
    };
    this.poll = setTimeout(() => void tick(), 500);
  }
  async setMicrophone(track: MediaStreamTrack | null) {
    if (!this.sender || this.readyState !== 1) { track?.stop(); throw new Error('Audio connection unavailable'); }
    const old = this.track; this.track = track ?? undefined;
    try { await this.sender.replaceTrack(track); }
    catch (error) { track?.stop(); this.track = undefined; throw error; }
    finally { if (old !== track) old?.stop(); }
    if (this.readyState !== 1) { track?.stop(); throw new Error('Audio connection closed'); }
  }
  send(wire: string) {
    if (this.readyState !== 1) throw new Error('Transport closed');
    const frames = encodeFrames(wire);
    const size = frames.reduce((n, frame) => n + new TextEncoder().encode(frame).length, 0);
    if (this.bufferedAmount + size > RTC_WIRE_LIMIT + 256 * 1024) { this.close(1013); throw new Error('RTC backpressure'); }
    this.queue.push(...frames); this.queued += size; this.flush();
  }
  private flush() {
    try {
      while (this.queue.length && this.channel?.readyState === 'open' && this.channel.bufferedAmount < 256 * 1024) {
        const frame = this.queue.shift()!; this.queued -= new TextEncoder().encode(frame).length; this.channel.send(frame);
      }
    } catch (error) { this.fail(error); }
  }
  private fail(error: unknown) { if (this.readyState === 3) return; this.onerror?.(error); this.close(1006); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3; clearTimeout(this.poll); clearTimeout(this.deadline);
    this.track?.stop(); this.sender?.track?.stop(); this.track = undefined;
    this.queue = []; this.queued = 0; this.framer.reset(); this.channel?.close(); this.peer.close();
    void this.lease?.leave().catch(() => {}); this.onclose?.({ code, reason });
  }
}
