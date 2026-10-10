import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioRecording, MAX_RECORDING_BYTES, MAX_RTP_PAYLOAD_BYTES } from '../server/rtc-audio.js';

// Keep a reference to private storage solely to verify zeroing as well as release.
function storage(recording: AudioRecording): Buffer | undefined {
  return (recording as unknown as { buffer?: Buffer }).buffer;
}

function assertReleased(recording: AudioRecording, previous: Buffer): void {
  assert.equal(recording.activeId(), undefined);
  assert.equal(storage(recording), undefined);
  assert.ok(previous.every(byte => byte === 0));
}

test('RFC 3551 G.711 known vectors decode and linearly resample to normalized 16kHz', () => {
  const recording = new AudioRecording();
  const codes = [0xff, 0x7f, 0x80, 0x00, 0xfe, 0x7e, 0x90, 0x10, 0xa0, 0x20, 0xb0, 0x30];
  const pcm = [0, 0, 32124, -32124, 8, -8, 15996, -15996, 7932, -7932, 3900, -3900];
  recording.start('vector');
  recording.append(Buffer.from(codes));
  const previous = storage(recording)!;
  const result = recording.finish('vector');
  assert.ok(result instanceof Float32Array);
  assert.equal(result.length, codes.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    assert.equal(result[i * 2], pcm[i] / 32768);
    assert.equal(result[i * 2 + 1], (pcm[i] + pcm[Math.min(i + 1, pcm.length - 1)]) / 65536);
  }
  assert.ok(result.every(value => value >= -1 && value <= 1));
  assertReleased(recording, previous);
});

test('start/finish enforce a single active ID; mismatches preserve the recording', () => {
  const recording = new AudioRecording();
  assert.equal(recording.activeId(), undefined);
  assert.throws(() => recording.finish('missing'), /matching/);
  assert.throws(() => recording.start(''), /request ID/);
  recording.append(Buffer.from([0x80])); // Media outside a recording is ignored.
  recording.start('first');
  recording.append(Buffer.from([0x80]));
  const previous = storage(recording)!;
  assert.throws(() => recording.start('second'), /already active/);
  assert.throws(() => recording.start('first'), /already active/);
  assert.throws(() => recording.finish('second'), /matching/);
  recording.cancel('second');
  assert.equal(recording.activeId(), 'first');
  assert.equal(storage(recording), previous);
  assert.deepEqual(recording.finish('first'), new Float32Array([32124 / 32768, 32124 / 32768]));
  assertReleased(recording, previous);
  assert.throws(() => recording.finish('first'), /matching/);
  recording.start('second');
  recording.cancel();
});

test('copies transport payloads and interpolates across packet boundaries', () => {
  const recording = new AudioRecording();
  recording.start('copy');
  const payload = Buffer.from([0x80]);
  recording.append(payload);
  payload.fill(0xff);
  recording.append(Buffer.from([0x00]));
  assert.deepEqual(recording.finish('copy'), new Float32Array([32124 / 32768, 0, -32124 / 32768, -32124 / 32768]));
});

test('cancel wipes and releases storage, is idempotent, and permits a new start', () => {
  const recording = new AudioRecording();
  for (const id of ['one', 'two']) {
    recording.start(id);
    recording.append(Buffer.from([0x80, 0x90]));
    const previous = storage(recording)!;
    if (id === 'one') recording.cancel(id);
    else recording.cancel();
    assertReleased(recording, previous);
    recording.cancel(id);
    recording.cancel();
  }
});

test('empty finish rejects and releases the recording', () => {
  const recording = new AudioRecording();
  recording.start('empty');
  const previous = storage(recording)!;
  assert.throws(() => recording.finish('empty'), /empty/);
  assertReleased(recording, previous);
  recording.start('retry');
  recording.cancel();
});

test('malformed or oversized active payloads abort and wipe recording', () => {
  const recording = new AudioRecording();
  for (const payload of [Buffer.alloc(0), Buffer.alloc(MAX_RTP_PAYLOAD_BYTES + 1), new Uint8Array([0xff]), null]) {
    recording.start('invalid');
    recording.append(Buffer.from([0x80]));
    const previous = storage(recording)!;
    assert.throws(() => recording.append(payload as Buffer), /Invalid PCMU/);
    assertReleased(recording, previous);
  }
  recording.start('valid');
  recording.append(Buffer.alloc(MAX_RTP_PAYLOAD_BYTES, 0xff));
  assert.equal(recording.finish('valid').length, MAX_RTP_PAYLOAD_BYTES * 2);
});

test('accepts exactly 30 seconds and rejects one byte more with no retained audio', () => {
  assert.equal(MAX_RECORDING_BYTES, 240000);
  assert.equal(MAX_RTP_PAYLOAD_BYTES, 2048);
  const recording = new AudioRecording();
  const fill = () => {
    for (let remaining = MAX_RECORDING_BYTES; remaining > 0;) {
      const count = Math.min(remaining, MAX_RTP_PAYLOAD_BYTES);
      recording.append(Buffer.alloc(count, 0xff));
      remaining -= count;
    }
  };
  recording.start('maximum');
  fill();
  const previous = storage(recording)!;
  const result = recording.finish('maximum');
  assert.equal(result.length, 30 * 16000);
  assert.ok(result.every(value => value === 0));
  assertReleased(recording, previous);
  recording.start('overflow');
  fill();
  const overflow = storage(recording)!;
  assert.throws(() => recording.append(Buffer.from([0xff])), /30 seconds/);
  assertReleased(recording, overflow);
  assert.throws(() => recording.finish('overflow'), /matching/);
  recording.start('retry');
  recording.cancel();
});
