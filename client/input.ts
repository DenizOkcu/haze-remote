export type InputResult = 'queued' | 'not-sent' | 'partial' | 'too-large';

// A successful local enqueue is not an acknowledgement from the PTY or Haze.
// Chunk by code point so a frame is at most 16 KiB without splitting Unicode.
export function sendTerminalInput(data: string, available: boolean, send: (message: { type: 'input'; data: string }) => boolean): InputResult {
  if (new TextEncoder().encode(data).byteLength > 64 * 1024) return 'too-large';
  if (!available) return 'not-sent';
  const characters = Array.from(data);
  for (let i = 0; i < characters.length; i += 4096) {
    try {
      if (!send({ type: 'input', data: characters.slice(i, i + 4096).join('') })) return i ? 'partial' : 'not-sent';
    } catch {
      // A throwing transport may already have written bytes. Never replay it.
      return 'partial';
    }
  }
  return 'queued';
}
