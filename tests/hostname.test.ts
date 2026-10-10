import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { get } from 'node:https';
import { WebSocket } from 'ws';
import { startRemote } from '../server/server.js';

test('direct DNS HTTPS accepts only configured host and same origin, with local pairing still required', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haze-hostname-test-'));
  const hostname = '0123456789abcdef.devices.haze.build';
  let remote: Awaited<ReturnType<typeof startRemote>> | undefined;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=test', '-addext', `subjectAltName=DNS:${hostname}`,
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    const tls = { cert: await readFile(join(directory, 'cert.pem')), key: await readFile(join(directory, 'key.pem')) };
    const options = { host: '127.0.0.1', hostname, port: 0, cwd: directory, executable: process.execPath,
      args: [resolve('tests/fixtures/agent.mjs')], assets: resolve('tests/fixtures'), tls };
    await assert.rejects(startRemote({ ...options, tls: undefined }), /requires TLS/);
    await assert.rejects(startRemote({ ...options, hostname: 'other.devices.haze.build' }), /valid for/);
    await assert.rejects(startRemote({ ...options, hostname: '*.devices.haze.build' }), /exact lowercase/);
    remote = await startRemote(options);
    const port = remote.port;
    const origin = `https://${hostname}:${port}`;
    function status(host: string) {
      return new Promise<number>((accept, reject) => {
        get(`https://127.0.0.1:${port}/api/info`, { ca: tls.cert, servername: hostname,
          headers: { Host: host } }, response => { response.resume(); response.on('end', () => accept(response.statusCode!)); }).on('error', reject);
      });
    }
    assert.equal(await status(`${hostname}:${port}`), 200);
    assert.equal(await status(`other.devices.haze.build:${port}`), 403);
    assert.equal(await status(`${hostname}:${port + 1}`), 403);
    async function upgrade(requestOrigin: string) {
      return new Promise<number>((accept, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ca: tls.cert, servername: hostname,
          headers: { Host: `${hostname}:${port}`, Origin: requestOrigin } });
        ws.once('open', () => { ws.terminate(); accept(101); });
        ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); accept(res.statusCode!); });
        ws.on('error', () => {});
        const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Upgrade timed out')); }, 5000);
        ws.once('close', () => clearTimeout(timeout));
      });
    }
    assert.equal(await upgrade(origin), 101);
    assert.equal(await upgrade('https://evil.example'), 403);
    assert.ok(remote.local.pin(), 'TLS does not bypass local pairing');
  } finally { await remote?.close(); await rm(directory, { recursive: true, force: true }); }
});
