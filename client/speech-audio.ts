import { SPEECH_MAX_SECONDS, SPEECH_SAMPLE_RATE } from '../shared/speech.js';

export function pcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
export function encodeAudio(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export class SpeechCaptureError extends Error {
  constructor(readonly stage: 'microphone' | 'audio-startup' | 'audio-processor', cause: unknown) {
    const name = cause instanceof Error ? cause.name : 'Error';
    const detail = cause instanceof Error ? cause.message : 'The browser did not provide a reason.';
    const advice = stage === 'microphone'
      ? 'Microphone access failed. Reset this site’s microphone permission, reload, and choose Allow for this request; also check OS permissions.'
      : stage === 'audio-startup'
        ? 'Audio engine startup failed. Retry by pressing and holding PTT directly in the active browser tab.'
        : 'Audio capture processor failed. Reload the updated page and retry.';
    super(`${advice} Browser detail (${name}): ${detail}`, { cause });
    this.name = name;
  }
}

export class SpeechCapture {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode | ScriptProcessorNode;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private cancelled = false;
  private stopping = false;
  private flushed?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  async start(onLimit: () => void) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not expose microphone capture. Use trusted HTTPS (--tls-cert and --tls-key), or localhost on the computer running it.');
    // Resume during the user gesture, before waiting for microphone permission.
    try { this.context = new AudioContext(); }
    catch (error) { throw new SpeechCaptureError('audio-startup', error); }
    const resumed = this.context.resume().catch(error => { throw new SpeechCaptureError('audio-startup', error); });
    const microphone = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }).then(stream => {
      this.stream = stream;
      if (this.cancelled) this.stopTracks();
      return stream;
    }).catch(error => { throw new SpeechCaptureError('microphone', error); });
    const [, stream] = await Promise.all([resumed, microphone]);
    if (this.cancelled) return;
    try {
      if (this.context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        await this.context.audioWorklet.addModule(new URL('./pcm-worklet.js?no-inline', import.meta.url));
        if (this.cancelled) return;
        const node = new AudioWorkletNode(this.context, 'haze-pcm-capture');
        node.port.onmessage = event => {
          if (event.data === 'stopped') { this.flushed?.(); return; }
          const samples = event.data as Float32Array;
          this.collect(samples); samples.fill(0);
        };
        this.node = node;
      } else {
        // Firefox's HTTP microphone exception need not expose AudioWorklet.
        // Keep this deprecated API narrowly scoped to that capability fallback.
        if (typeof this.context.createScriptProcessor !== 'function') throw new DOMException('This browser has no supported audio capture processor.', 'NotSupportedError');
        const node = this.context.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = event => {
          if (!this.stopping) this.collect(event.inputBuffer.getChannelData(0));
          event.outputBuffer.getChannelData(0).fill(0); // Never play microphone audio.
        };
        this.node = node;
      }
      this.context.createMediaStreamSource(stream).connect(this.node);
      // The worklet outputs silence, not microphone audio.
      this.node.connect(this.context.destination);
    } catch (error) { throw new SpeechCaptureError('audio-processor', error); }
    this.timer = setTimeout(onLimit, SPEECH_MAX_SECONDS * 1000);
  }
  async finish(): Promise<Uint8Array> {
    if (this.cancelled || this.stopping || !this.node || !this.context) throw new Error('Recording was cancelled.');
    this.stopping = true; clearTimeout(this.timer);
    this.stopTracks();
    if ('port' in this.node) {
      const node = this.node;
      const timeout = setTimeout(() => this.flushed?.(), 500);
      await new Promise<void>(resolve => { this.flushed = resolve; node.port.postMessage('stop'); });
      clearTimeout(timeout);
    } else this.node.onaudioprocess = null;
    const rate = this.context.sampleRate;
    this.node.disconnect(); await this.context.close();
    if (this.cancelled) throw new Error('Recording was cancelled.');
    if (!this.samples) throw new Error('No audio captured. Hold the button while speaking and retry.');
    const buffer = new AudioBuffer({ numberOfChannels: 1, length: this.samples, sampleRate: rate });
    let offset = 0;
    for (const chunk of this.chunks) { buffer.getChannelData(0).set(chunk, offset); offset += chunk.length; chunk.fill(0); }
    this.chunks = [];
    const offline = new OfflineAudioContext(1, Math.min(SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS, Math.max(1, Math.round(this.samples / rate * SPEECH_SAMPLE_RATE))), SPEECH_SAMPLE_RATE);
    const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering();
    buffer.getChannelData(0).fill(0);
    const samples = rendered.getChannelData(0);
    const bytes = this.cancelled ? new Uint8Array() : pcm16(samples);
    samples.fill(0); this.cancel();
    return bytes;
  }
  private collect(samples: Float32Array) {
    if (this.cancelled) return;
    const remaining = Math.max(0, Math.floor(this.context!.sampleRate * SPEECH_MAX_SECONDS) - this.samples);
    if (!remaining) return;
    const chunk = samples.slice(0, remaining);
    this.chunks.push(chunk); this.samples += chunk.length;
  }
  private stopTracks() {
    this.stream?.getTracks().forEach(track => { if (track.readyState !== 'ended') track.stop(); });
  }
  cancel() {
    this.cancelled = true; clearTimeout(this.timer); this.flushed?.();
    this.stopTracks();
    this.node?.disconnect();
    if (this.node) {
      if ('port' in this.node) this.node.port.close();
      else this.node.onaudioprocess = null;
    }
    if (this.context?.state !== 'closed') void this.context?.close().catch(() => {});
    for (const chunk of this.chunks) chunk.fill(0);
    this.chunks = []; this.samples = 0;
  }
}
