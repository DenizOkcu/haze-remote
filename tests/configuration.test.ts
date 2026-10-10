import { peerHarness } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigurationManager } from '../server/configuration.js';
import { isManagementRequest } from '../shared/configuration.js';
import { startRemote } from '../server/server.js';
import { connection, until } from './helpers.js';

const provider = (name: string, extra: Record<string, unknown> = {}) => ({ name, url: `https://${name}.example/v1`, models: [{ id: 'model-a' }], ...extra });
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'haze-config-'));
  const home = join(base, 'home'), cwd = join(base, 'project');
  await mkdir(home); await mkdir(cwd);
  const manager = new ConfigurationManager(home);
  return { base, home, cwd, manager, settings: join(home, '.haze', 'settings.json'), cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('configuration reads sanitized providers without keys, enforces validation and revision, and preserves unknown fields', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, '.haze'));
    await writeFile(f.settings, JSON.stringify({ provider: 'openai', model: 'gpt-x', providers: [provider('openai', { key: 'SECRET', capabilities: { images: true } })], theme: 'solarized-dark', apiKey: 'LEGACY-SECRET', customField: { keep: true } }));
    const first = await f.manager.readView();
    assert.equal(first.providers.length, 1);
    assert.equal(first.providers[0].hasKey, true);
    assert.equal('key' in first.providers[0], false);
    assert.equal(JSON.stringify(first).includes('SECRET'), false);
    assert.equal(first.settings.theme, 'solarized-dark');
    assert.equal('apiKey' in first, false); assert.equal('customField' in first, false);
    await assert.rejects(f.manager.execute({ type: 'provider-save', revision: '0'.repeat(64), provider: provider('x') }, () => true), /changed on your computer/);
    const saved = await f.manager.execute({ type: 'provider-save', revision: first.revision, originalName: 'openai', provider: { name: 'openai', url: 'https://openai.example/v1', kind: 'openai-compatible', models: [{ id: 'model-a', contextWindowTokens: 1000 }], images: true } }, () => true);
    assert.equal(saved.providers[0].models[0].contextWindowTokens, 1000);
    const disk = JSON.parse(await readFile(f.settings, 'utf8'));
    assert.equal(disk.providers[0].key, 'SECRET'); // blank key preserved
    assert.equal(disk.customField.keep, true); assert.equal(disk.apiKey, 'LEGACY-SECRET');
    const rotated = await f.manager.execute({ type: 'provider-save', revision: saved.revision, originalName: 'openai', provider: provider('openai'), key: 'NEW-KEY' }, () => true);
    assert.equal(JSON.parse(await readFile(f.settings, 'utf8')).providers[0].key, 'NEW-KEY');
    const cleared = await f.manager.execute({ type: 'provider-save', revision: rotated.revision, originalName: 'openai', provider: provider('openai'), clearKey: true }, () => true);
    assert.equal('key' in JSON.parse(await readFile(f.settings, 'utf8')).providers[0], false);
    assert.equal(cleared.providers[0].hasKey, false);
    await assert.rejects(f.manager.execute({ type: 'provider-save', revision: cleared.revision, provider: provider('openai') }, () => true), /already exists/);
    await assert.rejects(f.manager.execute({ type: 'provider-save', revision: cleared.revision, provider: { name: 'bad', url: 'file:///etc', kind: 'openai-compatible', models: [{ id: 'm' }] } }, () => true), /Invalid provider/);
    await assert.rejects(f.manager.execute({ type: 'provider-save', revision: cleared.revision, provider: { name: 'dup', url: 'https://dup.example', kind: 'openai-compatible', models: [{ id: 'm' }, { id: 'm' }] } }, () => true), /unique|Models/i);
    const added = await f.manager.execute({ type: 'provider-save', revision: cleared.revision, provider: provider('local', { url: 'http://localhost:1234/v1' }) }, () => true);
    const defaults = await f.manager.execute({ type: 'provider-default', revision: added.revision, name: 'local', model: 'model-a' }, () => true);
    assert.equal(defaults.provider, 'local'); assert.equal(defaults.model, 'model-a');
    await assert.rejects(f.manager.execute({ type: 'provider-default', revision: defaults.revision, name: 'local', model: 'missing' }, () => true), /not offered/);
    const afterRemove = await f.manager.execute({ type: 'provider-remove', revision: defaults.revision, name: 'openai' }, () => true);
    assert.equal(afterRemove.providers.length, 1); assert.equal(afterRemove.provider, 'local');
    const onDiskAfter = JSON.parse(await readFile(f.settings, 'utf8'));
    assert.equal(onDiskAfter.providers.length, 1); assert.equal(onDiskAfter.customField.keep, true);
    await assert.rejects(f.manager.execute({ type: 'provider-remove', revision: afterRemove.revision, name: 'ghost' }, () => true), /not found/);
    await assert.rejects(f.manager.execute({ type: 'provider-save', revision: afterRemove.revision, provider: provider('x') }, () => false), /approved/);
  } finally { await f.cleanup(); }
});

test('settings-save validates values, maps nested fields, supports unset, and preserves unrelated configuration', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, '.haze'));
    await writeFile(f.settings, JSON.stringify({ providers: [provider('p')], subagents: { workerModel: 'old', profiles: { audit: { mode: 'inspect' } } }, tips: { enabled: true }, lspServers: [{ name: 'ts' }] }));
    const first = await f.manager.readView();
    const saved = await f.manager.execute({ type: 'settings-save', revision: first.revision, settings: { theme: 'robbyrussell', reasoning: 'high', modelRetries: 3, retryBaseDelayMs: 500, tipsEnabled: false, workerModel: 'sub-model', escalationModel: 'p:model-a' } }, () => true);
    assert.equal(saved.settings.theme, 'robbyrussell'); assert.equal(saved.settings.reasoning, 'high'); assert.equal(saved.settings.modelRetries, 3); assert.equal(saved.settings.tipsEnabled, false); assert.equal(saved.settings.workerModel, 'sub-model');
    const disk = JSON.parse(await readFile(f.settings, 'utf8'));
    assert.equal(disk.theme, 'robbyrussell'); assert.equal(disk.tips.enabled, false); assert.equal(disk.subagents.workerModel, 'sub-model');
    assert.equal(disk.subagents.profiles.audit.mode, 'inspect'); assert.equal(disk.lspServers.length, 1); assert.equal(disk.providers.length, 1);
    await assert.rejects(f.manager.execute({ type: 'settings-save', revision: saved.revision, settings: { modelRetries: 99 } }, () => true), /modelRetries/);
    await assert.rejects(f.manager.execute({ type: 'settings-save', revision: saved.revision, settings: { reasoning: 'extreme' as never } }, () => true), /reasoning/);
    await assert.rejects(f.manager.execute({ type: 'settings-save', revision: saved.revision, settings: { escalationModel: 'no-colon' } }, () => true), /provider:model/);
    const unset = await f.manager.execute({ type: 'settings-save', revision: saved.revision, settings: { theme: '', reasoning: '' } }, () => true);
    assert.equal(unset.settings.theme, undefined); assert.equal(unset.settings.reasoning, undefined);
    assert.equal('theme' in JSON.parse(await readFile(f.settings, 'utf8')), false);
  } finally { await f.cleanup(); }
});

test('configuration and sessions require QR-secret enrollment and travel only encrypted; invalid requests are rejected', async () => {
  assert.equal(isManagementRequest({ type: 'provider-remove', requestId: 'a', revision: '/bad', name: 'x' }), false);
  assert.equal(isManagementRequest({ type: 'settings-save', requestId: 'a', revision: 'f'.repeat(64), settings: { theme: 'x' } }), true);
  assert.equal(isManagementRequest({ type: 'sessions-list', requestId: 'a', projectId: '../escape' }), false);
  const f = await fixture();
  const transport = peerHarness();
  const remote = await startRemote({ ...transport, cwd: f.cwd, executable: process.execPath,
    args: [resolve('tests/fixtures/agent.mjs')], env: { HOME: f.home, PATH: process.env.PATH! } });
  let c: Awaited<ReturnType<typeof connection>> | undefined;
  try {
    await mkdir(join(f.home, '.haze'));
    await writeFile(f.settings, JSON.stringify({ providers: [provider('private-cloud', { key: 'SECRET' })] }));

    c = await connection({ remote, transport }, remote.local.pin()!.pin);
    await until(() => c!.messages.some(message => message.type === 'snapshot'));
    c.session.send({ type: 'configuration-read', requestId: 'read' });
    await until(() => c!.messages.some(message => message.requestId === 'read'));
    const configuration = c.messages.find(message => message.requestId === 'read').configuration;
    assert.equal(configuration.providers[0].name, 'private-cloud');
    assert.ok(!c.wire.join('').includes('SECRET'));
    c.session.send({ type: 'sessions-list', requestId: 'sessions', projectId: 'project-1' });
    await until(() => c!.messages.some(message => message.requestId === 'sessions'));
    const sessions = c.messages.find(message => message.requestId === 'sessions');
    assert.equal(sessions.sessions.length, 0);
    c.session.send({ type: 'provider-remove', requestId: 'bad', revision: 'x', name: 'y' });
    await until(() => c!.messages.some(message => message.requestId === 'bad'));
    assert.equal(c.messages.find(message => message.requestId === 'bad').type, 'management-error');
  } finally { c?.session.close(); await remote.close(); await f.cleanup(); }
});
