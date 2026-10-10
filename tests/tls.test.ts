import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { get } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import * as pty from 'node-pty';
import { selfSignedTls } from '../server/tls.js';

test('automatic TLS generates a host certificate, protects keys, and reuses its identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'haze-tls-'));
  try {
    const first = await selfSignedTls('127.0.0.1', home);
    const certificate = new X509Certificate(first.cert);
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(certificate.ca, false);
    assert.equal(certificate.verify(certificate.publicKey), true);
    assert.ok(Date.parse(certificate.validTo) > Date.now());
    const second = await selfSignedTls('127.0.0.1', home);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.ok(second.key.equals(first.key));
    const parent = join(home, '.haze', 'remote', 'tls');
    const directory = join(parent, createHash('sha256').update('127.0.0.1').digest('hex'));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'server-key.pem'))).mode & 0o777, 0o600);
    for (const host of ['localhost', '::1', '192.168.1.20']) {
      const tls = await selfSignedTls(host, home);
      const cert = new X509Certificate(tls.cert);
      assert.ok(host === 'localhost' ? cert.checkHost(host) : cert.checkIP(host));
      assert.notEqual(tls.fingerprint, first.fingerprint);
    }
    await unlink(join(directory, 'server-key.pem'));
    await assert.rejects(selfSignedTls('127.0.0.1', home), /Cannot use saved HTTPS certificate/);
    assert.equal((await readdir(parent)).length, 4, 'No staging directories survive');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('concurrent TLS setup publishes one persistent identity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'haze-tls-race-'));
  try {
    const results = await Promise.all([selfSignedTls('127.0.0.1', home), selfSignedTls('127.0.0.1', home)]);
    assert.equal(results[0].fingerprint, results[1].fingerprint);
    await assert.rejects(selfSignedTls('example.com', home), /IP address or localhost/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('HTTPS CLI did not reach the expected state.');
}
function request(url: string, ca?: Buffer, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = get(url, { ca, checkServerIdentity: (_name, cert) => checkServerIdentity(new URL(url).hostname, cert), headers: host ? { Host: host } : undefined }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode!));
    });
    req.on('error', reject);
  });
}

test('--https CLI prints guidance, serves HTTPS, and preserves the certificate across restarts', { timeout: 40_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'haze-tls-cli-'));
  let child: pty.IPty | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let output = '', exited = false;
      child = pty.spawn(process.execPath, ['--import', 'tsx', resolve('server/cli.ts'), '--https', '--port', '0', '--haze', process.execPath, '--', resolve('tests/fixtures/agent.mjs')], {
        cwd: process.cwd(), name: 'xterm-256color', cols: 120, rows: 40, env: { ...process.env, HOME: home },
      });
      child.onData(data => { output += data; });
      child.onExit(() => { exited = true; });
      await until(() => /Open: https:\/\/127\.0\.0\.1:\d+/.test(output) || exited);
      assert.equal(exited, false, 'CLI should start successfully');
      const origin = /Open: (https:\/\/127\.0\.0\.1:\d+)/.exec(output)![1];
      const tls = await selfSignedTls('127.0.0.1', home);
      assert.ok(output.includes(tls.fingerprint));
      assert.match(output, /browser will warn/);
      assert.match(output, /same certificate is reused/);
      assert.match(output, /does not reliably enable microphones/);
      assert.equal(await request(origin, tls.cert), 200);
      assert.equal(await request(origin, tls.cert, 'evil.example'), 403);
      await assert.rejects(request(origin), /self.signed certificate/i);
      child.write('quit\r'); await until(() => exited); child = undefined;
    }
  } finally { child?.kill(); await rm(home, { recursive: true, force: true }); }
});

test('--https rejects explicit TLS flags and missing OpenSSL with actionable errors', { timeout: 40_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'haze-tls-errors-'));
  let child: pty.IPty | undefined;
  try {
    for (const flags of [['--tls-cert', 'unused.pem', '--tls-key', 'unused-key.pem'], []]) {
      let output = '', exitCode: number | undefined;
      child = pty.spawn(process.execPath, ['--import', 'tsx', resolve('server/cli.ts'), '--https', '--haze', process.execPath, ...flags], {
        cwd: process.cwd(), name: 'xterm-256color', cols: 120, rows: 40, env: { ...process.env, HOME: home, PATH: home },
      });
      child.onData(data => { output += data; });
      child.onExit(event => { exitCode = event.exitCode; });
      await until(() => exitCode !== undefined);
      assert.notEqual(exitCode, 0);
      assert.match(output, flags.length ? /Choose --https or --tls-cert\/--tls-key/ : /Install OpenSSL/);
      child = undefined;
    }
    assert.deepEqual(await readdir(join(home, '.haze', 'remote', 'tls')), [], 'Failed generation leaves no identity or staging directory');
  } finally { child?.kill(); await rm(home, { recursive: true, force: true }); }
});
