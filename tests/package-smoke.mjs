import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'haze-remote-package-'));
let remote;
try {
  const result = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { encoding: 'utf8' }));
  const packed = Array.isArray(result) ? result[0] : result['@denizokcu/haze-remote'];
  for (const path of ['dist/client/index.html', 'dist/server/cli.js', 'dist/server/fleet.js', 'dist/server/haze-observer/preload.js', 'dist/server/haze-observer/loader.js', 'dist/server/haze-observer/runtime.js', 'dist/server/haze-observer/transform.js', 'dist/server/haze-observer/host.js', 'dist/shared/fleet.js', 'dist/shared/observer.js', 'dist/shared/session.js', 'dist/shared/speech.js', 'dist/server/speech.js', 'dist/server/speech-worker.js', 'dist/server/speech-model.js', 'scripts/prepare-pty.mjs', 'dist/server/webrtc.js', 'dist/server/lan.js', 'dist/server/rtc-audio.js', 'dist/shared/signaling.js']) assert.ok(packed.files.some(f => f.path === path));
  assert.ok(!packed.files.some(f => /^(client|server|shared|tests|\.haze)\//.test(f.path)));
  assert.ok(!packed.files.some(f => f.path === 'dist/server/git-review.js' || f.path === 'dist/shared/review.js' || f.path === 'dist/server/subagents.js'), 'Removed review/session-reader code must not survive in build artifacts');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, allowScripts: { 'node-pty@1.1.0': true, '@denizokcu/haze-remote@0.0.1': true } }));
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', join(dir, packed.filename)], { cwd: dir, stdio: 'pipe' });
  if (Number(execFileSync('npm', ['--version'], { encoding: 'utf8' }).split('.')[0]) >= 12) {
    execFileSync('npm', ['install-scripts', 'approve', '@denizokcu/haze-remote', 'node-pty'], { cwd: dir, stdio: 'pipe' });
    execFileSync('npm', ['rebuild', 'node-pty', '@denizokcu/haze-remote'], { cwd: dir, stdio: 'pipe' });
  }
  if (process.platform === 'darwin') assert.ok((await stat(join(dir, `node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`))).mode & 0o111);
  const bin = join(dir, 'node_modules/.bin/haze-remote');
  assert.equal(execFileSync(bin, ['--version'], { cwd: dir, encoding: 'utf8' }).trim(), '@denizokcu/haze-remote 0.0.1');
  assert.match(execFileSync(bin, ['--help'], { cwd: dir, encoding: 'utf8' }), /--project/);
  await mkdir(join(dir, 'project'));
  const fixture = join(dir, 'agent.mjs');
  await writeFile(fixture, await readFile(resolve('tests/fixtures/agent.mjs')));
  // The packaged server has no HTTP listener. Exercise its installed API with
  // test-only peer injection; authenticated PTY traffic is covered in server.test.
  const { startRemote } = await import(pathToFileURL(join(dir, 'node_modules/@denizokcu/haze-remote/dist/server/server.js')));
  let peerOptions, resets = 0, peerClosed = false;
  remote = await startRemote({
    cwd: join(dir, 'project'), executable: process.execPath, args: [fixture],
    env: { PATH: process.env.PATH, HOME: dir, LANG: 'en_US.UTF-8' },
    lan: { interfaceName: 'test', address: '192.168.1.10', subnet: '192.168.1.0/24', netmask: '255.255.255.0', network: 3232235776, prefix: 24 },
    peerFactory: async options => {
      peerOptions = options;
      return { async resetPeer() { resets++; }, async close() { peerClosed = true; } };
    },
  });
  assert.equal(peerOptions.roomId, remote.serverId);
  assert.equal(typeof peerOptions.onAudio, 'function');
  assert.equal('port' in remote, false);
  const url = new URL(remote.pairingUrl());
  assert.equal(url.protocol, 'https:');
  assert.equal(url.pathname, '/remote/');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('room'), remote.serverId);
  process.kill(remote.pid, 0);
  await remote.local.cancel(); assert.equal(remote.pairingUrl(), undefined);
  await remote.local.pair(); assert.ok(remote.pairingUrl());
  await remote.local.revoke(); assert.equal(remote.local.pin(), null);
  assert.equal(resets, 3);
  await remote.close(); assert.equal(peerClosed, true);
  assert.throws(() => process.kill(remote.pid, 0));
  console.log('PASS: packed artifacts, installed CLI help/version, LAN server API, pairing lifecycle and child shutdown.');
} finally {
  await remote?.close();
  await rm(dir, { recursive: true, force: true });
}
