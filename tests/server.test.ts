import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { WebSocket } from 'ws';
import { startRemote, privateAddress } from '../server/server.js';
import { connection, delay, until } from './helpers.js';

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'haze-remote-test-'));
  const remote = await startRemote({ host: '127.0.0.1', port: 0, cwd, executable: process.execPath, args: [resolve('tests/fixtures/agent.mjs')], assets: resolve('tests/fixtures') });
  return { cwd, remote, origin: `http://127.0.0.1:${remote.port}`, async cleanup() { await remote.close(); await rm(cwd, { recursive: true, force: true }); } };
}

test('two-way local approval, encrypted PTY, one device, reconnect snapshots, revocation and shutdown', { timeout: 30000 }, async () => {
  const f = await fixture();
  const sockets: WebSocket[] = [];
  try {
    assert.equal((await fetch(f.origin)).status, 200);
    for (const path of ['/api/session', '/api/pair', '/api/logout', '/api/approve', '/api/confirm', '/api/revoke']) assert.equal((await fetch(f.origin + path, { method: 'POST' })).status, 404);
    const info = await (await fetch(f.origin + '/api/info')).json();
    assert.ok(!('cwd' in info) && !('pid' in info) && !('pin' in info));
    const denied = new WebSocket(f.origin.replace('http', 'ws') + '/ws', { headers: { Origin: 'http://evil.example' } });
    denied.on('error', () => {});
    assert.equal(await new Promise<number>(r => denied.on('unexpected-response', (_, res) => { res.resume(); denied.terminate(); r(res.statusCode!); })), 403);
    const first = await connection(f.origin, f.remote.local.pin()!.pin);
    sockets.push(first.ws);
    await until(() => !!first.state.code);
    await delay(200);
    assert.equal(first.messages.length, 0, 'No project metadata or output before local approval');
    assert.equal(first.session.send({ type: 'input', data: 'should not execute' }), false);
    assert.throws(() => f.remote.local.approve('invented'), /Confirm/);
    assert.throws(() => f.remote.local.confirm('invalid'));
    const review = f.remote.local.confirm(first.state.code!);
    assert.equal(review.peer, '127.0.0.1', 'Ignore forged X-Forwarded-For');
    assert.match(review.browser, /Safari/);
    assert.equal(first.messages.length, 0, 'Code B alone is not approval');
    f.remote.local.approve(review.id);
    await until(() => first.output().includes('READY') && !!first.state.credential);
    assert.equal(f.remote.local.pin(), null);
    assert.throws(() => f.remote.local.pair(), /Revoke/);
    const credential = first.state.credential!;
    assert.equal(first.messages[0].pid, f.remote.pid);
    first.session.send({ type: 'input', data: 'PRIVATE café 🦊' });
    first.session.send({ type: 'resize', cols: 90, rows: 28 });
    await until(() => first.output().includes('PRIVATE café 🦊') && first.output().includes('SIZE 90x28'));
    assert.ok(first.wire.every(frame => !frame.includes('PRIVATE') && !frame.includes(f.cwd) && !frame.includes(credential.password)));
    const simultaneous = await connection(f.origin, credential.password, credential);
    sockets.push(simultaneous.ws);
    await until(() => simultaneous.state.closed === 4000);
    assert.equal(simultaneous.messages.length, 0, 'Second tab cannot take over');
    first.session.close();
    await until(() => first.ws.readyState === WebSocket.CLOSED);
    const before = (await readFile(join(f.cwd, 'heartbeat.txt'))).length;
    await delay(200);
    assert.ok((await readFile(join(f.cwd, 'heartbeat.txt'))).length > before);
    const second = await connection(f.origin, credential.password, credential);
    sockets.push(second.ws);
    await until(() => second.output().includes('PRIVATE café 🦊'));
    assert.equal(second.messages[0].pid, f.remote.pid);
    assert.equal(second.messages[0].cols, 90);
    second.session.send({ type: 'input', data: 'screen' });
    await until(() => second.output().includes('SCREEN café 🦊'));
    second.session.close(); await until(() => second.ws.readyState === WebSocket.CLOSED);
    const third = await connection(f.origin, credential.password, credential);
    sockets.push(third.ws);
    await until(() => third.output().includes('SCREEN café 🦊'));
    assert.ok(!third.output().includes('READY'));
    assert.ok(third.messages[0].data.includes('\x1b]10;rgb:a5/dc/c9\x07'));
    f.remote.local.revoke();
    await until(() => third.state.closed === 4001);
    assert.equal(f.remote.local.pin(), null, 'Revocation does not silently reopen pairing');
    const revoked = await connection(f.origin, credential.password, credential);
    sockets.push(revoked.ws); await until(() => revoked.state.closed === 4001);
    assert.equal(revoked.messages.length, 0);
    process.kill(f.remote.pid, 0);
    f.remote.local.pair(); assert.ok(f.remote.local.pin());
    const fresh = await connection(f.origin, f.remote.local.pin()!.pin);
    sockets.push(fresh.ws); await until(() => !!fresh.state.code);
    f.remote.local.approve(f.remote.local.confirm(fresh.state.code!).id);
    await until(() => fresh.messages.length > 0);
    fresh.session.send({ type: 'input', data: '\x03' });
    await until(() => fresh.messages.some(m => m.type === 'exit' && m.exitCode === 0));
    fresh.session.close(); await until(() => fresh.ws.readyState === WebSocket.CLOSED);
    const final = await connection(f.origin, fresh.state.credential!.password, fresh.state.credential!);
    sockets.push(final.ws); await until(() => final.messages.length > 0);
    assert.equal(final.messages[0].exit.exitCode, 0);
  } finally { sockets.forEach(ws => ws.terminate()); await f.cleanup(); }
});

test('plaintext and replayed frames cannot control PTY; invalid resize rejected; private binds only', { timeout: 20000 }, async () => {
  assert.equal(privateAddress('0.0.0.0'), false); assert.equal(privateAddress('8.8.8.8'), false); assert.equal(privateAddress('192.168.1.42'), true);
  const f = await fixture();
  const sockets: WebSocket[] = [];
  try {
    const unauth = new WebSocket(f.origin.replace('http', 'ws') + '/ws', { headers: { Origin: f.origin, Cookie: 'haze_remote=old-bearer' } });
    sockets.push(unauth); unauth.on('error', () => {});
    await new Promise<void>(r => unauth.on('open', () => r()));
    const closed = new Promise<number>(r => unauth.on('close', code => r(code)));
    unauth.send(JSON.stringify({ type: 'input', data: 'plaintext' }));
    assert.equal(await closed, 4001);
    const first = await connection(f.origin, f.remote.local.pin()!.pin); sockets.push(first.ws);
    await until(() => !!first.state.code);
    f.remote.local.approve(f.remote.local.confirm(first.state.code!).id);
    await until(() => first.messages.length > 0);
    first.session.send({ type: 'resize', cols: 999999, rows: -1 });
    await until(() => first.state.closed === 1008);
    const credential = first.state.credential!;
    const second = await connection(f.origin, credential.password, credential); sockets.push(second.ws);
    await until(() => second.messages.length > 0);
    let captured = '';
    const original = second.ws.send.bind(second.ws);
    second.ws.send = ((data: any) => { captured = data.toString(); original(data); }) as any;
    second.session.send({ type: 'input', data: 'ONCE_ONLY' });
    await until(() => second.output().includes('ONCE_ONLY'));
    original(captured);
    await until(() => second.state.closed === 1008);
    const third = await connection(f.origin, credential.password, credential); sockets.push(third.ws);
    await until(() => third.messages.length > 0);
    third.ws.send(JSON.stringify({ type: 'input', data: 'PLAINTEXT_FORBIDDEN' }));
    await until(() => third.state.closed === 1008);
    process.kill(f.remote.pid, 0);
    await f.remote.close(); assert.throws(() => process.kill(f.remote.pid, 0));
  } finally { sockets.forEach(ws => ws.terminate()); await f.cleanup(); }
});

test('review extends the pending socket deadline without enabling terminal access', { timeout: 15000 }, async t => {
  const f = await fixture();
  const sockets: WebSocket[] = [];
  try {
    const first = await connection(f.origin, f.remote.local.pin()!.pin);
    sockets.push(first.ws);
    await until(() => !!first.state.code);
    await delay(100); // Enrollment must reach the server before local code entry.
    const codeDeadline = first.state.expiresAt!;
    t.mock.timers.enable({ apis: ['Date'], now: codeDeadline - 1 });
    const review = f.remote.local.confirm(first.state.code!);
    assert.equal(review.expiresAt, Date.now() + 120_000);
    await until(() => first.state.reviewExpiresAt === review.expiresAt);
    assert.throws(() => f.remote.local.confirm(first.state.code!), /consumed/);
    t.mock.timers.tick(2); // Cross the original code deadline, not the review deadline.
    await delay(300); // Exercise the real lifecycle interval and socket deadline.
    assert.equal(first.state.closed, undefined);
    assert.equal(first.messages.length, 0);
    assert.equal(first.session.send({ type: 'input', data: 'NO_ACCESS_YET' }), false);
    t.mock.timers.tick(review.expiresAt - Date.now() - 1);
    f.remote.local.approve(review.id);
    await until(() => first.messages.some(m => m.type === 'snapshot'));
    t.mock.timers.reset();
    f.remote.local.revoke();
    await until(() => first.state.closed === 4001);
    f.remote.local.pair();
    const second = await connection(f.origin, f.remote.local.pin()!.pin);
    sockets.push(second.ws);
    await until(() => !!second.state.code);
    await delay(100);
    const secondReview = f.remote.local.confirm(second.state.code!);
    await until(() => second.state.reviewExpiresAt === secondReview.expiresAt);
    t.mock.timers.enable({ apis: ['Date'], now: secondReview.expiresAt });
    assert.throws(() => f.remote.local.approve(secondReview.id), /expired/);
    await until(() => second.state.closed === 4001);
    assert.equal(second.messages.length, 0);
    assert.equal(second.state.credential, undefined);
    process.kill(f.remote.pid, 0);
  } finally {
    t.mock.timers.reset();
    sockets.forEach(ws => ws.terminate()); await f.cleanup();
  }
});
