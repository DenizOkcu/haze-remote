import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { startRemote, privateAddress } from '../../server/server.js';

let remote: Awaited<ReturnType<typeof startRemote>>;
let cwd: string;
let origin: string;
const lan = Object.values(networkInterfaces()).flatMap(entries => entries ?? []).find(e => e.family === 'IPv4' && !e.internal && privateAddress(e.address))?.address;
test.beforeEach(async ({ page }, testInfo) => {
  const realHaze = testInfo.title.startsWith('installed Haze');
  if (realHaze && !process.env.HAZE_SMOKE_EXECUTABLE) test.skip(true, 'No installed Haze executable selected');
  cwd = await mkdtemp(join(tmpdir(), 'haze-remote-browser-'));
  remote = await startRemote({ host: lan ?? '127.0.0.1', port: 0, cwd,
    executable: realHaze ? process.env.HAZE_SMOKE_EXECUTABLE! : process.execPath,
    args: realHaze ? ['--no-session'] : [resolve('tests/fixtures/agent.mjs')], assets: resolve('dist/client'),
    ...(realHaze ? { env: { HOME: cwd, PATH: process.env.PATH!, LANG: 'en_US.UTF-8' } } : {}) });
  origin = `http://${lan ?? '127.0.0.1'}:${remote.port}`;
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
    };
    (window as any).__sockets = sockets;
  });
});
test.afterEach(async () => { if (remote) await remote.close(); if (cwd) await rm(cwd, { recursive: true, force: true }); });

async function pair(page: import('@playwright/test').Page, navigate = true) {
  if (navigate) await page.goto(origin);
  await page.getByLabel('PIN A', { exact: true }).fill(remote.local.pin()!.pin);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByLabel('Code B')).toHaveText(/^\d{8}$/);
  await expect(page.locator('[aria-label="Haze terminal"]')).toHaveCount(0);
  const code = await page.getByLabel('Code B').textContent();
  const review = remote.local.confirm(code!);
  await expect(page.getByRole('status')).toContainText('Awaiting local approval');
  remote.local.approve(review.id);
  await expect(page.getByRole('status')).toHaveText('Connected');
}

test('tablet two-way pairing, encryption on LAN HTTP, input, reconnect, one device and revocation', async ({ page, context, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  if (lan) expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  await page.getByLabel('PIN A', { exact: true }).fill('notapin'.replace(/./g, '9') + '9');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect or expired PIN');
  await pair(page, false);
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('READY');
  await expect(page.locator('.session-meta')).toContainText(`PID ${remote.pid}`);
  await page.getByLabel('Message to Haze').fill('tablet café 🦊');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('tablet café 🦊');
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
  await page.keyboard.type('k');
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('INPUT "k"');
  await page.setViewportSize({ width: 1194, height: 834 });
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('SIZE');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('tablet café 🦊');
  await expect(page.locator('.session-meta')).toContainText(`PID ${remote.pid}`);
  const before = (await readFile(join(cwd, 'heartbeat.txt'))).length;
  await context.setOffline(true);
  await page.evaluate(() => (window as any).__sockets.forEach((ws: WebSocket) => ws.close()));
  await expect(page.getByRole('status')).toHaveText('Reconnecting');
  await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeDisabled();
  await expect.poll(async () => (await readFile(join(cwd, 'heartbeat.txt'))).length).toBeGreaterThan(before);
  await context.setOffline(false);
  await expect(page.getByRole('status')).toHaveText('Connected');
  await page.route('**/api/info', async route => { await new Promise(r => setTimeout(r, 200)); await route.continue(); });
  await page.evaluate(() => {
    (window as any).__sockets.forEach((ws: WebSocket) => ws.close());
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByRole('status')).toHaveText('Reconnecting');
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect.poll(() => page.evaluate(() => (window as any).__sockets.filter((ws: WebSocket) => ws.readyState === WebSocket.OPEN).length)).toBe(1);
  await page.unroute('**/api/info');
  await page.getByLabel('Message to Haze').fill('x'.repeat(70 * 1024));
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Paste is too large');
  await expect(page.getByLabel('Message to Haze')).toHaveValue('x'.repeat(70 * 1024));
  const second = await context.newPage();
  await second.goto(origin);
  await expect(second.getByRole('status')).toHaveText('Already connected');
  await expect(page.getByRole('status')).toHaveText('Connected');
  await second.close();
  const otherDevice = await browser.newContext();
  try {
    const stranger = await otherDevice.newPage();
    await stranger.goto(origin);
    await expect(stranger.getByRole('button', { name: 'Pair this browser' })).toBeDisabled();
    await expect(stranger.getByText('A device is already paired.', { exact: false })).toBeVisible();
    await expect(stranger.locator('[aria-label="Haze terminal"]')).toHaveCount(0);
  } finally { await otherDevice.close(); }
  await page.getByRole('button', { name: 'Unpair', exact: true }).click();
  await expect(page.getByLabel('PIN A', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pair this browser' })).toBeDisabled();
  process.kill(remote.pid, 0);
  expect(errors).toEqual([]);
});

test('installed Haze renders, accepts pasted /help and Enter, reconnects and exits over encrypted transport', async ({ page }) => {
  await pair(page);
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('unconfigured');
  await page.getByLabel('Message to Haze').fill('/help');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('/help');
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('/exit');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page.locator('.session-meta')).toContainText(`PID ${remote.pid}`);
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('/exit');
  await page.getByLabel('Message to Haze').fill('/exit');
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('› /exit');
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Exited (0)');
});
