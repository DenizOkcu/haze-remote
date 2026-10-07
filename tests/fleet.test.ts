import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { WebSocket } from 'ws';
import { startRemote } from '../server/server.js';
import { connection, until, delay } from './helpers.js';
import { isFleetRequest, MAX_INSTANCES } from '../shared/fleet.js';

test('fleet request validation does not offer arbitrary paths, executables or invalid session IDs', () => {
  assert.ok(isFleetRequest({ type: 'instance-create', requestId: '1', name: 'Audit', projectId: 'project-1', allowShared: false }));
  assert.ok(!isFleetRequest({ type: 'instance-create', requestId: '1', name: 'Audit\n', projectId: 'project-1', allowShared: false }));
  assert.ok(!isFleetRequest({ type: 'instance-create', requestId: '1', name: 'Audit', projectId: '../outside', allowShared: false }));
  assert.ok(!isFleetRequest({ type: 'subagents-link', requestId: '1', instanceId: 'id', sessionId: '../secret' }));
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'haze-fleet-')));
  const cwd = join(home, 'primary'), second = join(home, 'second');
  await mkdir(cwd); await mkdir(second);
  const remote = await startRemote({ host: '127.0.0.1', port: 0, cwd, projects: [{ cwd: second, name: 'Other worktree' }],
    executable: process.execPath, args: [resolve('tests/fixtures/agent.mjs')], newArgs: [resolve('tests/fixtures/agent.mjs')], assets: resolve('tests/fixtures'),
    env: { HOME: home, PATH: process.env.PATH!, LANG: 'en_US.UTF-8' } });
  return { home, cwd, second, remote, origin: `http://127.0.0.1:${remote.port}`,
    async cleanup() { await remote.close(); await rm(home, { recursive: true, force: true }); } };
}
const latestSnapshot = (c: Awaited<ReturnType<typeof connection>>) => c.messages.filter(message => message.type === 'snapshot').at(-1);
async function approve(f: Awaited<ReturnType<typeof fixture>>) {
  const c = await connection(f.origin, f.remote.local.pin()!.pin);
  await until(() => !!c.state.code);
  assert.equal(c.session.send({ type: 'instance-create', requestId: 'unapproved', name: 'Denied', projectId: 'project-1', allowShared: true }), false);
  assert.equal(c.messages.length, 0);
  f.remote.local.approve(f.remote.local.confirm(c.state.code!).id);
  await until(() => !!latestSnapshot(c));
  return c;
}
test('fleet instances have isolated PTYs, scoped input/resize, idempotent creation, reconnect and independent lifecycle', { timeout: 30000 }, async () => {
  const f = await fixture(); const sockets: WebSocket[] = [];
  try {
    const c = await approve(f); sockets.push(c.ws);
    const primary = latestSnapshot(c);
    assert.equal(primary.instanceId, f.remote.instanceId);
    assert.equal(primary.fleet.instances.length, 1);
    const publicInfo = await (await fetch(f.origin + '/api/info')).json();
    assert.ok(!('fleet' in publicInfo) && !('projects' in publicInfo));
    assert.equal((await fetch(f.origin + '/api/fleet')).status, 404);
    c.session.send({ type: 'input', instanceId: primary.instanceId, viewId: primary.viewId, data: 'ONLY-PRIMARY' });
    await until(() => c.output().includes('ONLY-PRIMARY'));
    c.session.send({ type: 'instance-create', requestId: 'shared-denied', name: 'Denied', projectId: 'project-1', allowShared: false });
    await until(() => c.messages.some(m => m.type === 'fleet-error' && m.requestId === 'shared-denied'));
    c.session.send({ type: 'instance-create', requestId: 'outside-denied', name: 'Denied', projectId: 'project-99', allowShared: true });
    await until(() => c.messages.some(m => m.type === 'fleet-error' && m.requestId === 'outside-denied'));
    const create = { type: 'instance-create', requestId: 'new-1', name: 'Tests', projectId: 'project-2', allowShared: true };
    c.session.send(create); c.session.send(create);
    await until(() => latestSnapshot(c)?.requestId === 'new-1');
    const second = latestSnapshot(c);
    assert.notEqual(second.pid, primary.pid); assert.equal(second.cwd, f.second);
    assert.equal(second.fleet.instances.length, 2, 'Retrying a create request does not duplicate its process');
    assert.ok(!second.data.includes('ONLY-PRIMARY'));
    c.session.send({ type: 'input', instanceId: primary.instanceId, viewId: primary.viewId, data: 'STALE-INPUT' });
    await until(() => c.messages.some(m => m.type === 'fleet-error' && m.message.includes('selection changed')));
    assert.ok(!c.output().includes('STALE-INPUT'));
    const errorsBefore = c.messages.filter(m => m.type === 'fleet-error').length;
    c.session.send({ type: 'input', data: 'OMITTED-ID-INPUT' });
    c.session.send({ type: 'resize', cols: 60, rows: 10 });
    await until(() => c.messages.filter(m => m.type === 'fleet-error').length === errorsBefore + 2);
    assert.ok(!c.output().includes('OMITTED-ID-INPUT'));
    // Failed requests cannot evict a successfully deduplicated launch.
    for (let i = 0; i < 33; i++) c.session.send({ type: 'instance-create', requestId: `failed-${i}`, name: 'Denied', projectId: 'project-99', allowShared: true });
    await until(() => c.messages.filter(m => m.type === 'fleet-error' && m.requestId?.startsWith('failed-')).length === 33);
    const snapshotCount = c.messages.filter(m => m.type === 'snapshot').length;
    c.session.send(create);
    await until(() => c.messages.filter(m => m.type === 'snapshot').length > snapshotCount);
    assert.equal(latestSnapshot(c).fleet.instances.length, 2);
    assert.equal(latestSnapshot(c).pid, second.pid);
    second.viewId = latestSnapshot(c).viewId;
    c.session.send({ type: 'input', instanceId: second.instanceId, viewId: second.viewId, data: 'ONLY-SECOND' });
    c.session.send({ type: 'resize', instanceId: second.instanceId, viewId: second.viewId, cols: 80, rows: 20 });
    await until(() => c.output().includes('ONLY-SECOND') && c.output().includes('SIZE 80x20'));
    c.session.send({ type: 'instance-select', requestId: 'back', instanceId: primary.instanceId });
    await until(() => latestSnapshot(c)?.requestId === 'back');
    assert.ok(latestSnapshot(c).data.includes('ONLY-PRIMARY'));
    assert.ok(!latestSnapshot(c).data.includes('ONLY-SECOND'));
    assert.equal(latestSnapshot(c).cols, 100, 'Resize belongs to its instance, not the current tab position');
    c.session.send({ type: 'instance-select', requestId: 'again', instanceId: second.instanceId });
    await until(() => latestSnapshot(c)?.requestId === 'again');
    const credential = c.state.credential!;
    c.session.close(); await until(() => c.ws.readyState === WebSocket.CLOSED);
    process.kill(primary.pid, 0); process.kill(second.pid, 0);
    const resumed = await connection(f.origin, credential.password, credential); sockets.push(resumed.ws);
    await until(() => !!latestSnapshot(resumed));
    assert.equal(latestSnapshot(resumed).instanceId, second.instanceId);
    assert.equal(latestSnapshot(resumed).pid, second.pid);
    assert.ok(latestSnapshot(resumed).data.includes('ONLY-SECOND'));
    resumed.session.send({ type: 'instance-stop', requestId: 'stop', instanceId: second.instanceId });
    await until(() => resumed.messages.some(m => m.type === 'fleet-result' && m.requestId === 'stop'));
    process.kill(primary.pid, 0); assert.throws(() => process.kill(second.pid, 0));
    resumed.session.send({ type: 'instance-close', requestId: 'close', instanceId: second.instanceId });
    await until(() => latestSnapshot(resumed)?.instanceId === primary.instanceId);
    assert.equal(latestSnapshot(resumed).fleet.instances.length, 1);
    f.remote.local.revoke(); await until(() => resumed.state.closed === 4001);
    assert.equal(resumed.session.send(create), false);
    process.kill(primary.pid, 0);
    await f.remote.close(); assert.throws(() => process.kill(primary.pid, 0));
  } finally { sockets.forEach(socket => socket.terminate()); await f.cleanup(); }
});

test('fleet cap and shutdown bound all instances; running tabs cannot be closed', { timeout: 30000 }, async () => {
  const f = await fixture(); let c: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    c = await approve(f);
    c.session.send({ type: 'instance-close', requestId: 'running-close', instanceId: f.remote.instanceId });
    await until(() => c!.messages.some(m => m.type === 'fleet-error' && m.requestId === 'running-close'));
    for (let i = 1; i < MAX_INSTANCES; i++) {
      c.session.send({ type: 'instance-create', requestId: `create-${i}`, name: `Haze ${i + 1}`, projectId: 'project-1', allowShared: true });
      await until(() => latestSnapshot(c!)?.requestId === `create-${i}`);
    }
    const pids = latestSnapshot(c).fleet.instances.map((instance: any) => instance.pid);
    assert.equal(pids.length, MAX_INSTANCES);
    c.session.send({ type: 'instance-create', requestId: 'over-limit', name: 'Denied', projectId: 'project-1', allowShared: true });
    await until(() => c!.messages.some(m => m.type === 'fleet-error' && m.requestId === 'over-limit'));
    await f.remote.close();
    pids.forEach((pid: number) => assert.throws(() => process.kill(pid, 0)));
  } finally { c?.ws.terminate(); await f.cleanup(); }
});

test('subagent sidebar data uses explicitly linked Haze records, never prompts or cross-instance ownership guesses', { timeout: 20000 }, async () => {
  const f = await fixture(); let c: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    c = await approve(f);
    const snapshot = latestSnapshot(c);
    const directory = join(f.home, '.haze', 'sessions', createHash('sha256').update(snapshot.cwd).digest('hex').slice(0, 16));
    await mkdir(directory, { recursive: true });
    const event = (name: string, inner: any) => JSON.stringify({ type: 'event', name, text: JSON.stringify(inner), at: '2026-10-07T12:00:00Z' }) + '\n';
    await writeFile(join(directory, 'linked.jsonl'), JSON.stringify({ type: 'header', id: 'linked', cwd: snapshot.cwd }) + '\n'
      + event('goal_start', { request: 'synthetic-private-prompt' })
      + event('subagent_state', { type: 'subagent_state', id: 'worker-1', mode: 'inspect', state: 'started', running: 1, at: '2026-10-07T12:00:00Z', prompt: 'synthetic-private-prompt' }));
    c.session.send({ type: 'subagents-link', requestId: 'link', instanceId: snapshot.instanceId, sessionId: 'linked' });
    await until(() => c!.messages.some(m => m.type === 'fleet' && m.fleet.instances[0].subagents.status === 'live'));
    const feed = c.messages.filter(m => m.type === 'fleet').at(-1).fleet.instances[0].subagents;
    assert.equal(feed.workers[0].id, 'worker-1'); assert.equal(feed.workers[0].state, 'started');
    assert.ok(!JSON.stringify(c.messages).includes('synthetic-private-prompt'));
    assert.ok(c.wire.every(frame => !frame.includes('worker-1') && !frame.includes(snapshot.cwd)));
    c.session.send({ type: 'subagents-unlink', requestId: 'unlink', instanceId: snapshot.instanceId });
    await until(() => c!.messages.some(m => m.type === 'fleet-result' && m.requestId === 'unlink'));
    assert.equal(c.messages.filter(m => m.type === 'fleet').at(-1).fleet.instances[0].subagents.status, 'unlinked');
    await delay(1100);
    assert.deepEqual(c.messages.filter(m => m.type === 'fleet').at(-1).fleet.instances[0].subagents.workers, []);
  } finally { c?.ws.terminate(); await f.cleanup(); }
});
