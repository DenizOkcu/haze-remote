import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { get } from 'node:https';
import { WebSocket } from 'ws';
import { ClientSession, type SocketTransport } from '../shared/session.js';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SpeechService, decodeAudio } from '../server/speech.js';
import { MODEL_FILES, downloadModel, modelPresent } from '../server/speech-model.js';
import { isSpeechRequest, SPEECH_DOWNLOAD_BYTES, SPEECH_MAX_BYTES } from '../shared/speech.js';
import { SpeechRpc } from '../client/speech-rpc.js';
import { pcm16, encodeAudio, SpeechCaptureError } from '../client/speech-audio.js';
import { microphoneInstructions, microphoneBlock, microphoneErrorBlock } from '../client/microphone-help.js';
import { startRemote } from '../server/server.js';
import { connection, until } from './helpers.js';

const id = 'a'.repeat(32);
test('speech schema, PCM conversion, and maximum encrypted-frame budget', async () => {
  const pcm = pcm16(new Float32Array([-2, -1, 0, 1, 2]));
  assert.deepEqual(Array.from(new Int16Array(pcm.buffer)), [-32768, -32768, 0, 32767, 32767]);
  assert.deepEqual(decodeAudio(encodeAudio(pcm)), Buffer.from(pcm));
  for (const audio of ['', 'a', 'abc!', 'YQ==', 'AA===', 'AB==']) assert.throws(() => decodeAudio(audio));
  const maximum = Buffer.alloc(SPEECH_MAX_BYTES).toString('base64');
  assert.equal(isSpeechRequest({ type: 'speech-transcribe', requestId: id, audio: maximum }), true);
  assert.equal(isSpeechRequest({ type: 'speech-transcribe', requestId: id, audio: maximum + 'AAAA' }), false);
  assert.equal(isSpeechRequest({ type: 'speech-download', requestId: '../escape' }), false);
  assert.equal(isSpeechRequest({ type: 'speech-cancel', requestId: id, targetRequestId: id }), true);
  assert.equal(MODEL_FILES.reduce((size, file) => size + file.bytes, 0), SPEECH_DOWNLOAD_BYTES);
  const { cryptoReady, EncryptedChannel } = await import('../shared/crypto.js');
  await cryptoReady;
  const channel = new EncryptedChannel('11'.repeat(64), 'client');
  try {
    assert.ok(Buffer.byteLength(JSON.stringify(channel.seal({ type: 'speech-transcribe', requestId: id, audio: maximum }))) < 2 * 1024 * 1024);
  } finally { channel.dispose(); }
});

test('status never downloads; explicit download is deduplicated; success/failure/cancel clear PCM', async () => {
  let downloads = 0, inferences = 0;
  const service = new SpeechService('/unused', {
    present: async () => false,
    download: async (_directory, signal, progress) => { signal.throwIfAborted(); downloads++; progress(123); },
    infer: async (_directory, audio, signal) => { inferences++; assert.equal(audio[0], 12); signal.throwIfAborted(); return 'hello'; },
  });
  const signal = new AbortController().signal;
  assert.equal((await service.status()).state, 'missing'); assert.equal(downloads, 0);
  let pcm = Buffer.from([12, 0]);
  await assert.rejects(service.transcribe(pcm, signal), /Download/); assert.deepEqual(pcm, Buffer.alloc(2));
  await service.download(signal); await service.download(signal); assert.equal(downloads, 1);
  pcm = Buffer.from([12, 0]); assert.equal(await service.transcribe(pcm, signal), 'hello'); assert.deepEqual(pcm, Buffer.alloc(2));
  const abort = new AbortController(); abort.abort();
  pcm = Buffer.from([12, 0]); await assert.rejects(service.transcribe(pcm, abort.signal)); assert.deepEqual(pcm, Buffer.alloc(2));
  service.close(); pcm = Buffer.from([12, 0]); await assert.rejects(service.transcribe(pcm, signal)); assert.deepEqual(pcm, Buffer.alloc(2));
  assert.equal(inferences, 3);
});

test('failed model download removes partial model files and never leaves recordings on disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'haze-speech-model-'));
  const previousFetch = globalThis.fetch;
  try {
    assert.equal(await modelPresent(join(home, 'missing')), false);
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
    await assert.rejects(downloadModel(join(home, 'model'), new AbortController().signal, () => {}), /integrity/);
    assert.deepEqual(await readdir(home), []);
  } finally { globalThis.fetch = previousFetch; await rm(home, { recursive: true, force: true }); }
});

test('speech RPC cancels once, ignores late responses, rejects disconnected requests without replay', async () => {
  const messages: any[] = [];
  const rpc = new SpeechRpc(message => { messages.push(message); return true; });
  const abort = new AbortController();
  const pending = rpc.request({ type: 'speech-transcribe', audio: 'AAAA' }, abort.signal);
  abort.abort(); await assert.rejects(pending, /cancelled/);
  assert.equal(messages.length, 2); assert.equal(messages[1].targetRequestId, messages[0].requestId);
  rpc.receive({ type: 'speech-result', requestId: messages[0].requestId, status: { state: 'ready', downloadedBytes: 0 }, text: 'late' });
  const disconnected = rpc.request({ type: 'speech-status' }); rpc.disconnect();
  await assert.rejects(disconnected, /Connection lost/); assert.equal(messages.length, 3);
});

test('paired encrypted speech service requires consent, bounds input, cancels on disconnect and wipes audio', { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'haze-speech-server-'));
  let downloads = 0, transcriptions = 0, closed = false;
  let audioReference: Buffer | undefined, jobSignal: AbortSignal | undefined;
  const remote = await startRemote({ host: '127.0.0.1', port: 0, cwd: home, executable: process.execPath,
    args: [resolve('tests/fixtures/agent.mjs')], assets: resolve('tests/fixtures'),
    speech: {
      status: async () => ({ state: downloads ? 'ready' : 'missing', downloadedBytes: 0 }),
      download: async () => { downloads++; },
      transcribe: async (audio, signal) => {
        transcriptions++; audioReference = audio; jobSignal = signal;
        if (transcriptions > 1) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        return 'PRIVATE TRANSCRIPT';
      }, close: () => { closed = true; },
    },
  });
  const origin = `http://127.0.0.1:${remote.port}`;
  const client = await connection(origin, remote.local.pin()!.pin);
  const request = (suffix: string) => suffix.repeat(32);
  try {
    await until(() => !!client.state.code);
    assert.equal(client.session.send({ type: 'speech-download', requestId: id }), false);
    assert.equal(downloads, 0);
    remote.local.approve(remote.local.confirm(client.state.code!).id);
    await until(() => client.messages.some(message => message.type === 'snapshot'));
    client.session.send({ type: 'speech-status', requestId: request('b') });
    await until(() => client.messages.some(message => message.requestId === request('b')));
    assert.equal(downloads, 0);
    client.session.send({ type: 'speech-download', requestId: request('c') });
    await until(() => client.messages.some(message => message.requestId === request('c'))); assert.equal(downloads, 1);
    client.session.send({ type: 'speech-transcribe', requestId: request('d'), audio: '!!!' });
    await until(() => client.messages.some(message => message.type === 'speech-error' && message.requestId === request('d')));
    assert.equal(transcriptions, 0);
    client.session.send({ type: 'speech-transcribe', requestId: request('e'), audio: Buffer.from([12, 0]).toString('base64') });
    await until(() => client.messages.some(message => message.text === 'PRIVATE TRANSCRIPT'));
    assert.deepEqual(audioReference, Buffer.alloc(2));
    assert.ok(client.wire.every(frame => !frame.includes('PRIVATE TRANSCRIPT')));
    assert.ok(!client.output().includes('PRIVATE TRANSCRIPT'), 'Transcription never submits terminal input');
    client.session.send({ type: 'speech-transcribe', requestId: request('f'), audio: 'DAA=' });
    await until(() => transcriptions === 2);
    client.session.close(); await until(() => !!jobSignal?.aborted);
    await until(() => audioReference?.every(byte => byte === 0) === true);
  } finally { client.ws.terminate(); await remote.close(); await rm(home, { recursive: true, force: true }); }
  assert.equal(closed, true);
});

test('HTTPS preserves trusted TLS, matching Origin, local approval and encrypted speech transport', { timeout: 20000 }, async () => {
  // Generate a throwaway identity entirely in memory; never read user key files.
  const identity = execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/dev/stdout', '-out', '/dev/stdout',
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const home = await mkdtemp(join(tmpdir(), 'haze-speech-tls-'));
  const remote = await startRemote({ host: '127.0.0.1', port: 0, cwd: home, executable: process.execPath,
    args: [resolve('tests/fixtures/agent.mjs')], assets: resolve('tests/fixtures'), tls: { cert: identity, key: identity },
    speech: { status: async () => ({ state: 'missing', downloadedBytes: 0 }), download: async () => {}, transcribe: async () => '', close() {} },
  });
  const origin = `https://127.0.0.1:${remote.port}`;
  let client: ClientSession | undefined;
  let ws: WebSocket | undefined;
  try {
    const info = await new Promise<{ serverId: string }>((resolve, reject) => {
      get(origin + '/api/info', { ca: identity }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    const wrong = new WebSocket(origin.replace('https', 'wss') + '/ws', { ca: identity, headers: { Origin: origin.replace('https', 'http') } });
    wrong.on('error', () => {});
    assert.equal(await new Promise<number>(resolve => wrong.on('unexpected-response', (_request, response) => { response.resume(); wrong.terminate(); resolve(response.statusCode!); })), 403);
    await ClientSession.ready();
    ws = new WebSocket(origin.replace('https', 'wss') + '/ws', { ca: identity, headers: { Origin: origin } });
    let code = '', approved = false;
    const messages: Record<string, unknown>[] = [];
    client = new ClientSession(ws as unknown as SocketTransport, { serverId: info.serverId, password: remote.local.pin()!.pin,
      onPending(value) { code = value; }, onApproved() { approved = true; },
    });
    client.subscribe(message => messages.push(message));
    await until(() => !!code); assert.equal(messages.length, 0);
    remote.local.approve(remote.local.confirm(code).id);
    await until(() => approved && messages.some(message => message.type === 'snapshot'));
    client.send({ type: 'speech-status', requestId: id });
    await until(() => messages.some(message => message.type === 'speech-result' && message.requestId === id));
  } finally { client?.close(); ws?.terminate(); await remote.close(); identity.fill(0); await rm(home, { recursive: true, force: true }); }
});

test('microphone guidance recommends secure access and distinguishes denied permissions', () => {
  assert.equal(microphoneBlock(false, false), 'insecure');
  assert.equal(microphoneBlock(false, true), undefined, 'Browser-granted HTTP microphone access is not rejected');
  assert.equal(microphoneBlock(false, true, true), 'denied');
  assert.equal(microphoneBlock(true, true, true), 'denied');
  assert.equal(microphoneBlock(true, false), 'unavailable');
  assert.equal(microphoneBlock(true, true), undefined);
  assert.equal(microphoneErrorBlock(new DOMException('blocked', 'NotAllowedError')), 'denied');
  assert.equal(microphoneErrorBlock(new DOMException('missing', 'NotFoundError')), 'unavailable');
  assert.equal(microphoneErrorBlock(new Error('Network failure')), undefined);
  for (const secure of [true, false]) {
    assert.match(microphoneInstructions('insecure', secure), /trusted HTTPS.*localhost/);
    for (const block of ['insecure', 'denied', 'unavailable'] as const) {
      assert.doesNotMatch(microphoneInstructions(block, secure), /flags|about:config|insecure\.enabled/);
    }
  }
  assert.match(microphoneInstructions('denied', false), /trusted HTTPS/);
  assert.match(microphoneInstructions('denied', true), /site permissions/);
  assert.match(microphoneInstructions('unavailable', true), /Connect or enable a microphone/);
});

test('approved downloads survive disconnect, reconnect without duplication, and stop only on explicit cancel or shutdown', { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'haze-speech-download-'));
  let state: 'missing' | 'downloading' | 'ready' = 'missing', downloads = 0;
  const signals: AbortSignal[] = [];
  const remote = await startRemote({ host: '127.0.0.1', port: 0, cwd: home, executable: process.execPath,
    args: [resolve('tests/fixtures/agent.mjs')], assets: resolve('tests/fixtures'),
    speech: {
      status: async () => ({ state, downloadedBytes: state === 'downloading' ? 123 : 0 }),
      download: async signal => {
        downloads++; state = 'downloading'; signals.push(signal);
        try { await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }
        finally { state = 'missing'; }
      }, transcribe: async () => '', close() {},
    },
  });
  const origin = `http://127.0.0.1:${remote.port}`;
  const first = await connection(origin, remote.local.pin()!.pin);
  let second: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    await until(() => !!first.state.code);
    assert.equal(first.session.send({ type: 'speech-download', requestId: id }), false); assert.equal(downloads, 0);
    remote.local.approve(remote.local.confirm(first.state.code!).id);
    await until(() => first.messages.some(message => message.type === 'snapshot'));
    first.session.send({ type: 'speech-download', requestId: id });
    await until(() => first.messages.some(message => message.requestId === id && message.status?.state === 'downloading'));
    const credential = first.state.credential!;
    first.session.close(); await until(() => first.ws.readyState === WebSocket.CLOSED);
    assert.equal(signals[0].aborted, false);
    second = await connection(origin, credential.password, credential);
    await until(() => second!.messages.some(message => message.type === 'snapshot'));
    const check = 'b'.repeat(32);
    second.session.send({ type: 'speech-status', requestId: check });
    await until(() => second!.messages.some(message => message.requestId === check && message.status?.downloadedBytes === 123));
    second.session.send({ type: 'speech-download', requestId: 'c'.repeat(32) });
    await until(() => second!.messages.some(message => message.requestId === 'c'.repeat(32))); assert.equal(downloads, 1);
    second.session.send({ type: 'speech-download-cancel', requestId: 'd'.repeat(32) });
    await until(() => second!.messages.some(message => message.requestId === 'd'.repeat(32) && message.status?.state === 'missing'));
    assert.equal(signals[0].aborted, true);
    second.session.send({ type: 'speech-download', requestId: 'e'.repeat(32) });
    await until(() => downloads === 2);
    await remote.close(); assert.equal(signals[1].aborted, true);
  } finally { first.ws.terminate(); second?.ws.terminate(); await remote.close(); await rm(home, { recursive: true, force: true }); }
});

test('speech errors identify the rejected stage without misclassifying audio startup as microphone denial', () => {
  const denied = new DOMException('The request is not allowed in the current context', 'NotAllowedError');
  const mic = new SpeechCaptureError('microphone', denied);
  assert.equal(mic.name, 'NotAllowedError'); assert.equal(mic.cause, denied);
  assert.match(mic.message, /Microphone access failed/); assert.match(mic.message, /Allow for this request/);
  assert.equal(microphoneErrorBlock(mic), 'denied');
  const startup = new SpeechCaptureError('audio-startup', denied);
  assert.match(startup.message, /Audio engine startup failed/); assert.equal(microphoneErrorBlock(startup), undefined);
  const processor = new SpeechCaptureError('audio-processor', denied);
  assert.match(processor.message, /Audio capture processor failed/); assert.equal(microphoneErrorBlock(processor), undefined);
  assert.match(microphoneInstructions('denied', false), /trusted HTTPS/);
});
