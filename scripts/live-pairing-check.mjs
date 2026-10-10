// Manual verification helper: real native CLI against the deployed hosted UI.
// Not part of npm test; run with: node scripts/live-pairing-check.mjs
import * as pty from 'node-pty';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const fixture = resolve('tests/fixtures/agent.mjs');
const child = pty.spawn(process.execPath, ['dist/server/cli.js', '--haze', process.execPath, '--', fixture],
  { name: 'xterm-256color', cols: 200, rows: 50, cwd: process.cwd(), env: process.env });
let out = '';
child.onData(d => { out += d; });

const url = await new Promise((ok, bad) => {
  const timer = setTimeout(() => bad(new Error('no pairing URL within 30s')), 30000);
  const check = setInterval(() => {
    const m = out.match(/https:\/\/haze\.build\/remote\/#room=[a-f0-9]{32}&secret=[a-f0-9]{64}/);
    if (m) { clearInterval(check); clearTimeout(timer); ok(m[0]); }
  }, 200);
});

const browser = await chromium.launch();
const page = await browser.newPage({ permissions: ['microphone'] });
const api = [];
page.on('response', r => { if (r.url().includes('api.haze.build') && r.status() >= 400) api.push(`${r.status()} ${new URL(r.url()).pathname}`); });
page.on('pageerror', e => api.push('PAGEERROR ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

const deadline = Date.now() + 60000;
let status = '';
while (Date.now() < deadline) {
  await page.waitForTimeout(500);
  status = (await page.getByRole('status').textContent().catch(() => '')) ?? '';
  if (status && status !== 'Connecting' && status !== 'Reconnecting') break;
}
assert.equal(status, 'Connected', `browser status was "${status}"; api errors: ${api.join(', ') || 'none'}`);

const terminal = page.getByLabel('Haze terminal', { exact: true });
// Wait for the initial PTY snapshot before typing: input is dropped while not ready.
await terminal.filter({ hasText: 'READY' }).waitFor({ timeout: 20000 });
await terminal.click();
await page.keyboard.insertText('haze-remote-live');
await page.keyboard.press('Enter');
await terminal.filter({ hasText: 'haze-remote-live' }).waitFor({ timeout: 20000 });
assert.ok(!new URL(page.url()).hash.includes('secret'), 'pairing secret removed from the URL');

await browser.close();
child.write('quit\n');
await new Promise(r => child.onExit(() => r(true)));
console.log(`PASS: native CLI + deployed HTTPS UI connected over authenticated LAN WebRTC; terminal input round-tripped; signaling API errors: ${api.length}.`);
