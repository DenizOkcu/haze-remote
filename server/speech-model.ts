import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

const REVISION = '2bda32ec70b097a55adaa07d9a7173915b43cc78';
const BASE = `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/${REVISION}`;
export const MODEL_FILES = [
  { name: 'encoder.int8.onnx', bytes: 652184281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
  { name: 'decoder.int8.onnx', bytes: 11845275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
  { name: 'joiner.int8.onnx', bytes: 6355277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
  { name: 'tokens.txt', bytes: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
] as const;
export async function modelPresent(directory: string): Promise<boolean> {
  try {
    for (const file of MODEL_FILES) {
      if ((await stat(join(directory, file.name))).size !== file.bytes) return false;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(join(directory, file.name))) hash.update(chunk);
      if (hash.digest('hex') !== file.sha256) return false;
    }
    return true;
  } catch { return false; }
}
// Only model assets touch disk. Audio is never passed to this module.
export async function downloadModel(directory: string, signal: AbortSignal, progress: (bytes: number) => void) {
  const parent = join(directory, '..');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, '.parakeet-download-'));
  let downloaded = 0;
  try {
    for (const file of MODEL_FILES) {
      const response = await fetch(`${BASE}/${file.name}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]) });
      if (!response.ok || !response.body) throw new Error('Model download failed. Check internet access and retry.');
      const handle = await open(join(staging, file.name), 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted(); size += chunk.length;
          if (size > file.bytes) throw new Error('Model download exceeded its expected size.');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.length) offset += (await handle.write(chunk, offset)).bytesWritten;
          downloaded += chunk.length; progress(downloaded);
        }
      } finally { await handle.close(); }
      if (size !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error('Model integrity check failed. Retry the download.');
    }
    signal.throwIfAborted();
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
