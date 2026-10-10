import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { TestSocket as WebSocket, peerHarness } from './helpers.js';
import { startRemote } from '../server/server.js';
import { connection, delay, until } from './helpers.js';

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'haze-remote-test-'));
  const transport = peerHarness();
  const remote = await startRemote({ ...transport, cwd, executable: process.execPath, args: [resolve('tests/fixtures/agent.mjs')] });
  return { cwd, remote, transport, async cleanup() { await remote.close(); await rm(cwd, { recursive: true, force: true }); } };
}

test('QR-secret enrollment, encrypted PTY, one device, reconnect snapshots, revocation and shutdown', { timeout: 30000 }, async () => {
  const f = await fixture();
  const sockets: WebSocket[] = [];
  try {
    const first = await connection(f, f.remote.local.pin()!.pin);
    sockets.push(first.ws);
    assert.equal(first.session.send({ type: 'input', data: 'should not execute' }), false);
    await until(() => first.output().includes('READY') && !!first.state.credential);
    assert.equal(f.remote.local.pin(), null);
    await assert.rejects(f.remote.local.pair(), /Revoke/);
    const credential = first.state.credential!;
    assert.equal(first.messages[0].pid, f.remote.pid);
    first.session.send({ type: 'input', data: 'PRIVATE café 🦊' });
    first.session.send({ type: 'resize', cols: 90, rows: 28 });
    await until(() => first.output().includes('PRIVATE café 🦊') && first.output().includes('SIZE 90x28'));
    assert.ok(first.wire.every(frame => !frame.includes('PRIVATE') && !frame.includes(f.cwd) && !frame.includes(credential.password)));
    const simultaneous = await connection(f, credential.password, credential);
    sockets.push(simultaneous.ws);
    await until(() => simultaneous.state.closed === 4000);
    assert.equal(simultaneous.messages.length, 0, 'Second tab cannot take over');
    first.session.close();
    await until(() => first.ws.readyState === WebSocket.CLOSED);
    const before = (await readFile(join(f.cwd, 'heartbeat.txt'))).length;
    await delay(200);
    assert.ok((await readFile(join(f.cwd, 'heartbeat.txt'))).length > before);
    const second = await connection(f, credential.password, credential);
    sockets.push(second.ws);
    await until(() => second.output().includes('PRIVATE café 🦊'));
    assert.equal(second.messages[0].pid, f.remote.pid);
    assert.equal(second.messages[0].cols, 90);
    second.session.send({ type: 'input', data: 'screen' });
    await until(() => second.output().includes('SCREEN café 🦊'));
    second.session.close(); await until(() => second.ws.readyState === WebSocket.CLOSED);
    const third = await connection(f, credential.password, credential);
    sockets.push(third.ws);
    await until(() => third.output().includes('SCREEN café 🦊'));
    assert.ok(!third.output().includes('READY'));
    assert.ok(third.messages[0].data.includes('\x1b]10;rgb:a5/dc/c9\x07'));
    await f.remote.local.revoke();
    await until(() => third.state.closed === 4001);
    assert.equal(f.remote.local.pin(), null, 'Revocation does not silently reopen pairing');
    const revoked = await connection(f, credential.password, credential);
    sockets.push(revoked.ws); await until(() => revoked.state.closed === 4001);
    assert.equal(revoked.messages.length, 0);
    process.kill(f.remote.pid, 0);
    await f.remote.local.pair(); assert.ok(f.remote.local.pin());
    const fresh = await connection(f, f.remote.local.pin()!.pin);
    sockets.push(fresh.ws); await until(() => !!fresh.state.code);
    await until(() => fresh.messages.length > 0);
    fresh.session.send({ type: 'input', data: '\x03' });
    await until(() => fresh.messages.some(m => m.type === 'exit' && m.exitCode === 0));
    fresh.session.close(); await until(() => fresh.ws.readyState === WebSocket.CLOSED);
    const final = await connection(f, fresh.state.credential!.password, fresh.state.credential!);
    sockets.push(final.ws); await until(() => final.messages.length > 0);
    assert.equal(final.messages[0].exit.exitCode, 0);
  } finally { sockets.forEach(ws => ws.terminate()); await f.cleanup(); }
});

test('plaintext and replayed frames cannot control PTY; invalid resize rejected', { timeout: 20000 }, async () => {
  const f = await fixture();
  const sockets: WebSocket[] = [];
  try {
    const unauth = f.transport.socket();
    sockets.push(unauth);
    const closed = new Promise<number>(r => unauth.on('close', code => r(code)));
    unauth.send(JSON.stringify({ type: 'input', data: 'plaintext' }));
    assert.equal(await closed, 4001);
    const first = await connection(f, f.remote.local.pin()!.pin); sockets.push(first.ws);
    await until(() => !!first.state.code);
    await until(() => first.messages.length > 0);
    first.session.send({ type: 'resize', cols: 999999, rows: -1 });
    await until(() => first.state.closed === 1008);
    const credential = first.state.credential!;
    const second = await connection(f, credential.password, credential); sockets.push(second.ws);
    await until(() => second.messages.length > 0);
    let captured = '';
    const original = second.ws.send.bind(second.ws);
    second.ws.send = ((data: any) => { captured = data.toString(); original(data); }) as any;
    second.session.send({ type: 'input', data: 'ONCE_ONLY' });
    await until(() => second.output().includes('ONCE_ONLY'));
    original(captured);
    await until(() => second.state.closed === 1008);
    const third = await connection(f, credential.password, credential); sockets.push(third.ws);
    await until(() => third.messages.length > 0);
    third.ws.send(JSON.stringify({ type: 'input', data: 'PLAINTEXT_FORBIDDEN' }));
    await until(() => third.state.closed === 1008);
    process.kill(f.remote.pid, 0);
    await f.remote.close(); assert.throws(() => process.kill(f.remote.pid, 0));
  } finally { sockets.forEach(ws => ws.terminate()); await f.cleanup(); }
});

test('encrypted write failure closes the stream and is never retried', { timeout: 15000 }, async () => {
  const f = await fixture();
  let c: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    c = await connection(f, f.remote.local.pin()!.pin);
    await until(() => !!c!.state.code);
    await until(() => c!.messages.some(m => m.type === 'snapshot'));
    c.ws.send = (() => { throw new Error('synthetic write failure'); }) as any;
    assert.throws(() => c!.session.send({ type: 'input', data: 'never-retry' }), /synthetic write failure/);
    await until(() => c!.ws.readyState === WebSocket.CLOSED);
    assert.equal(c.session.send({ type: 'input', data: 'never-retry' }), false);
    assert.ok(!c.output().includes('never-retry'));
  } finally { c?.ws.terminate(); await f.cleanup(); }
});

test('backpressure refuses client writes and closes a slow server stream', async () => {
  const f = await fixture();
  const c = await connection(f, f.remote.local.pin()!.pin);
  try {
    await until(() => c.messages.some(m => m.type === 'snapshot'));
    c.ws.bufferedAmount = 256 * 1024 + 1;
    assert.equal(c.session.send({ type: 'input', data: 'not queued' }), false);
    c.ws.bufferedAmount = 0;
    c.ws.peer.bufferedAmount = 4 * 1024 * 1024 + 1;
    c.session.send({ type: 'ping' });
    await until(() => c.state.closed === 1013);
    assert.ok(!c.output().includes('not queued'));
  } finally { c.ws.terminate(); await f.cleanup(); }
});

test('pairing URL exposes only the room and secret; cancel/reopen/revoke are asynchronous', async () => {
  const f = await fixture();
  try {
    assert.equal('port' in f.remote, false, 'No public application listener');
    const first = new URL(f.remote.pairingUrl()!);
    assert.equal(first.protocol, 'https:');
    assert.equal(first.pathname, '/remote/');
    const fragment = new URLSearchParams(first.hash.slice(1));
    assert.equal(fragment.get('room'), f.remote.serverId);
    assert.equal(fragment.get('secret'), f.remote.local.pin()!.pin);
    assert.deepEqual([...fragment.keys()].sort(), ['room', 'secret']);
    await f.remote.local.cancel();
    assert.equal(f.remote.local.pin(), null);
    assert.equal(f.remote.pairingUrl(), undefined);
    await f.remote.local.pair();
    assert.ok(f.remote.local.pin());
    assert.ok(f.remote.pairingUrl());
    await f.remote.local.revoke();
    assert.equal(f.remote.pairingUrl(), undefined);
    process.kill(f.remote.pid, 0);
  } finally { await f.cleanup(); }
});
