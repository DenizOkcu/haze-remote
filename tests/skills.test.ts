import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SkillManager } from '../server/skills.js';
import { isSkillRequest } from '../shared/skills.js';
import { startRemote } from '../server/server.js';
import { connection, until } from './helpers.js';

const markdown = (name: string, description = 'A useful workflow') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# Procedure\nInspect and report.\n`;
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'haze-skills-'));
  const home = join(base, 'home'), cwd = join(base, 'project');
  await mkdir(home); await mkdir(cwd);
  const manager = new SkillManager([{ id: 'project-1', name: 'Project', cwd }], home);
  const create = (directory: string, scopeId = 'project-1') => manager.execute({ type: 'skill-create', requestId: 'create', directory, scopeId, content: markdown(directory) }, () => true);
  return { base, home, cwd, manager, create, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('skills discover both scopes, preserve duplicate names, create/edit persistently, reject conflicts and invalid documents', async () => {
  const f = await fixture();
  try {
    const first = (await f.create('review')).document!;
    await f.create('review', 'global');
    const catalog = await f.manager.catalog();
    assert.equal(catalog.skills.length, 2); assert.equal(catalog.scopes.length, 2);
    const updated = await f.manager.execute({ type: 'skill-save', requestId: 'save', skillId: first.id, revision: first.revision, content: markdown('review', 'Updated description') }, () => true);
    assert.equal(updated.document!.description, 'Updated description');
    assert.equal(await readFile(first.path, 'utf8'), updated.document!.content);
    await assert.rejects(f.manager.execute({ type: 'skill-save', requestId: 'stale', skillId: first.id, revision: first.revision, content: first.content }, () => true), /changed on disk/);
    await assert.rejects(f.create('review'), /already exists/);
    await assert.rejects(f.manager.execute({ type: 'skill-save', requestId: 'bad', skillId: first.id, revision: updated.document!.revision, content: 'not frontmatter' }, () => true), /frontmatter/);
    await writeFile(first.path, 'broken YAML');
    assert.match((await f.manager.catalog()).skills.find(skill => skill.id === first.id)!.error!, /frontmatter/);
    const broken = (await f.manager.execute({ type: 'skill-read', requestId: 'read', skillId: first.id }, () => true)).document!;
    await f.manager.execute({ type: 'skill-save', requestId: 'repair', skillId: first.id, revision: broken.revision, content: markdown('review') }, () => true);
    await assert.rejects(f.manager.execute({ type: 'skills-list', requestId: 'revoked' }, () => false), /approved/);
  } finally { await f.cleanup(); }
});

test('skills reject browser paths, symlinks, hardlinks, oversized files, and unsafe roots', async () => {
  assert.equal(isSkillRequest({ type: 'skill-create', requestId: 'a', scopeId: 'project-1', directory: '../escape', content: markdown('x') }), false);
  assert.equal(isSkillRequest({ type: 'skill-read', requestId: 'a', skillId: '/arbitrary/path' }), false);
  const f = await fixture();
  try {
    const first = (await f.create('regular')).document!;
    const root = join(f.cwd, '.haze', 'skills');
    const target = join(f.base, 'outside.md'); await writeFile(target, markdown('outside'));
    for (const name of ['symlink', 'hardlink', 'oversized']) await mkdir(join(root, name));
    await symlink(target, join(root, 'symlink', 'SKILL.md'));
    await link(target, join(root, 'hardlink', 'SKILL.md'));
    await writeFile(join(root, 'oversized', 'SKILL.md'), 'x'.repeat(256 * 1024 + 1));
    const catalog = await f.manager.catalog();
    assert.deepEqual(catalog.skills.map(skill => skill.id), [first.id]); assert.equal(catalog.warnings.length, 3);
    await rm(join(f.cwd, '.haze'), { recursive: true });
    await symlink(f.home, join(f.cwd, '.haze'));
    assert.equal((await f.manager.catalog()).skills.length, 0);
    await assert.rejects(f.create('blocked'), /Symlinked/);
    assert.equal(await readFile(target, 'utf8'), markdown('outside'));
  } finally { await f.cleanup(); }
});

test('skill data and writes require local approval and use encrypted transport', async () => {
  const f = await fixture();
  const remote = await startRemote({ host: '127.0.0.1', port: 0, cwd: f.cwd, executable: process.execPath,
    args: [resolve('tests/fixtures/agent.mjs')], assets: resolve('tests/fixtures'), env: { HOME: f.home, PATH: process.env.PATH! } });
  let c: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    await f.create('private-workflow');
    const origin = `http://127.0.0.1:${remote.port}`;
    assert.equal((await fetch(origin + '/api/skills')).status, 404);
    c = await connection(origin, remote.local.pin()!.pin);
    await until(() => !!c!.state.code);
    assert.equal(c.messages.length, 0);
    const review = remote.local.confirm(c.state.code!); remote.local.approve(review.id);
    await until(() => c!.messages.some(message => message.type === 'snapshot'));
    c.session.send({ type: 'skills-list', requestId: 'catalog' });
    await until(() => c!.messages.some(message => message.requestId === 'catalog'));
    const catalog = c.messages.find(message => message.requestId === 'catalog').catalog;
    assert.equal(catalog.skills[0].name, 'private-workflow');
    c.session.send({ type: 'skill-read', requestId: 'read', skillId: catalog.skills[0].id });
    await until(() => c!.messages.some(message => message.requestId === 'read'));
    const document = c.messages.find(message => message.requestId === 'read').document;
    c.session.send({ type: 'skill-save', requestId: 'save', skillId: document.id, revision: document.revision, content: markdown('private-workflow', 'Encrypted edit') });
    await until(() => c!.messages.some(message => message.requestId === 'save'));
    assert.equal(c.messages.find(message => message.requestId === 'save').document.description, 'Encrypted edit');
    assert.ok(!c.wire.join('').includes('private-workflow')); assert.ok(!c.wire.join('').includes('Encrypted edit'));
    c.session.send({ type: 'skill-create', requestId: 'bad', scopeId: 'project-1', directory: '../escape', content: markdown('x') });
    await until(() => c!.messages.some(message => message.requestId === 'bad'));
    assert.equal(c.messages.find(message => message.requestId === 'bad').type, 'skills-error');
  } finally { c?.session.close(); await remote.close(); await f.cleanup(); }
});
