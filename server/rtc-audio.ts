/** PCMU is one byte per sample at 8kHz: at most 30 seconds in memory. */
export const MAX_RECORDING_BYTES = 30 * 8000;
export const MAX_RTP_PAYLOAD_BYTES = 2048;

/** RFC 3551 G.711 mu-law expansion to signed 16-bit PCM. */
function muLawToPcm16(value: number): number {
  const code = (~value) & 0xff;
  const magnitude = (((code & 0x0f) << 3) + 0x84) << ((code >> 4) & 0x07);
  return (code & 0x80) ? 0x84 - magnitude : magnitude - 0x84;
}

/**
 * One memory-only recording of raw RTP PCMU payloads (no RTP headers).
 * Idle packets are ignored. Invalid active packets abort and wipe the recording.
 * Mismatched finish throws without disturbing the active request; mismatched
 * cancel is a no-op so a late cancellation cannot erase a newer recording.
 */
export class AudioRecording {
  private requestId?: string;
  private buffer?: Buffer;
  private length = 0;

  activeId(): string | undefined { return this.requestId; }

  start(requestId: string): void {
    if (this.requestId !== undefined) throw new Error('Audio recording already active.');
    if (typeof requestId !== 'string' || !requestId.length) throw new Error('Invalid recording request ID.');
    this.buffer = Buffer.alloc(MAX_RECORDING_BYTES);
    this.length = 0;
    this.requestId = requestId;
  }

  append(payload: Buffer): void {
    if (this.requestId === undefined) return;
    if (!Buffer.isBuffer(payload) || !payload.length || payload.length > MAX_RTP_PAYLOAD_BYTES) {
      this.cancel();
      throw new Error('Invalid PCMU RTP payload.');
    }
    if (this.length + payload.length > MAX_RECORDING_BYTES) {
      this.cancel();
      throw new Error('Audio recording exceeds 30 seconds.');
    }
    // Copy, rather than retain transport-owned buffers that may be reused.
    payload.copy(this.buffer!, this.length);
    this.length += payload.length;
  }

  /** Return normalized mono 16kHz PCM; the caller owns and must clear the result. */
  finish(requestId: string): Float32Array {
    if (this.requestId === undefined || this.requestId !== requestId) {
      throw new Error('No matching active audio recording.');
    }
    try {
      if (!this.length) throw new Error('Audio recording is empty.');
      const result = new Float32Array(this.length * 2);
      for (let i = 0; i < this.length; i++) {
        const current = muLawToPcm16(this.buffer![i]) / 32768;
        const next = i + 1 < this.length ? muLawToPcm16(this.buffer![i + 1]) / 32768 : current;
        result[i * 2] = current;
        result[i * 2 + 1] = (current + next) / 2;
      }
      return result;
    } finally {
      this.cancel();
    }
  }

  cancel(requestId?: string): void {
    if (requestId !== undefined && requestId !== this.requestId) return;
    this.buffer?.fill(0);
    this.buffer = undefined;
    this.length = 0;
    this.requestId = undefined;
  }
}
