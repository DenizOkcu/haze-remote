import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selfSignedTls } from '../server/tls.ts';

const id = 'a'.repeat(32), token = 't'.repeat(43), invitation = 'i'.repeat(43);
const hostname = `${id}.devices.haze.build`, challengeId = 'b'.repeat(32), digest = 'd'.repeat(43);
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'haze-provision-test-'));
  const tls = await selfSignedTls('localhost', home);
  const ca = join(home, 'api-ca.pem'); await writeFile(ca, tls.cert);
  const requests = [];
  let addressFails = false;
  const server = createServer(tls, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/installations' && req.method === 'POST') {
      assert.deepEqual(body, { invitation }); assert.equal(req.headers.authorization, undefined);
      res.end(JSON.stringify({ id, hostname, token })); return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{}'); return; }
    if (req.url.endsWith('/address') && addressFails) { res.writeHead(503); res.end('{}'); return; }
    if (req.url.endsWith('/challenges') && req.method === 'POST') {
      res.end(JSON.stringify({ id: challengeId, expiresAt: Date.now() + 600000 })); return;
    }
    res.end(JSON.stringify({ hostname, address: body?.address, deleted: true, revoked: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://localhost:${server.address().port}`;
  const directory = join(home, 'installation');
  const preload = join(home, 'resolver.mjs');
  await writeFile(preload, `import dns from 'node:dns/promises'; import { syncBuiltinESMExports } from 'node:module'; dns.resolveTxt = async name => {
    if (name !== ${JSON.stringify(`_acme-challenge.${hostname}`)}) throw new Error('Wrong DNS name');
    return [[${JSON.stringify(digest)}]];
  }; syncBuiltinESMExports();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    const request = new URL(url);
    if (request.origin !== 'https://haze.build') throw new Error('Client selected a non-public API origin');
    if (options.redirect !== 'error') throw new Error('Client allowed API redirects');
    return realFetch(new URL(request.pathname, ${JSON.stringify(origin)}), options);
  };`);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const run = (args, input = '', env = {}) => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, resolve('server/cli.ts'), 'dns', ...args], {
      env: { ...process.env, HOME: home, HAZE_PROVISION_DIRECTORY: directory, NODE_EXTRA_CA_CERTS: ca, NODE_OPTIONS: `--import=${preload}`, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolveResult({ code, stdout, stderr })); child.stdin.end(input);
  });
  return { run, requests, origin, directory, setAddressFailure: value => { addressFails = value; } };
}

test('DNS CLI enrolls over trusted HTTPS, protects state, updates address and unregisters without leaking credentials', async t => {
  const f = await fixture(t);
  const enrolled = await f.run(['enroll', '192.168.1.20'], invitation + '\n');
  assert.equal(enrolled.code, 0); assert.equal(enrolled.stdout.trim(), hostname);
  assert.match(enrolled.stderr, /public DNS/);
  assert.ok(!enrolled.stdout.includes(token) && !enrolled.stderr.includes(invitation));
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, 'installation.json'))).mode & 0o777, 0o600);
  assert.equal((await f.run(['hostname'])).stdout.trim(), hostname);
  // Legacy/tampered origin metadata must never redirect authenticated API requests.
  await writeFile(join(f.directory, 'installation.json'), JSON.stringify({ id, hostname, token, origin: 'https://other.example' }), { mode: 0o600 });
  assert.equal((await f.run(['address', '100.64.1.2'])).code, 0);
  assert.deepEqual(f.requests.at(-1), { method: 'PUT', path: `/v1/installations/${id}/address`, authorization: `Bearer ${token}`, body: { address: '100.64.1.2' } });
  const count = f.requests.length;
  assert.equal((await f.run(['enroll', '192.168.1.20'], invitation + '\n')).code, 1);
  assert.equal(f.requests.length, count, 'Existing identity cannot be replaced');
  assert.equal((await f.run(['unregister'])).code, 0);
  assert.equal(f.requests.at(-1).path, `/v1/installations/${id}`);
  assert.equal(f.requests.at(-1).method, 'DELETE');
  assert.equal((await f.run(['hostname'])).stdout.trim(), hostname, 'Unregister retains local state');
});

test('partial address failure retains enrollment and allows explicit retry without consuming another invitation', async t => {
  const f = await fixture(t); f.setAddressFailure(true);
  const result = await f.run(['enroll', '10.0.0.2'], invitation + '\n');
  assert.equal(result.code, 1); assert.match(result.stderr, /HTTP 503/);
  assert.equal((await f.run(['hostname'])).stdout.trim(), hostname);
  f.setAddressFailure(false);
  assert.equal((await f.run(['address', '10.0.0.2'])).code, 0);
  assert.equal(f.requests.filter(request => request.path === '/v1/installations').length, 1);
});

test('DNS CLI uses only the public API and rejects endpoint overrides and non-private IPv4 before network access', async t => {
  const f = await fixture(t);
  const help = await f.run(['--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /API origin: https:\/\/haze\.build/);
  for (const args of [ ['unknown'], ['enroll', 'https://other.example', '10.0.0.2'],
    ['enroll', '127.0.0.1'], ['enroll', '8.8.8.8'], ['enroll', '::1'],
    ['address', '169.254.1.2'], ['hostname', 'extra'] ]) {
    assert.equal((await f.run(args, invitation + '\n')).code, 1);
  }
  assert.equal(f.requests.length, 0);
});

test('Certbot hooks send only DNS-01 digests, wait for matching TXT and clean up the exact challenge', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(['enroll', '10.0.0.2'], invitation + '\n')).code, 0);
  const count = f.requests.length;
  assert.equal((await f.run(['auth'], '', { CERTBOT_DOMAIN: 'other.example', CERTBOT_VALIDATION: digest })).code, 1);
  assert.equal((await f.run(['auth'], '', { CERTBOT_DOMAIN: hostname, CERTBOT_VALIDATION: 'invalid' })).code, 1);
  assert.equal(f.requests.length, count);
  const auth = await f.run(['auth'], '', { CERTBOT_DOMAIN: hostname, CERTBOT_VALIDATION: digest });
  assert.equal(auth.code, 0); assert.equal(auth.stdout.trim(), challengeId);
  assert.deepEqual(f.requests.at(-1).body, { value: digest });
  const cleanup = await f.run(['cleanup'], '', { CERTBOT_DOMAIN: hostname, CERTBOT_AUTH_OUTPUT: auth.stdout });
  assert.equal(cleanup.code, 0); assert.equal(cleanup.stdout, '');
  assert.equal(f.requests.at(-1).method, 'DELETE');
  assert.equal(f.requests.at(-1).path, `/v1/installations/${id}/challenges/${challengeId}`);
});
