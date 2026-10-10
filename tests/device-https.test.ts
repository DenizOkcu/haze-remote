import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceHttps } from '../server/device-https.js';
import { issueCertificate } from '../server/acme.js';
import { localAcme, TEST_HOSTNAME } from './fixtures/local-acme.js';

function harness(home: string) {
  const asked: string[] = [], answers: string[] = [], logs: string[] = [], calls: string[][] = [];
  let enrolled = false;
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'enroll') {
      await mkdir(join(home, '.haze', 'provision'), { recursive: true });
      await writeFile(join(home, '.haze', 'provision', 'installation.json'),
        JSON.stringify({ id: 'a'.repeat(32), hostname: TEST_HOSTNAME, token: 't'.repeat(43), address: args[1] }), { mode: 0o600 });
      enrolled = true;
      return TEST_HOSTNAME;
    }
    if (args[0] === 'hostname') { assert.ok(enrolled, 'hostname requires enrollment'); return TEST_HOSTNAME; }
    if (args[0] === 'ensure-address') return '';
    if (args[0] === 'challenge') { assert.match(args[1] ?? '', /^[A-Za-z0-9_-]{43}$/); return 'b'.repeat(32); }
    if (args[0] === 'challenge-cleanup') { assert.match(args[1] ?? '', /^[a-f0-9]{32}$/); return ''; }
    throw new Error(`Unexpected provisioning command: ${args.join(' ')}`);
  };
  return {
    run, calls, logs, answers, asked,
    ask: async (prompt: string) => { asked.push(prompt); const value = answers.shift(); if (value === undefined) throw new Error('Unexpected question'); return value; },
    log: (message: string) => logs.push(message), get enrolled() { return enrolled; },
  };
}

test('--https enrolls once with open registration, issues via native DNS-01 without Certbot, and reuses silently on restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'haze-device-native-'));
  const acmeServer = localAcme();
  const h = harness(home);
  h.answers.push('yes');
  const issue = (options: Parameters<typeof issueCertificate>[0]) =>
    issueCertificate({ ...options, request: acmeServer.request, sleep: async () => {} });
  try {
    const first = await deviceHttps({ host: '192.168.68.66', provisionScript: '/script.mjs', home, ask: h.ask, run: h.run, log: h.log, acme: issue });
    assert.equal(first.hostname, TEST_HOSTNAME);
    const leaf = new X509Certificate(first.tls.cert);
    assert.ok(leaf.checkHost(TEST_HOSTNAME, { wildcards: false }));
    assert.equal(leaf.ca, false);
    assert.equal(h.asked.length, 1, 'A single typed consent');
    assert.ok(h.calls.some(call => call[0] === 'challenge'), 'A DNS-01 TXT record is created');
    assert.equal(h.calls.at(-1)![0], 'challenge-cleanup', 'The exact challenge is cleaned up');
    const directory = join(home, '.haze', 'acme', TEST_HOSTNAME);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'acme-account-key.pem'))).mode & 0o777, 0o600);

    const second = await deviceHttps({ host: '192.168.68.66', provisionScript: '/script.mjs', home, ask: h.ask, run: h.run, log: h.log, acme: issue });
    assert.equal(second.tls.cert.toString(), first.tls.cert.toString(), 'The same certificate is reused');
    assert.equal(second.tls.key.toString(), first.tls.key.toString());
    assert.equal(h.asked.length, 1, 'Restart asks nothing');
    assert.equal(acmeServer.orderCount, 1, 'No second ACME order on restart');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('--https renews automatically inside the 30-day window and serves the replacement', async () => {
  const home = await mkdtemp(join(tmpdir(), 'haze-device-renew-'));
  const expiring = localAcme({ leafDays: 20 });
  const fresh = localAcme({ leafDays: 90 });
  const h = harness(home);
  h.answers.push('yes');
  const issue = (server: ReturnType<typeof localAcme>) => (options: Parameters<typeof issueCertificate>[0]) =>
    issueCertificate({ ...options, request: server.request, sleep: async () => {} });
  try {
    const initial = await deviceHttps({ host: '10.0.0.2', provisionScript: '/script.mjs', home, ask: h.ask, run: h.run, log: h.log, acme: issue(expiring) });
    assert.ok(Date.parse(new X509Certificate(initial.tls.cert).validTo) < Date.now() + 30 * 24 * 60 * 60 * 1000);
    const askedBeforeRenewal = h.asked.length;
    const renewed = await deviceHttps({ host: '10.0.0.2', provisionScript: '/script.mjs', home, ask: h.ask, run: h.run, log: h.log, acme: issue(fresh) });
    assert.notEqual(renewed.tls.cert.toString(), initial.tls.cert.toString(), 'An expiring certificate is replaced');
    const leaf = new X509Certificate(renewed.tls.cert);
    assert.ok(Date.parse(leaf.validTo) > Date.now() + 30 * 24 * 60 * 60 * 1000, 'The replacement is outside the renewal window');
    assert.equal(h.asked.length, askedBeforeRenewal, 'Renewal requires no interaction');
    assert.match(h.logs.join('\n'), /Renewing/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('--https refuses loopback, declined consent, and failed issuance while retaining registration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'haze-device-refuse-'));
  const failing = localAcme({ failValidation: true });
  const h = harness(home);
  const issue = (options: Parameters<typeof issueCertificate>[0]) =>
    issueCertificate({ ...options, request: failing.request, sleep: async () => {} });
  try {
    await assert.rejects(deviceHttps({ host: '127.0.0.1', provisionScript: '/script.mjs', home, ask: h.ask, run: h.run }), /requires --lan or a private/);
    const declined = harness(home); declined.answers.push('no');
    await assert.rejects(deviceHttps({ host: '10.0.0.2', provisionScript: '/script.mjs', home, ask: declined.ask, run: declined.run }), /enrollment cancelled/);
    assert.equal(declined.calls.length, 0, 'No provisioning call happens without consent');

    h.answers.push('yes');
    await assert.rejects(deviceHttps({ host: '10.0.0.2', provisionScript: '/script.mjs', home, ask: h.ask, run: h.run, log: h.log, acme: issue }), /issuance\/renewal failed/);
    assert.ok((await readFile(join(home, '.haze', 'provision', 'installation.json'), 'utf8')).includes(TEST_HOSTNAME), 'Registration is retained for retry');
    assert.ok(h.calls.some(call => call[0] === 'challenge-cleanup'), 'A failed validation still cleans up its challenge');
  } finally { await rm(home, { recursive: true, force: true }); }
});
