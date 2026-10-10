import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startRemote } from '../../server/server.js';
import { peerHarness } from '../helpers.js';
import { appFixture } from './app-fixture.js';
test.use({ launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } });
let app: Awaited<ReturnType<typeof appFixture>>;

let remote: Awaited<ReturnType<typeof startRemote>>;
let home = '';
let base = '';
test.beforeEach(async ({ page }) => {
  const transport = peerHarness();
  base = await mkdtemp(join(tmpdir(), 'haze-config-browser-'));
  home = join(base, 'home');
  const cwd = join(base, 'project');
  await mkdir(home); await mkdir(cwd); await mkdir(join(home, '.haze'));
  await writeFile(join(home, '.haze', 'settings.json'), JSON.stringify({
    providers: [{ name: 'existing-cloud', url: 'https://existing.example/v1', key: 'SECRET', models: ['old-model'] }],
  }));
  remote = await startRemote({ lan: transport.lan, peerFactory: transport.peerFactory, cwd, executable: process.execPath,
    args: [resolve('tests/fixtures/agent.mjs')], newArgs: [resolve('tests/fixtures/agent.mjs')],
    env: { HOME: home, PATH: process.env.PATH!, LANG: 'en_US.UTF-8' } });
  app = await appFixture(page, transport);
});
test.afterEach(async () => { await app?.close(); if (remote) await remote.close(); if (base) await rm(base, { recursive: true, force: true }); });

async function pair(_page: import('@playwright/test').Page) { await app.pair(remote); }

test('providers tab edits providers with write-only keys and manages defaults', async ({ page }) => {
  await pair(page);
  await page.getByRole('tab', { name: 'Providers', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /existing-cloud/ })).toContainText('Key configured');
  await page.getByRole('button', { name: /existing-cloud/ }).click();
  await expect(page.getByLabel('Provider name')).toHaveValue('existing-cloud');
  const firstModel = page.getByLabel(/^Model ID/).first();
  await firstModel.fill('new-model');
  await page.getByRole('button', { name: 'Add model' }).click();
  await page.getByLabel(/^Model ID/).nth(1).fill('second-model');
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill('ROTATED-KEY');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await expect(page.locator('#providers-panel').getByText('Provider saved', { exact: false })).toBeVisible();
  const settings = JSON.parse(await readFile(join(home, '.haze', 'settings.json'), 'utf8'));
  expect(settings.providers[0].models).toEqual(['new-model', 'second-model']);
  expect(settings.providers[0].key).toBe('ROTATED-KEY');
  await page.getByLabel('Default provider').selectOption('existing-cloud');
  await page.getByLabel('Default model').selectOption('new-model');
  await page.getByRole('button', { name: 'Save default model' }).click();
  await expect(page.locator('#providers-panel').getByText('Default provider and model saved.')).toBeVisible();
  expect(JSON.parse(await readFile(join(home, '.haze', 'settings.json'), 'utf8')).model).toBe('new-model');
  const body = await page.textContent('#providers-panel');
  expect(body).not.toContain('ROTATED-KEY');
  expect(body).not.toContain('SECRET');
});

test('settings tab edits preferences and preserves drafts across tab switches', async ({ page }) => {
  await pair(page);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByLabel('Theme').fill('solarized-dark');
  await page.getByLabel('Reasoning effort').selectOption('high');
  await page.getByLabel('Model retries').fill('3');
  await page.getByLabel('Show tips').selectOption('Disabled');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#settings-panel').getByText('Settings saved', { exact: false })).toBeVisible();
  const disk = JSON.parse(await readFile(join(home, '.haze', 'settings.json'), 'utf8'));
  expect(disk.theme).toBe('solarized-dark');
  expect(disk.reasoning).toBe('high');
  expect(disk.modelRetries).toBe(3);
  expect(disk.tips.enabled).toBe(false);
  expect(disk.providers[0].key).toBe('SECRET');
  await page.getByLabel('Theme').fill('robbyrussell');
  await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Theme')).toHaveValue('robbyrussell');
});

test('sidebar sessions tab toggles against subagents', async ({ page }) => {
  await pair(page);
  // The sidebar is open by default on tablet-width viewports; only open it if needed.
  const sessionsTab = page.getByRole('tab', { name: 'Sessions', exact: true });
  if (!await sessionsTab.isVisible()) await page.getByRole('button', { name: 'Sidebar', exact: true }).click();
  await sessionsTab.click();
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByText(/No saved sessions yet|Session history is unavailable/)).toBeVisible();
  await page.getByRole('tab', { name: 'Subagents', exact: true }).click();
  await expect(page.locator('.session-list')).toHaveCount(0);
});

