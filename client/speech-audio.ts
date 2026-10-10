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
  private cancelled = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly setMicrophone: (track: MediaStreamTrack | null) => Promise<void>) {}
  async start(onLimit: () => void) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture requires trusted HTTPS and browser permission.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      this.stream = stream;
      if (this.cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('No microphone track available');
      await this.setMicrophone(track);
      if (this.cancelled) { this.cancel(); return; }
      track.onended = onLimit;
      this.timer = setTimeout(onLimit, SPEECH_MAX_SECONDS * 1000);
    } catch (error) { this.cancel(); throw new SpeechCaptureError('microphone', error); }
  }
  async finish(): Promise<void> { this.cancel(); }
  cancel() {
    this.cancelled = true; clearTimeout(this.timer);
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    this.stream = undefined;
    void this.setMicrophone(null).catch(() => {});
  }
}
