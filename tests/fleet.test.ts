import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { TestSocket as WebSocket, peerHarness } from './helpers.js';
import { startRemote } from '../server/server.js';
import { connection, until, delay } from './helpers.js';
import { isFleetRequest, MAX_INSTANCES } from '../shared/fleet.js';

test('fleet request validation does not offer arbitrary paths, executables or invalid session IDs', () => {
  assert.ok(isFleetRequest({ type: 'instance-create', requestId: '1', name: 'Audit', projectId: 'project-1', allowShared: false }));
  assert.ok(!isFleetRequest({ type: 'instance-create', requestId: '1', name: 'Audit\n', projectId: 'project-1', allowShared: false }));
  assert.ok(!isFleetRequest({ type: 'instance-create', requestId: '1', name: 'Audit', projectId: '../outside', allowShared: false }));
  assert.ok(!isFleetRequest({ type: 'worker-watch', requestId: '1', instanceId: 'id', workerKey: 'bad key' }));
  assert.ok(isFleetRequest({ type: 'worker-watch', requestId: '1', instanceId: 'id', workerKey: 'abc:1:2' }));
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'haze-fleet-')));
  const cwd = join(home, 'primary'), second = join(home, 'second');
  await mkdir(cwd); await mkdir(second);
  const transport = peerHarness();
  const remote = await startRemote({ ...transport, cwd, projects: [{ cwd: second, name: 'Other worktree' }],
    executable: process.execPath, args: [resolve('tests/fixtures/observed-agent.mjs')], newArgs: [resolve('tests/fixtures/observed-agent.mjs')],
    env: { HOME: home, PATH: process.env.PATH!, LANG: 'en_US.UTF-8' } });
  return { home, cwd, second, remote, transport,
    async cleanup() { await remote.close(); await rm(home, { recursive: true, force: true }); } };
}
const latestSnapshot = (c: Awaited<ReturnType<typeof connection>>) => c.messages.filter(message => message.type === 'snapshot').at(-1);
async function approve(f: Awaited<ReturnType<typeof fixture>>) {
  const c = await connection(f, f.remote.local.pin()!.pin);
  assert.equal(c.session.send({ type: 'instance-create', requestId: 'unapproved', name: 'Denied', projectId: 'project-1', allowShared: true }), false);
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
    // macOS can drop a PTY resize notification under load, and the server no-ops a resize
    // to the current size. Alternate dimensions so every send is a real winsize change and
    // retry until the child acknowledges; finish on 80x20.
    for (let attempts = 0; attempts < 10 && !c.output().includes('SIZE 80x20'); attempts++) {
      const [cols, rows] = attempts % 2 ? [80, 20] : [81, 21];
      c.session.send({ type: 'resize', instanceId: second.instanceId, viewId: second.viewId, cols, rows });
      await until(() => c.output().includes(`SIZE ${cols}x${rows}`), 3000).catch(() => {});
    }
    await until(() => c.output().includes('ONLY-SECOND') && c.output().includes('SIZE 80x20'), 20000);
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
    const resumed = await connection(f, credential.password, credential); sockets.push(resumed.ws);
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
    await f.remote.local.revoke(); await until(() => resumed.state.closed === 4001);
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

test('observed subagents appear automatically, stream, finish, and stay inspectable without watching or plaintext leaks', { timeout: 30000 }, async () => {
  const f = await fixture(); let c: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    c = await approve(f);
    const instance = latestSnapshot(c).instanceId;
    // Observer events can land before approval; the snapshot fleet carries them.
    const fleetStates = () => [...c!.messages.filter(m => m.type === 'fleet').map(m => m.fleet.instances[0].subagents),
      ...c!.messages.filter(m => m.type === 'snapshot').map(m => m.fleet?.instances[0]?.subagents)].filter(Boolean);
    await until(() => fleetStates().some(s => s.status === 'observing'));
    await until(() => fleetStates().some(s => s.workers?.length === 1));
    const worker = fleetStates().find(s => s.workers?.length)?.workers?.[0];
    assert.ok(worker, 'worker run present');
    assert.equal(worker.id, 'worker-1');
    // The synthetic run may settle before pairing completes; identity and appearance are what this
    // stage guarantees. Active-then-settled sequencing is covered by the haze-observer unit tests.
    assert.ok(['queued', 'started', 'terminal', 'settled'].includes(worker.state), `unexpected worker state ${worker.state}`);
    assert.equal(worker.objective, 'Audit the payment module');
    assert.ok(!c.messages.some(m => m.type === 'subagent-output'), 'Output stays private until a run is inspected');
    c.session.send({ type: 'worker-watch', requestId: 'watch', instanceId: instance, workerKey: worker.key });
    await until(() => c!.messages.some(m => m.type === 'subagent-output' && m.output.includes('streamed chunk')));
    let frame = c.messages.filter(m => m.type === 'subagent-output').at(-1);
    assert.ok(frame.revision > 0);
    await until(() => c!.messages.some(m => m.type === 'subagent-output' && m.result === 'Audit complete: 2 findings, both fixed.'));
    await until(() => fleetStates().some(s => s.workers?.[0]?.state === 'settled'));
    const finished = fleetStates().find(s => s.workers?.[0]?.state === 'settled')?.workers?.[0];
    assert.ok(finished, 'settled run present');
    assert.equal(finished.state, 'settled'); assert.equal(finished.termination, 'completed');
    // Finished runs remain inspectable with their full retained output.
    const last = c.messages.filter(m => m.type === 'subagent-output').at(-1);
    assert.ok(last.output.includes('streamed chunk')); assert.ok(last.truncated === false);
    c.session.send({ type: 'worker-unwatch', requestId: 'unwatch', instanceId: instance });
    await until(() => c!.messages.some(m => m.type === 'fleet-result' && m.requestId === 'unwatch'));
    assert.ok(c.wire.every(frame => !frame.includes('synthetic-session') && !frame.includes(f.cwd)));
  } finally { c?.ws.terminate(); await f.cleanup(); }
});

test('fleet observer status is reported and never disturbs terminal control', { timeout: 30000 }, async () => {
  const f = await fixture(); let c: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    c = await approve(f);
    const instance = latestSnapshot(c).instanceId;
    // Status arrives either in the snapshot fleet or via a later fleet update.
    await until(() => {
      const states = [...c!.messages.filter(m => m.type === 'fleet').map(m => m.fleet.instances[0].subagents.status),
        latestSnapshot(c!)?.fleet.instances[0].subagents.status];
      return states.includes('observing') || states.includes('unsupported');
    });
    c.session.send({ type: 'instance-stop', requestId: 'stop', instanceId: instance });
    await until(() => c!.messages.some(m => m.type === 'fleet-result' && m.requestId === 'stop'));
    await until(() => latestSnapshot(c!)?.fleet.instances[0].state !== 'running' || c!.messages.some(m => m.type === 'exit'));
  } finally { c?.ws.terminate(); await f.cleanup(); }
});
