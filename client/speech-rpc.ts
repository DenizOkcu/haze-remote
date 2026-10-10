import type { SpeechCommand, SpeechResponse } from '../shared/speech.js';

const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
export class SpeechRpc {
  private pending = new Map<string, { resolve: (response: SpeechResponse & { type: 'speech-result' }) => void; reject: (error: Error) => void; cleanup: () => void }>();
  constructor(private readonly send: (message: unknown) => boolean) {}
  request(command: SpeechCommand, signal?: AbortSignal): Promise<SpeechResponse & { type: 'speech-result' }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Speech operation cancelled.')); return; }
      const requestId = id();
      const cancel = () => {
        try { this.send({ type: 'speech-cancel', requestId: id(), targetRequestId: requestId }); } catch { /* Never replay. */ }
        const pending = this.pending.get(requestId); pending?.cleanup(); pending?.reject(new Error('Speech operation cancelled.'));
      };
      const timer = setTimeout(() => {
        cancel();
      }, command.type === 'speech-download' ? 20 * 60_000 : command.type === 'speech-transcribe' ? 130_000 : 15_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.pending.delete(requestId); };
      this.pending.set(requestId, { resolve, reject, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      try { if (!this.send({ ...command, requestId })) throw new Error('Speech request was not sent. Reconnect and retry.'); }
      catch { cleanup(); reject(new Error('Speech request was not sent or delivery is uncertain. Reconnect and retry.')); }
    });
  }
  receive(response: SpeechResponse) {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    pending.cleanup();
    if (response.type === 'speech-error') pending.reject(new Error(response.message));
    else pending.resolve(response);
  }
  disconnect() {
    for (const pending of [...this.pending.values()]) {
      pending.cleanup(); pending.reject(new Error('Connection lost. Your text draft is preserved; recordings are discarded.'));
    }
  }
}
