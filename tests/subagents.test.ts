import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SubagentReader } from '../server/subagents.js';

const at = '2026-10-07T12:00:00.000Z';
const jsonl = (value: unknown) => JSON.stringify(value) + '\n';
const event = (name: string, text?: string) => jsonl({ type: 'event', name, text, at });
const worker = (id = 'worker-1', fields: Record<string, unknown> = {}) => event('subagent_state', JSON.stringify({ type: 'subagent_state', id, mode: 'implement', state: 'queued', running: 0, at, ...fields }));

// HOME is always an explicit synthetic temporary directory. No user sessions/config are read.
async function fixture(run: (f: { home: string; cwd: string; project: string; path: string; header: string; reader: SubagentReader }) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'haze-subagents-'));
  const cwd = resolve(home, 'project');
  const project = join(home, '.haze', 'sessions', createHash('sha256').update(cwd).digest('hex').slice(0, 16));
  const path = join(project, 'linked.jsonl');
  const header = jsonl({ type: 'header', id: 'linked', cwd });
  try {
    await mkdir(project, { recursive: true });
    await run({ home, cwd, project, path, header, reader: new SubagentReader(cwd, 'linked', home) });
  } finally { await rm(home, { recursive: true, force: true }); }
}

test('linked lifecycle, quarantine, goal occurrence scopes, and turn reuse', async () => {
  await fixture(async ({ reader, path, header }) => {
    assert.equal((await reader.poll()).status, 'loading');
    await writeFile(path, header + event('goal_start') + worker());
    let feed = await reader.poll();
    assert.equal(feed.status, 'live');
    assert.deepEqual(feed.workers, [{ key: '1:worker-1', id: 'worker-1', scope: 1, mode: 'implement', state: 'queued', at }]);
    await appendFile(path, event('turn_start') + worker('worker-1', { state: 'started', queueMs: 12 }));
    feed = await reader.poll();
    assert.equal(feed.workers.length, 1);
    assert.equal(feed.workers[0].state, 'started');
    await appendFile(path, worker('worker-1', { state: 'terminal', execution: 'quarantined', termination: 'deadline_exceeded', durationMs: 50 }));
    feed = await reader.poll();
    assert.equal(feed.workers[0].execution, 'quarantined');
    assert.equal(feed.workers[0].termination, 'deadline_exceeded');
    await appendFile(path, worker('worker-1', { state: 'settled', execution: 'settled' }) + event('goal_start') + worker());
    feed = await reader.poll();
    assert.equal(feed.workers.length, 2);
    assert.deepEqual(feed.workers.map(w => [w.key, w.state]), [['1:worker-1', 'settled'], ['2:worker-1', 'queued']]);
    // Feed snapshots cannot mutate the reader.
    feed.workers[0].id = 'mutated';
    assert.equal((await reader.poll()).workers[0].id, 'worker-1');
    await appendFile(path, event('clear'));
    assert.deepEqual((await reader.poll()).workers, []);
  });
});

test('only allowlisted envelopes and fields; invalid enums and raw output never escape', async () => {
  await fixture(async ({ reader, path, header }) => {
    const marker = 'synthetic-private-prompt';
    const valid = { type: 'subagent_state', running: 1, id: 'worker-1', mode: 'inspect', state: 'started', at };
    await writeFile(path, header
      + jsonl({ type: 'message', name: 'subagent_state', text: JSON.stringify(valid), prompt: marker })
      + jsonl(valid) + event('tool_output', marker)
      + event('subagent_state', 'not JSON ' + marker)
      + worker('bad-mode', { mode: 'execute' }) + worker('bad-state', { state: 'finished' })
      + worker('bad-execution', { execution: 'running' }) + worker('bad-termination', { termination: 'timeout' })
      + worker('bad-array', { execution: ['settled'] })
      + worker('bad-time', { durationMs: -1 }) + worker('bad-queue', { queueMs: '5' })
      + worker('../bad')
      + event('subagent_state', JSON.stringify({ ...valid, prompt: marker, toolOutput: marker, key: marker, scope: 999 })));
    const feed = await reader.poll();
    assert.equal(feed.workers.length, 1);
    assert.deepEqual(feed.workers[0], { id: 'worker-1', mode: 'inspect', state: 'started', at, key: '0:worker-1', scope: 0 });
    assert.ok(!JSON.stringify(feed).includes(marker));
  });
});

test('explicit project and session only; no discovery', async () => {
  await fixture(async ({ reader, home, cwd, project, path, header }) => {
    await writeFile(join(project, 'other.jsonl'), header + worker());
    const wrongProject = join(home, '.haze', 'sessions', '0000000000000000');
    await mkdir(wrongProject);
    await writeFile(join(wrongProject, 'linked.jsonl'), header + worker());
    assert.equal((await reader.poll()).status, 'loading');
    await writeFile(path, header + worker());
    assert.equal((await new SubagentReader(join(cwd, '..', 'project'), 'linked', home).poll()).status, 'live');
    assert.equal((await new SubagentReader(join(home, 'different'), 'linked', home).poll()).status, 'loading');
  });
});

test('invalid IDs and headers are generic errors without path or source text', async () => {
  await fixture(async ({ reader, home, cwd, path }) => {
    for (const id of ['', '.', '..', '../linked', '/linked', 'a/b', 'a\\b', 'x'.repeat(161), 'bad\n']) {
      const feed = await new SubagentReader(cwd, id, home).poll();
      assert.equal(feed.status, 'error');
      assert.equal(feed.sessionId, undefined);
      assert.equal(feed.message, 'Invalid session ID.');
    }
    const marker = 'synthetic-invalid-header';
    for (const header of [marker + '\n', jsonl({ type: 'header', id: 'wrong', cwd }),
      jsonl({ type: 'header', id: 'linked', cwd: cwd + '/wrong' }),
      jsonl({ type: 'message', id: 'linked', cwd }), '\n', 'x'.repeat(65537) + '\n']) {
      await writeFile(path, header + worker());
      const feed = await reader.poll();
      assert.equal(feed.status, 'error');
      assert.deepEqual(feed.workers, []);
      assert.equal(feed.message, 'Unable to read the linked session.');
      assert.ok(!JSON.stringify(feed).includes(home));
      assert.ok(!JSON.stringify(feed).includes(marker));
    }
  });
});

test('rejects symlink session files and every controlled directory, including HOME', async () => {
  await fixture(async ({ reader, home, cwd, project, path, header }) => {
    const target = join(home, 'synthetic-target.jsonl');
    await writeFile(target, header + worker());
    await symlink(target, path);
    assert.equal((await reader.poll()).status, 'error');
    await rm(path);
    await mkdir(path);
    assert.equal((await reader.poll()).status, 'error');
    await rm(path, { recursive: true });
    await writeFile(path, header);
    for (const dir of [project, join(home, '.haze', 'sessions'), join(home, '.haze')]) {
      const moved = dir + '-original';
      await rename(dir, moved);
      await symlink(moved, dir);
      assert.equal((await reader.poll()).status, 'error');
      await rm(dir); await rename(moved, dir);
    }
    const alias = join(home, 'home-alias');
    await symlink(home, alias);
    assert.equal((await new SubagentReader(cwd, 'linked', alias).poll()).status, 'error');
  });
});

test('partial header, line and UTF-8 bytes remain buffered until newline', async () => {
  await fixture(async ({ reader, path, header }) => {
    await writeFile(path, header.slice(0, -1));
    assert.equal((await reader.poll()).status, 'loading');
    await appendFile(path, '\n');
    assert.equal((await reader.poll()).status, 'live');
    const bytes = Buffer.from(worker('worker-1', { prompt: 'café synthetic' }));
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    await appendFile(path, bytes.subarray(0, split));
    assert.deepEqual((await reader.poll()).workers, []);
    await appendFile(path, bytes.subarray(split, -1));
    assert.deepEqual((await reader.poll()).workers, []);
    await appendFile(path, '\n');
    assert.equal((await reader.poll()).workers.length, 1);
  });
});

test('256KiB poll budget, oversized line skipping, and 100-row bound', async () => {
  await fixture(async ({ reader, path, header }) => {
    await writeFile(path, header + 'x'.repeat(300 * 1024) + '\n' + worker('after-long-line'));
    let feed = await reader.poll();
    assert.equal(feed.status, 'loading');
    assert.deepEqual(feed.workers, []);
    feed = await reader.poll();
    assert.equal(feed.status, 'live');
    assert.equal(feed.workers[0].id, 'after-long-line');
    await appendFile(path, Array.from({ length: 110 }, (_, i) => worker(`worker-${i}`)).join(''));
    feed = await reader.poll();
    assert.equal(feed.workers.length, 100);
    assert.equal(feed.workers[0].id, 'worker-10');
    assert.equal(feed.workers.at(-1)?.id, 'worker-109');
  });
});

test('replacement, truncation and disappearance clear prior workers, scopes and partial bytes', async () => {
  await fixture(async ({ reader, path, header }) => {
    await writeFile(path, header + event('goal_start') + worker('old') + '{"partial":');
    assert.equal((await reader.poll()).workers[0].scope, 1);
    await writeFile(path + '-replacement', header + worker('new'));
    await rename(path + '-replacement', path);
    let feed = await reader.poll();
    assert.deepEqual(feed.workers.map(w => [w.id, w.scope]), [['new', 0]]);
    await writeFile(path, header);
    feed = await reader.poll();
    assert.equal(feed.status, 'live');
    assert.deepEqual(feed.workers, []);
    await appendFile(path, worker('after-truncate'));
    assert.equal((await reader.poll()).workers[0].id, 'after-truncate');
    await rm(path);
    feed = await reader.poll();
    assert.equal(feed.status, 'loading');
    assert.deepEqual(feed.workers, []);
    await writeFile(path, header + worker('recreated'));
    const [first, second] = await Promise.all([reader.poll(), reader.poll()]);
    assert.deepEqual(first.workers, second.workers);
    assert.equal(first.workers[0].id, 'recreated');
  });
});
