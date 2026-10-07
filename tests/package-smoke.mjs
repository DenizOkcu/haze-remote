import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { ClientSession } from '../dist/shared/session.js';
const dir = await mkdtemp(join(tmpdir(), 'haze-remote-package-'));
let cli, socket, cliExit;
const wait = async check => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('Packaged CLI did not reach expected state (terminal contents intentionally omitted)');
};
try {
  const result = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { encoding: 'utf8' }));
  const packed = Array.isArray(result) ? result[0] : result['haze-remote'];
  for (const path of ['dist/client/index.html', 'dist/server/cli.js', 'dist/server/fleet.js', 'dist/server/haze-observer/preload.js', 'dist/server/haze-observer/loader.js', 'dist/server/haze-observer/runtime.js', 'dist/server/haze-observer/transform.js', 'dist/server/haze-observer/host.js', 'dist/shared/fleet.js', 'dist/shared/observer.js', 'dist/shared/session.js', 'scripts/prepare-pty.mjs']) assert.ok(packed.files.some(f => f.path === path));
  assert.ok(!packed.files.some(f => /^(client|server|shared|tests|\.haze)\//.test(f.path)));
  assert.ok(!packed.files.some(f => f.path === 'dist/server/git-review.js' || f.path === 'dist/shared/review.js' || f.path === 'dist/server/subagents.js'), 'Removed review/session-reader code must not survive in build artifacts');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, allowScripts: { 'node-pty@1.1.0': true, 'haze-remote@0.1.0': true } }));
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', join(dir, packed.filename)], { cwd: dir, stdio: 'pipe' });
  if (Number(execFileSync('npm', ['--version'], { encoding: 'utf8' }).split('.')[0]) >= 12) {
    execFileSync('npm', ['install-scripts', 'approve', 'haze-remote', 'node-pty'], { cwd: dir, stdio: 'pipe' });
    execFileSync('npm', ['rebuild', 'node-pty', 'haze-remote'], { cwd: dir, stdio: 'pipe' });
  }
  if (process.platform === 'darwin') assert.ok((await stat(join(dir, `node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`))).mode & 0o111);
  const bin = join(dir, 'node_modules/.bin/haze-remote');
  assert.equal(execFileSync(bin, ['--version'], { cwd: dir, encoding: 'utf8' }).trim(), 'haze-remote 0.1.0');
  assert.match(execFileSync(bin, ['--help'], { cwd: dir, encoding: 'utf8' }), /--project/);
  await mkdir(join(dir, 'project'));
  const fixture = join(dir, 'agent.mjs');
  await writeFile(fixture, await readFile(resolve('tests/fixtures/agent.mjs')));
  // Exercise the actual PC keyboard path in a PTY, not a network approval hook.
  cli = pty.spawn(bin, ['--port', '0', '--haze', process.execPath, '--', fixture], { cwd: join(dir, 'project'), name: 'xterm-256color', cols: 120, rows: 40, env: process.env });
  let output = '';
  cli.onData(data => { output += data; });
  cli.onExit(event => { cliExit = event; });
  await wait(() => /Open: (http:\/\/127\.0\.0\.1:\d+)/.test(output));
  const origin = /Open: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)[1];
  const pid = Number(/Haze PID (\d+)/.exec(output)[1]);
  const page = await fetch(origin);
  const html = await page.text();
  assert.equal(page.status, 200);
  const asset = /src="([^"]+\.js)"/.exec(html)[1];
  assert.equal((await fetch(origin + asset)).status, 200);
  const info = await (await fetch(origin + '/api/info')).json();
  assert.ok(!('pid' in info) && !('pin' in info));
  await ClientSession.ready();
  socket = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { Origin: origin, 'User-Agent': 'Version/26.0 Safari iPad', 'X-Forwarded-For': '6.6.6.6' } });
  let codeB, approved = false;
  const messages = [];
  const session = new ClientSession(socket, { serverId: info.serverId, password: [...output.matchAll(/PIN A: (\d{8})/g)].at(-1)[1],
    onPending(code) { codeB = code; }, onApproved() { approved = true; },
  });
  session.subscribe(message => messages.push(message));
  await wait(() => codeB && output.includes('Browser passed PIN A'));
  assert.equal(messages.length, 0);
  cli.write('approve\r');
  await wait(() => output.includes('Enter code B locally and review'));
  assert.equal(approved, false);
  cli.write(codeB + '\r');
  await wait(() => output.includes('Approve remote control of Haze?'));
  assert.ok(output.includes('Observed network peer: 127.0.0.1'));
  assert.ok(output.includes('Reported browser: Safari 26.0'));
  assert.ok(!output.includes('6.6.6.6'));
  assert.equal(messages.length, 0);
  cli.write('approve\r');
  await wait(() => approved && messages.some(m => m.type === 'snapshot'));
  assert.equal(messages.find(m => m.type === 'snapshot').cwd, await realpath(join(dir, 'project')));
  cli.write('revoke\r');
  await wait(() => socket.readyState === WebSocket.CLOSED);
  process.kill(pid, 0);
  cli.write('quit\r');
  await wait(() => cliExit !== undefined);
  assert.equal(cliExit.exitCode, 0);
  assert.throws(() => process.kill(pid, 0));
  console.log('PASS: packed CLI requires local code B and device review/approval, serves compiled assets, encrypts PTY traffic, revokes access locally, and shuts down its child.');
} finally {
  socket?.terminate();
  if (cli && cliExit === undefined) {
    cli.kill('SIGTERM');
    const force = setTimeout(() => { if (cliExit === undefined) cli.kill('SIGKILL'); }, 5000);
    await wait(() => cliExit !== undefined); clearTimeout(force);
  }
  await rm(dir, { recursive: true, force: true });
}
