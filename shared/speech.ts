export const SPEECH_SAMPLE_RATE = 16_000;
export const SPEECH_MAX_SECONDS = 30;
export const SPEECH_MAX_BYTES = SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS * 2;
export const SPEECH_MODEL = 'Parakeet TDT 0.6B v3 (multilingual, INT8)';
export const SPEECH_DOWNLOAD_BYTES = 670_478_772;
export type SpeechStatus = { state: 'missing' | 'downloading' | 'ready'; downloadedBytes: number; error?: string };
export type SpeechCommand = { type: 'speech-status' } | { type: 'speech-download' } | { type: 'speech-download-cancel' }
  | { type: 'speech-record-start' | 'speech-record-stop' }
  | { type: 'speech-cancel'; targetRequestId: string };
export type SpeechRequest = SpeechCommand & { requestId: string };
export type SpeechResponse = { type: 'speech-result'; requestId: string; status: SpeechStatus; text?: string }
  | { type: 'speech-error'; requestId: string; message: string };
export function isSpeechRequest(value: unknown): value is SpeechRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  if (typeof request.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(request.requestId)) return false;
  if (request.type === 'speech-status' || request.type === 'speech-download' || request.type === 'speech-download-cancel' || request.type === 'speech-record-start' || request.type === 'speech-record-stop') return true;
  if (request.type === 'speech-cancel') return typeof request.targetRequestId === 'string' && /^[a-f0-9]{32}$/.test(request.targetRequestId);
  return false;
}
