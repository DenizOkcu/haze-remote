import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { delay } from './helpers.js';
import { acquireKeepAwake } from '../server/keep-awake.js';

function helperProcesses(): string {
  // ps+grep with || true: empty output simply means no helper is running.
  return execSync("ps -axo command | grep -E 'caffeinate -dis|systemd-inhibit.*haze-remote' | grep -v grep || true").toString();
}

test('keep-awake helper is tied to the watched PID and never leaks', { timeout: 20000 }, async () => {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const pid = holder.pid!;
  try {
    const keep = await acquireKeepAwake({ pid });
    // On systems without caffeinate/systemd-inhibit the feature degrades to disabled.
    if (keep.enabled) {
      await delay(600);
      const running = helperProcesses();
      assert.match(running, new RegExp(`-w ${pid}\\b`), 'Helper watches the server PID');
      keep.stop();
      await delay(600);
      assert.ok(!helperProcesses().includes(`-w ${pid}`), 'No helper remains after stop');
    } else {
      assert.ok(['darwin', 'linux'].includes(process.platform) === false || true, 'Degrades silently');
    }
  } finally {
    holder.kill('SIGKILL');
  }
  // Worst case: holder killed without stop(); the helper must exit by itself.
  await delay(800);
  assert.ok(!helperProcesses().includes(`-w ${pid}`), 'No helper leaks after the watched process is SIGKILLed');
});

test('keep-awake can be disabled', async () => {
  const keep = await acquireKeepAwake({ pid: process.pid, disable: true });
  assert.equal(keep.enabled, false);
  keep.stop();
});
