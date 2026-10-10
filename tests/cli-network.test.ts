import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as pty from 'node-pty';

const entry = (address: string, netmask = '255.255.252.0') => ({ address, netmask, family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', cidr: null });
async function launch(interfaces: object, answer?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'haze-network-cli-'));
  const preload = join(dir, 'interfaces.mjs');
  await writeFile(preload, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.networkInterfaces = () => (${JSON.stringify(interfaces)}); syncBuiltinESMExports();`);
  let child: pty.IPty | undefined;
  try {
    return await new Promise<{ output: string; code: number }>((accept, reject) => {
      child = pty.spawn(process.execPath, ['--import', preload, '--import', 'tsx', resolve('server/cli.ts'), '--haze', '/__haze_remote_test_missing__'], {
        name: 'xterm-256color', cols: 120, rows: 30, cwd: process.cwd(), env: { ...process.env, HOME: dir },
      });
      let output = '', answered = false;
      const timer = setTimeout(() => { child?.kill(); reject(new Error('CLI network selection timed out')); }, 10_000);
      child.onData(data => {
        output += data;
        if (answer !== undefined && !answered && output.includes('(Enter cancels):')) {
          answered = true; child!.write(`${answer}\n`);
        }
      });
      child.onExit(({ exitCode }) => { clearTimeout(timer); accept({ output, code: exitCode }); });
    });
  } finally { try { child?.kill(); } catch { /* Process already exited. */ } await rm(dir, { recursive: true, force: true }); }
}

test('CLI without network flags selects the sole LAN and derives /22 without prompting', async () => {
  const result = await launch({ en0: [entry('192.168.68.66')], utun4: [entry('10.1.2.3')] });
  assert.match(result.output, /Using LAN: en0 192\.168\.68\.66 \(192\.168\.68\.0\/22\)/);
  assert.ok(!result.output.includes('Choose the network'));
  assert.ok(!result.output.includes('Choose --host'));
  // Stop before process launch/signaling; this test intentionally supplies a missing executable.
  assert.match(result.output, /Haze executable not found/);
  assert.equal(result.code, 1);
});

test('CLI numbered network prompt selects one interface or cancels without starting Haze', async () => {
  const interfaces = { en0: [entry('192.168.68.66')], en1: [entry('192.168.80.10', '255.255.255.0')] };
  const selected = await launch(interfaces, '2');
  assert.match(selected.output, /Choose the network your tablet is connected to/);
  assert.match(selected.output, /Using LAN: en1 192\.168\.80\.10 \(192\.168\.80\.0\/24\)/);
  const cancelled = await launch(interfaces, '');
  assert.match(cancelled.output, /Network selection cancelled/);
  assert.ok(!cancelled.output.includes('Using LAN:'));
});
