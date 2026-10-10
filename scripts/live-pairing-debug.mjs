// Manual debugging helper: logs every app-level frame between native peer and browser.
// Not part of npm test; run with: node scripts/live-pairing-debug.mjs
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { startRemote } from '../dist/server/server.js';
import { startLanPeer } from '../dist/server/webrtc.js';
import { discoverLanInterfaces } from '../dist/server/lan.js';

const [lan] = discoverLanInterfaces({});
console.log('[lan]', lan.interfaceName, lan.address, lan.subnet);
const remote = await startRemote({
  lan, cwd: process.cwd(), executable: process.execPath,
  args: [resolve('tests/fixtures/agent.mjs')], newArgs: [],
  onError: m => console.log('[native-error]', m),
  peerFactory: async options => {
    const inner = { ...options };
    inner.onSocket = (ws, meta) => {
      console.log('[onSocket] peer=', meta.peer, 'binding=ok');
      ws.on('message', data => console.log('[native<-browser]', String(data).slice(0, 220)));
      const send = ws.send.bind(ws);
      ws.send = data => { console.log('[native->browser]', String(data).slice(0, 220)); return send(data); };
      options.onSocket(ws, meta);
    };
    return startLanPeer(inner);
  },
});
console.log('[url]', remote.pairingUrl().replace(/secret=[a-f0-9]+/, 'secret=<redacted>'));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (!t.includes('Failed to load resource')) console.log('[browser]', t.slice(0, 220)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(remote.pairingUrl(), { waitUntil: 'domcontentloaded', timeout: 45000 });
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const body = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');
  if (/Connected|failed|expired|denied|Incorrect/i.test(body)) { console.log('[body]', body.replace(/\n/g, ' | ')); break; }
  if (i === 29) console.log('[body-final]', body.replace(/\n/g, ' | '));
}
const term = page.getByLabel('Haze terminal', { exact: true });
await term.filter({ hasText: 'READY' }).waitFor({ timeout: 20000 }).catch(() => console.log('[term] READY never appeared'));
await term.click();
await page.keyboard.insertText('debug-live-input');
await page.keyboard.press('Enter');
await page.waitForTimeout(4000);
console.log('[term-text]', JSON.stringify((await term.innerText().catch(() => '<gone>')).slice(0, 500)));
await browser.close();
await remote.close();
process.exit(0);
