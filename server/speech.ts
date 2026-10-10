import { fork } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEECH_MAX_BYTES, type SpeechStatus } from '../shared/speech.js';
import { downloadModel, modelPresent } from './speech-model.js';

export interface SpeechBackend {
  status(): Promise<SpeechStatus>;
  download(signal: AbortSignal): Promise<void>;
  transcribe(audio: Buffer, signal: AbortSignal): Promise<string>;
  close(): void;
}
export function decodeAudio(encoded: string): Buffer {
  const pcm = Buffer.from(encoded, 'base64');
  if (!pcm.length || pcm.length % 2 || pcm.length > SPEECH_MAX_BYTES || pcm.toString('base64') !== encoded) {
    pcm.fill(0); throw new Error('Invalid recording. Record up to 30 seconds and try again.');
  }
  return pcm;
}
export function infer(directory: string, audio: Buffer, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = fork(fileURLToPath(new URL('./speech-worker.js', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', execArgv: [],
    });
    let text: string | undefined, error: Error | undefined;
    const abort = () => { error = new Error('Transcription cancelled.'); child.kill('SIGKILL'); };
    const timer = setTimeout(() => { error = new Error('Transcription timed out. Try a shorter recording.'); child.kill('SIGKILL'); }, 120_000);
    signal.addEventListener('abort', abort, { once: true });
    child.once('message', (message: { text?: string; error?: string }) => {
      if (typeof message.text === 'string' && message.text.length <= 16000) text = message.text;
      else error = new Error(message.error ?? 'Invalid transcription result.');
    });
    child.once('error', value => { error = value; });
    child.once('close', () => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (signal.aborted || error || text === undefined) reject(error ?? new Error('Local transcription service stopped. Retry the recording.'));
      else resolve(text);
    });
    child.send({ directory, audio }, sendError => { if (sendError) { error = sendError; child.kill('SIGKILL'); } });
  });
}
export class SpeechService implements SpeechBackend {
  private ready?: Promise<boolean>;
  private state: SpeechStatus = { state: 'missing', downloadedBytes: 0 };
  private busy = false;
  private lifetime = new AbortController();
  private readonly directory: string;
  constructor(home = homedir(), private readonly dependencies = { present: modelPresent, download: downloadModel, infer }) {
    this.directory = join(home, '.haze', 'remote', 'speech', 'parakeet-v3-int8');
  }
  async status() {
    if (!this.ready) this.ready = this.dependencies.present(this.directory).then(value => {
      if (value) this.state = { state: 'ready', downloadedBytes: 0 }; return value;
    });
    await this.ready;
    return { ...this.state };
  }
  async download(signal: AbortSignal) {
    if ((await this.status()).state === 'ready') return;
    if (this.busy) throw new Error('Speech service is busy. Wait and retry.');
    this.busy = true; this.state = { state: 'downloading', downloadedBytes: 0 };
    try {
      await this.dependencies.download(this.directory, AbortSignal.any([signal, this.lifetime.signal]), bytes => { this.state.downloadedBytes = bytes; });
      this.state = { state: 'ready', downloadedBytes: this.state.downloadedBytes };
    } catch (error) { this.state = { state: 'missing', downloadedBytes: 0 }; throw error; }
    finally { this.busy = false; }
  }
  async transcribe(audio: Buffer, signal: AbortSignal) {
    try {
      if ((await this.status()).state !== 'ready') throw new Error('Download Parakeet before recording.');
      if (this.busy) throw new Error('Speech service is busy. Wait and retry.');
      this.busy = true;
      try { return await this.dependencies.infer(this.directory, audio, AbortSignal.any([signal, this.lifetime.signal])); }
      finally { this.busy = false; }
    } finally { audio.fill(0); }
  }
  close() { this.lifetime.abort(); }
}
