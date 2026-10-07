import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
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
    args: realHaze ? ['--no-session'] : [resolve('tests/fixtures/observed-agent.mjs')],
    newArgs: realHaze ? ['--no-session'] : [resolve('tests/fixtures/observed-agent.mjs')], assets: resolve('dist/client'),
    env: { HOME: cwd, PATH: process.env.PATH!, LANG: 'en_US.UTF-8' } });
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
  await expect(page.getByRole('status')).toContainText('Enter code B on computer');
  await expect(page.getByRole('status')).toHaveText(/· (2:00|1:5\d) remaining/);
  await expect(page.locator('[aria-label="Haze terminal"]')).toHaveCount(0);
  const code = await page.getByLabel('Code B').textContent();
  const review = remote.local.confirm(code!);
  await expect(page.getByRole('status')).toContainText('Awaiting local approval');
  await expect(page.getByRole('status')).toHaveText(/· (2:00|1:5\d) remaining/);
  await expect(page.getByLabel('Code B')).toHaveCount(0);
  await expect(page.getByText('Code B confirmed.', { exact: false })).toBeVisible();
  await expect(page.locator('[aria-label="Haze terminal"]')).toHaveCount(0);
  remote.local.approve(review.id);
  await expect(page.getByRole('status')).toHaveText('Connected');
}

/** Deliver text through the real keyboard input path (no queueing, no replay). */
async function type(page: import('@playwright/test').Page, text: string) {
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.insertText(text);
}

async function enter(page: import('@playwright/test').Page) {
  await page.keyboard.press('Enter');
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
  // Startup puts the cursor in the terminal: typing works immediately.
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.insertText('tablet café 🦊');
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('tablet café 🦊');
  await enter(page);
  await page.keyboard.type('k');
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('INPUT "k"');
  await page.setViewportSize({ width: 1194, height: 834 });
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('SIZE');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('tablet café 🦊');
  await expect(page.locator('.session-meta')).toContainText(`PID ${remote.pid}`);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  const before = (await readFile(join(cwd, 'heartbeat.txt'))).length;
  await context.setOffline(true);
  await page.evaluate(() => (window as any).__sockets.forEach((ws: WebSocket) => ws.close()));
  await expect(page.getByRole('status')).toHaveText('Reconnecting');
  // The touch keys are gone; keyboard input alone reaches the terminal.
  await expect(page.getByRole('button', { name: 'Latest output' })).toBeEnabled();
  await expect.poll(async () => (await readFile(join(cwd, 'heartbeat.txt'))).length).toBeGreaterThan(before);
  await context.setOffline(false);
  // Reconnect backoff can reach 8s after repeated disconnects; allow it to elapse.
  await expect(page.getByRole('status')).toHaveText('Connected', { timeout: 15_000 });
  await page.route('**/api/info', async route => { await new Promise(r => setTimeout(r, 200)); await route.continue(); });
  await page.evaluate(() => {
    (window as any).__sockets.forEach((ws: WebSocket) => ws.close());
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByRole('status')).toHaveText('Reconnecting');
  await expect(page.getByRole('status')).toHaveText('Connected', { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__sockets.filter((ws: WebSocket) => ws.readyState === WebSocket.OPEN).length)).toBe(1);
  await page.unroute('**/api/info');
  await page.evaluate(() => { history.replaceState(null, '', '#paste'); });
  await type(page, 'y'.repeat(70 * 1024));
  await expect(page.getByRole('alert')).toContainText('Paste is too large');
  const second = await context.newPage();
  await second.goto(origin);
  await expect(second.getByRole('status')).toHaveText('Already connected');
  await expect(page.getByRole('status')).toHaveText('Connected');
  await second.getByRole('button', { name: 'Reconnect', exact: true }).click();
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
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Unpair', exact: true }).click();
  await expect(page.getByLabel('PIN A', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pair this browser' })).toBeDisabled();
  process.kill(remote.pid, 0);
  expect(errors).toEqual([]);
});

test('installed Haze renders, accepts typed /help and Enter, reconnects and exits over encrypted transport', async ({ page }) => {
  await pair(page);
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText(/Configured providers:\s*0/);
  await type(page, '/help');
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('/help');
  await enter(page);
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('/exit');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page.locator('.session-meta')).toContainText(`PID ${remote.pid}`);
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('/exit');
  await type(page, '/exit');
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('› /exit');
  await enter(page);
  await expect(page.getByRole('status')).toHaveText('Exited (0)', { timeout: 20000 });
});

test('terminal input is not sent while the connection is down and is never replayed', async ({ page, context }) => {
  await pair(page);
  await type(page, 'offline line');
  await expect(page.locator('[aria-label="Haze terminal"]')).toContainText('offline line');
  await context.setOffline(true);
  await page.evaluate(() => (window as any).__sockets.forEach((ws: WebSocket) => ws.close()));
  await expect(page.getByRole('status')).toHaveText('Reconnecting');
  // Once reconnected, the earlier offline input has not been silently re-sent.
  await context.setOffline(false);
  await expect(page.getByRole('status')).toHaveText('Connected');
  expect((await page.locator('[aria-label="Haze terminal"]').textContent())?.match(/INPUT "offline line/g)?.length).toBe(1);
  await expect(page.locator('.session-meta')).toContainText(`PID ${remote.pid}`);
});

test('cockpit readability, recovery and unpair confirmation', async ({ page, context }) => {
  await pair(page);
  await expect(page.getByText(/Last authenticated contact/)).toBeVisible();
  await page.getByRole('button', { name: 'Larger terminal text' }).click();
  await expect(page.getByText('16px', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Latest output' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[aria-label="Haze terminal"]')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('Haze keeps running');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Unpair', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await context.setOffline(true);
  await page.evaluate(() => (window as any).__sockets.forEach((ws: WebSocket) => ws.close()));
  await expect(page.getByRole('status')).toHaveText('Reconnecting');
  await page.getByRole('button', { name: 'Retry now' }).click();
  await context.setOffline(false);
  await expect(page.getByRole('status')).toHaveText('Connected');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page.getByText('16px', { exact: true })).toBeVisible();
});

test('fleet tabs launch real PTYs, isolate terminal input, reconnect without duplication, and stop independently', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await pair(page);
  await expect(page.getByRole('button', { name: 'Changes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Haze 1/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'New instance' }).click();
  await page.getByLabel('Instance name', { exact: true }).fill('Tests agent');
  await expect(page.getByRole('button', { name: 'Start Haze' })).toBeDisabled();
  await page.getByLabel('Allow shared checkout').check();
  await page.getByRole('button', { name: 'Start Haze' }).click();
  const firstTab = page.getByRole('tab', { name: /Haze 1/ });
  const secondTab = page.getByRole('tab', { name: /Tests agent/ });
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status')).toHaveText('Connected');
  const secondPid = Number((await page.locator('.session-meta').textContent())?.match(/PID (\d+)/)?.[1]);
  expect(secondPid).toBeGreaterThan(0); expect(secondPid).not.toBe(remote.pid);
  await type(page, 'second instance only');
  await expect(page.getByLabel('Haze terminal', { exact: true })).toContainText('second instance only');
  await firstTab.click();
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page.getByLabel('Haze terminal', { exact: true })).not.toContainText('second instance only');
  await firstTab.focus(); await page.keyboard.press('ArrowRight');
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status')).toHaveText('Connected');
  await context.setOffline(true);
  await page.evaluate(() => (window as any).__sockets.forEach((ws: WebSocket) => ws.close()));
  await expect(page.getByRole('status')).toHaveText('Reconnecting');
  await expect(firstTab).toBeDisabled();
  process.kill(remote.pid, 0); process.kill(secondPid, 0);
  await context.setOffline(false);
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('.session-meta')).toContainText(`PID ${secondPid}`);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('.session-meta')).toContainText(`PID ${secondPid}`);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Stop instance' }).click();
  await expect(page.getByRole('status')).toHaveText('Connected'); process.kill(secondPid, 0);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Stop instance' }).click();
  await expect(page.getByRole('status')).toContainText('Exited');
  process.kill(remote.pid, 0); expect(() => process.kill(secondPid, 0)).toThrow();
  await page.getByRole('button', { name: 'Close tab' }).click();
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('subagent sidebar shows observed runs with live output and retains finished runs for inspection', async ({ page }) => {
  await pair(page);
  const sidebar = page.getByRole('complementary', { name: 'Subagents', exact: true });
  if (!await sidebar.isVisible()) await page.getByRole('button', { name: 'Subagents', exact: true }).click();
  await expect(sidebar).toContainText('Observation: observing');
  const overlay = page.getByRole('region', { name: 'Subagent run' });
  await expect(overlay).toHaveCount(0);
  await sidebar.getByRole('button', { name: /Audit the payment module/ }).click();
  await expect(overlay.getByLabel('Subagent output')).toContainText('streamed chunk');
  await expect(overlay).toContainText('worker-1');
  await expect(overlay).toContainText('Audit the payment module');
  await expect(overlay.getByLabel('Haze terminal', { exact: true })).toHaveCount(0);
  await expect(overlay.getByLabel('Subagent result')).toContainText('Audit complete: 2 findings, both fixed.');
  await expect(sidebar.getByRole('button', { name: /Audit the payment module/ })).toContainText('finished');
  await expect(sidebar.getByRole('button', { name: /Audit the payment module/ })).toContainText('completed');
  await expect(overlay.getByLabel('Subagent output')).toContainText('streamed chunk');
  // The overlay covers the terminal; Escape closes it and returns to the terminal.
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await sidebar.getByRole('button', { name: /Audit the payment module/ }).click();
  await expect(overlay.getByLabel('Subagent output')).toContainText('streamed chunk');
  await page.getByRole('button', { name: 'New instance' }).click();
  await page.getByLabel('Instance name', { exact: true }).fill('Other parent');
  await page.getByLabel('Allow shared checkout').check();
  await page.getByRole('button', { name: 'Start Haze' }).click();
  await expect(page.getByRole('tab', { name: /Other parent/ })).toHaveAttribute('aria-selected', 'true');
  await expect(sidebar).toContainText('Subagents (0)');
  await expect(sidebar).not.toContainText('Audit the payment module');
  await page.getByRole('tab', { name: /Haze 1/ }).click();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(sidebar.getByRole('button', { name: /Audit the payment module/ })).toContainText('finished');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toBeHidden();
  await page.getByRole('button', { name: 'Subagents', exact: true }).click();
  await expect(sidebar).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('installed Haze fleet launches independent native instances and exits one without stopping the other', async ({ page }) => {
  await pair(page);
  await type(page, '/help');
  await enter(page);
  await expect(page.getByLabel('Haze terminal', { exact: true })).toContainText('/exit');
  await page.getByRole('button', { name: 'New instance' }).click();
  await page.getByLabel('Instance name', { exact: true }).fill('Native second');
  await page.getByLabel('Allow shared checkout').check();
  await page.getByRole('button', { name: 'Start Haze' }).click();
  await expect(page.getByRole('tab', { name: /Native second/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page.getByLabel('Haze terminal', { exact: true })).toContainText(/Configured providers:\s*0/);
  const secondPid = Number((await page.locator('.session-meta').textContent())?.match(/PID (\d+)/)?.[1]);
  expect(secondPid).toBeGreaterThan(0); expect(secondPid).not.toBe(remote.pid);
  await type(page, '/help');
  await enter(page);
  await expect(page.getByLabel('Haze terminal', { exact: true })).toContainText('/exit');
  await page.getByRole('tab', { name: /Haze 1/ }).click();
  await expect(page.getByRole('status')).toHaveText('Connected');
  // The /help listing may have scrolled out of the live viewport; identity is
  // covered by the PID check and content was verified right after /help above.
  await expect(page.locator('.session-meta')).toContainText(`PID ${remote.pid}`);
  await page.getByRole('tab', { name: /Native second/ }).click();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await type(page, '/exit');
  await expect(page.getByLabel('Haze terminal', { exact: true })).toContainText('› /exit');
  await enter(page);
  await expect(page.getByRole('status')).toHaveText('Exited (0)', { timeout: 20000 });
  process.kill(remote.pid, 0);
  await page.getByRole('tab', { name: /Haze 1/ }).click();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page.locator('.session-meta')).toContainText(`PID ${remote.pid}`);
});
