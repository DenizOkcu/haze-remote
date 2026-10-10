import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startRemote } from '../../server/server.js';

let remote: Awaited<ReturnType<typeof startRemote>>;
let base = '', origin = '';
let downloads = 0, transcriptions = 0;
let lastAudio: Buffer | undefined;
let downloadBlocked = false, downloadComplete = false;
let finishDownload: (() => void) | undefined;
let lastDownloadSignal: AbortSignal | undefined;
test.beforeEach(async ({ page }) => {
  downloads = 0; transcriptions = 0; lastAudio = undefined;
  downloadBlocked = false; downloadComplete = false; finishDownload = undefined; lastDownloadSignal = undefined;
  base = await mkdtemp(join(tmpdir(), 'haze-speech-browser-'));
  const home = join(base, 'home'); await mkdir(home);
  remote = await startRemote({ host: '127.0.0.1', port: 0, cwd: base, executable: process.execPath,
    args: [resolve('tests/fixtures/agent.mjs')], assets: resolve('dist/client'), env: { HOME: home, PATH: process.env.PATH!, LANG: 'en_US.UTF-8' },
    speech: {
      status: async () => ({ state: downloadComplete ? 'ready' : lastDownloadSignal && !lastDownloadSignal.aborted ? 'downloading' : 'missing', downloadedBytes: downloads ? 123 : 0 }),
      download: async signal => {
        downloads++; lastDownloadSignal = signal;
        if (downloadBlocked) await new Promise<void>((resolve, reject) => {
          finishDownload = resolve; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
        downloadComplete = true;
      },
      transcribe: async audio => { transcriptions++; lastAudio = audio; return 'Transcribed request'; },
      close() {},
    },
  });
  origin = `http://127.0.0.1:${remote.port}`;
  // Exercise real AudioWorklet capture/resampling without accessing a physical mic.
  await page.addInitScript(() => {
    (window as any).__micStarts = 0; (window as any).__micStops = 0; (window as any).__micReady = 0;
    // Keep the wrapper alive: WebKit can recreate a weakly held native wrapper.
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      (window as any).__micStarts++;
      if ((window as any).__micDeny) throw new DOMException('Microphone permission denied', 'NotAllowedError');
      const context = new AudioContext(); await context.resume();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start();
      const stream = destination.stream;
      const tracks = stream.getTracks();
      Object.defineProperty(stream, 'getTracks', { value: () => tracks });
      for (const track of tracks) {
        const stop = track.stop.bind(track);
        track.stop = () => { (window as any).__micStops++; oscillator.stop(); void context.close(); stop(); };
      }
      (window as any).__micReady++;
      if ((window as any).__micDelay) await new Promise(resolve => setTimeout(resolve, (window as any).__micDelay));
      return stream;
    } });
  });
});
test.afterEach(async () => { await remote.close(); await rm(base, { recursive: true, force: true }); });
async function pair(page: import('@playwright/test').Page) {
  await page.goto(origin);
  await page.getByLabel('PIN A', { exact: true }).fill(remote.local.pin()!.pin);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await expect(page.getByLabel('Code B')).toHaveText(/^\d{8}$/);
  remote.local.approve(remote.local.confirm((await page.getByLabel('Code B').textContent())!).id);
  await expect(page.locator('.app-header [role="status"]')).toHaveText('Connected');
}
async function press(page: import('@playwright/test').Page, button: import('@playwright/test').Locator) {
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}
test('first press asks before download; PTT release creates an editable draft; only Send submits', async ({ page }) => {
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  await expect(overlay).toContainText('Download Parakeet');
  expect(downloads).toBe(0);
  expect(await page.evaluate(() => (window as any).__micStarts)).toBe(0);
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  await expect(overlay.getByLabel('Review and edit your message')).toBeVisible();
  expect(downloads).toBe(1);
  const hold = overlay.getByRole('button', { name: 'Hold to record', exact: true });
  await press(page, hold);
  await expect(overlay.getByRole('button', { name: /Release to transcribe/ })).toBeVisible();
  await page.waitForTimeout(250); await page.mouse.up();
  await expect(overlay.getByLabel('Review and edit your message')).toHaveValue('Transcribed request');
  expect(transcriptions).toBe(1);
  expect(lastAudio?.length).toBeGreaterThan(0);
  expect(lastAudio?.every(byte => byte === 0)).toBe(true);
  await expect(page.locator('.terminal .xterm-screen')).not.toContainText('Transcribed request');
  await overlay.getByLabel('Review and edit your message').fill('APPROVED edited request');
  await overlay.getByRole('button', { name: 'Send to Haze' }).click();
  await expect(overlay).not.toBeVisible();
  await expect(page.locator('.terminal .xterm-screen')).toContainText('APPROVED edited request');
  expect(await page.evaluate(() => (window as any).__micStops)).toBeGreaterThan(0);
  await press(page, page.getByRole('button', { name: 'Push to talk' }));
  await expect(page.getByRole('button', { name: 'Push to talk' })).toContainText('Release to transcribe');
  await page.waitForTimeout(200); await page.mouse.up();
  await expect(overlay.getByLabel('Review and edit your message')).toHaveValue('Transcribed request');
  expect(downloads).toBe(1);
  await overlay.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(overlay).not.toBeVisible();
});

test('cancel consent avoids download; cancel recording stops the mic without transcription', async ({ page }) => {
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  await expect(overlay.getByRole('button', { name: 'Download Parakeet' })).toBeVisible();
  await overlay.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(downloads).toBe(0); expect(transcriptions).toBe(0);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  await press(page, overlay.getByRole('button', { name: 'Hold to record', exact: true }));
  await expect(overlay.getByRole('button', { name: /Release to transcribe/ })).toBeVisible();
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(overlay).not.toBeVisible();
  expect(transcriptions).toBe(0);
  expect(await page.evaluate(() => (window as any).__micStops)).toBeGreaterThan(0);
});

test('release before microphone permission resolves discards late audio and never transcribes', async ({ page }) => {
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  const hold = overlay.getByRole('button', { name: 'Hold to record', exact: true });
  await expect(hold).toBeVisible();
  await page.evaluate(() => { (window as any).__micDelay = 1000; });
  await press(page, hold);
  await expect(overlay.getByRole('button', { name: 'Starting microphone… keep holding' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__micReady)).toBeGreaterThan(0);
  await page.mouse.up();
  await expect(overlay.getByRole('alert')).toContainText('Hold until the microphone is ready');
  await expect.poll(() => page.evaluate(() => (window as any).__micStops)).toBeGreaterThan(0);
  expect(transcriptions).toBe(0);
  await overlay.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('insecure browser context shows actionable HTTPS guidance without starting a microphone', async ({ page }) => {
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  const hold = overlay.getByRole('button', { name: 'Hold to record', exact: true });
  await expect(hold).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: undefined });
  });
  await press(page, hold); await page.mouse.up();
  await expect(overlay.getByRole('alert')).toContainText('--tls-cert and --tls-key');
  expect(await page.evaluate(() => (window as any).__micStarts)).toBe(0);
  expect(transcriptions).toBe(0);
});

test('blocked microphone shows secure-access guidance during download and restores progress after reload', async ({ page }) => {
  downloadBlocked = true;
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 Chrome/140.0 Safari/537.36' });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = command => command === 'copy';
  });
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  const help = overlay.getByRole('region', { name: 'Microphone setup' });
  await expect(help.getByLabel('Browser', { exact: true })).toHaveCount(0);
  await expect(help.getByLabel('Settings URL', { exact: true })).toHaveCount(0);
  await expect(help).toContainText('trusted HTTPS');
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  await expect(overlay.getByRole('progressbar')).toBeVisible();
  await expect(help).toBeVisible();
  await expect(help.getByLabel('Current origin', { exact: true })).toHaveCount(0);
  await expect(help).toContainText('localhost');
  await expect(help).not.toContainText('insecure-origin exception');
  await page.reload();
  await expect(page.locator('.app-header [role="status"]')).toHaveText('Connected');
  expect(lastDownloadSignal?.aborted).toBe(false);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  await expect(overlay.getByRole('progressbar')).toBeVisible();
  expect(downloads).toBe(1);
  await expect(help).toBeVisible();
  finishDownload!();
  await expect(overlay.getByLabel('Review and edit your message')).toBeVisible();
  await expect(help).toBeVisible();
  await overlay.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Push to talk' }).click();
  await expect(help).toBeVisible();
});

test('permission denial shows microphone help repeatedly without recommending insecure-origin flags', async ({ page }) => {
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  await page.evaluate(() => { (window as any).__micDeny = true; });
  await press(page, overlay.getByRole('button', { name: 'Hold to record', exact: true })); await page.mouse.up();
  await expect(overlay.getByRole('alert')).toContainText('Microphone access failed');
  const help = overlay.getByRole('region', { name: 'Microphone setup' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('site permissions');
  await expect(help.getByLabel('Settings URL', { exact: true })).toHaveCount(0);
  await overlay.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Push to talk' }).click();
  await expect(help).toBeVisible();
});

test('explicit Cancel download stops a host download and returns to consent', async ({ page }) => {
  downloadBlocked = true;
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  await expect(overlay.getByRole('progressbar')).toBeVisible();
  await overlay.getByRole('button', { name: 'Cancel download', exact: true }).click();
  await expect(overlay.getByRole('button', { name: 'Download Parakeet' })).toBeVisible();
  expect(lastDownloadSignal?.aborted).toBe(true);
});

test('HTTP microphone exception records without AudioWorklet and clears audio after transcription', async ({ page }) => {
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  const hold = overlay.getByRole('button', { name: 'Hold to record', exact: true });
  await expect(hold).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    Object.defineProperty(AudioContext.prototype, 'audioWorklet', { configurable: true, get: () => undefined });
    (window as any).__fallbackCaptures = 0;
    const original = AudioContext.prototype.createScriptProcessor;
    AudioContext.prototype.createScriptProcessor = function(...args) {
      (window as any).__fallbackCaptures++; return original.apply(this, args);
    };
  });
  await press(page, hold);
  await expect(overlay.getByRole('button', { name: /Release to transcribe/ })).toBeVisible();
  await page.waitForTimeout(350); await page.mouse.up();
  await expect(overlay.getByLabel('Review and edit your message')).toHaveValue('Transcribed request');
  expect(transcriptions).toBe(1);
  expect(await page.evaluate(() => (window as any).__fallbackCaptures)).toBeGreaterThan(0);
  expect(lastAudio?.length).toBeGreaterThan(0);
  expect(lastAudio?.every(byte => byte === 0)).toBe(true);
  expect(await page.evaluate(() => (window as any).__micStops)).toBeGreaterThan(0);
  await expect(overlay.getByRole('region', { name: 'Microphone setup' })).toHaveCount(0);
});

test('HTTP microphone fallback cancellation stops capture without submitting audio', async ({ page }) => {
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  await expect(overlay.getByRole('button', { name: 'Hold to record', exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    Object.defineProperty(AudioContext.prototype, 'audioWorklet', { configurable: true, get: () => undefined });
  });
  await press(page, overlay.getByRole('button', { name: 'Hold to record', exact: true }));
  await expect(overlay.getByRole('button', { name: /Release to transcribe/ })).toBeVisible();
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(overlay).not.toBeVisible();
  expect(transcriptions).toBe(0);
  expect(await page.evaluate(() => (window as any).__micStops)).toBeGreaterThan(0);
});

test('Firefox HTTP denial recommends secure access without insecure-media preferences', async ({ page }) => {
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  await expect(overlay.getByRole('button', { name: 'Hold to record', exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 Firefox/140.0' });
    (window as any).__micDeny = true;
  });
  await press(page, overlay.getByRole('button', { name: 'Hold to record', exact: true })); await page.mouse.up();
  const help = overlay.getByRole('region', { name: 'Microphone setup' });
  await expect(help.getByLabel('Settings URL', { exact: true })).toHaveCount(0);
  await expect(help).toContainText('trusted HTTPS');
  await expect(help).not.toContainText('about:config');
  await expect(help).not.toContainText('insecure.enabled');
  expect(transcriptions).toBe(0);
});

test('audio startup denial reports the audio stage and cleans up a microphone granted concurrently', async ({ page }) => {
  await pair(page);
  await page.getByRole('button', { name: 'Push to talk' }).click();
  const overlay = page.getByRole('dialog');
  await overlay.getByRole('button', { name: 'Download Parakeet' }).click();
  await expect(overlay.getByRole('button', { name: 'Hold to record', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const original = AudioContext.prototype.resume;
    let calls = 0;
    AudioContext.prototype.resume = function() {
      if (++calls === 1) return Promise.reject(new DOMException('The request is not allowed in the current context', 'NotAllowedError'));
      return original.call(this);
    };
  });
  await press(page, overlay.getByRole('button', { name: 'Hold to record', exact: true })); await page.mouse.up();
  await expect(overlay.getByRole('alert')).toContainText('Audio engine startup failed');
  await expect(overlay.getByRole('alert')).not.toContainText('Microphone access failed');
  await expect.poll(() => page.evaluate(() => (window as any).__micStops)).toBeGreaterThan(0);
  expect(transcriptions).toBe(0);
});
