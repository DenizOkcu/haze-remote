#!/usr/bin/env node
// Runs only on the customer's computer. Never sends certificate or ACME keys.
import { readFile, mkdir, writeFile, chmod, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isIPv4 } from 'node:net';
import { resolveTxt } from 'node:dns/promises';
import { stderr } from 'node:process';

process.umask(0o077);
const directory = process.env.HAZE_PROVISION_DIRECTORY ?? join(homedir(), '.haze', 'provision');
const file = join(directory, 'installation.json');
const API_ORIGIN = 'https://haze.build';
class ProvisionError extends Error {}
function privateIPv4(address) {
  if (!isIPv4(address ?? '')) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
function validInstallation(value) {
  return typeof value?.id === 'string' && /^[a-f0-9]{32}$/.test(value.id)
    && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.token)
    && typeof value.hostname === 'string' && value.hostname.length <= 253
    && value.hostname.startsWith(`${value.id}.`)
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value.hostname);
}
async function api(path, token, method, body) {
  const response = await fetch(new URL(path, API_ORIGIN), {
    method, redirect: 'error', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new ProvisionError(`Provisioning failed (HTTP ${response.status}); retry or contact the operator`);
  return response.json();
}
async function saveAddress(installation, address) {
  const temporary = join(directory, `.installation-${randomUUID()}.json`);
  try {
    await writeFile(temporary, JSON.stringify({ ...installation, address }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
async function main() {
  const args = process.argv.slice(2);
  const [command, address] = args;
  if (!command || command === '--help' || command === '-h') {
    console.log(`Usage: haze-remote dns <command>
  enroll <private-IPv4>                Register once (open registration, no invitation)
  hostname                            Print the allocated direct-access hostname
  address <private-IPv4>               Explicitly publish a changed LAN/VPN address
  ensure-address <private-IPv4>        Startup: publish only if the last successful address differs
  challenge <digest>                   Create/reuse a DNS-01 TXT record; prints the challenge id
  challenge-cleanup <id>               Delete the exact DNS-01 challenge after validation
  auth / cleanup                      Local Certbot DNS-01 hooks
  unregister                          Revoke registration and remove DNS, retaining local files

API origin: https://haze.build (fixed; redirects are refused)
State: ~/.haze/provision (override with HAZE_PROVISION_DIRECTORY)
Enrollment/address publication discloses the private IP in public DNS; certificates
also disclose the hostname in transparency logs. No terminal/audio relay or key upload.
See docs/device-https.md for local certificate issuance and renewal.`);
    return;
  }
  const count = { enroll: 2, hostname: 1, address: 2, 'ensure-address': 2, unregister: 1, auth: 1, cleanup: 1, challenge: 2, 'challenge-cleanup': 2 }[command];
  if (!count || args.length !== count) throw new ProvisionError('Invalid DNS command or arguments; use haze-remote dns --help');
  if (command === 'enroll' || command === 'address' || command === 'ensure-address') {    if (!privateIPv4(address)) throw new ProvisionError('DNS publication requires a private LAN/VPN IPv4 address, not loopback, public or IPv6');
  }
  if (command === 'enroll') {
    // Refuse replacement of an existing installation, even after a partial prior attempt.
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    try { await readFile(file); throw new ProvisionError('Installation already exists; use address or unregister'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    stderr.write('Registration publishes an opaque certificate hostname and private address in public DNS.\nKeys stay local; terminal/audio connect directly over LAN/VPN.\n');
    const registration = await api('/v1/installations', null, 'POST', {});
    if (!validInstallation(registration)) throw new ProvisionError('Invalid enrollment response; contact the operator before retrying enrollment');
    await writeFile(file, JSON.stringify({ id: registration.id, hostname: registration.hostname, token: registration.token }), { flag: 'wx', mode: 0o600 });
    await api(`/v1/installations/${registration.id}/address`, registration.token, 'PUT', { address });
    await saveAddress(registration, address);
    console.log(registration.hostname); return;
  }
  const installation = JSON.parse(await readFile(file, 'utf8'));
  if (!validInstallation(installation)) throw new ProvisionError('Invalid local installation; do not overwrite it or enroll again blindly');
  const path = `/v1/installations/${installation.id}`;
  const request = (suffix, method, body) => api(path + suffix, installation.token, method, body);
  if (command === 'hostname') { console.log(installation.hostname); return; }
  if (command === 'challenge' || command === 'challenge-cleanup') {
    const value = command === 'challenge' ? address : argument;
    if (command === 'challenge') {
      if (!/^[A-Za-z0-9_-]{43}$/.test(value ?? '')) throw new ProvisionError('Missing or invalid DNS-01 digest');
      const challenge = await request('/challenges', 'POST', { value });
      if (!/^[a-f0-9]{32}$/.test(challenge.id ?? '')) throw new ProvisionError('Invalid challenge response');
      // Wait for the local resolver to see the exact value before answering; fail rather than validate prematurely.
      const name = `_acme-challenge.${installation.hostname}`;
      for (let attempt = 0; attempt < 90; attempt++) {
        try {
          if ((await resolveTxt(name)).some(parts => parts.join('') === value)) { console.log(challenge.id); return; }
        } catch { /* Propagation is not immediate. */ }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      await request(`/challenges/${challenge.id}`, 'DELETE').catch(() => {});
      throw new ProvisionError('DNS propagation timed out; check LAN/VPN DNS and retry');
    }
    if (!/^[a-f0-9]{32}$/.test(value ?? '')) throw new ProvisionError('Missing or invalid challenge identifier');
    await request(`/challenges/${value}`, 'DELETE'); return;
  }
  if (command === 'address' || command === 'ensure-address') {
    if (command === 'ensure-address' && installation.address === address) return;
    await request('/address', 'PUT', { address });
    await saveAddress(installation, address); return;
  }
  if (command === 'unregister') { await request('', 'DELETE'); console.log('Unregistered. Local keys and installation file retained; certificates are not revoked.'); return; }
  if (command !== 'auth' && command !== 'cleanup') throw new ProvisionError('Use haze-remote dns --help');
  if (process.env.CERTBOT_DOMAIN !== installation.hostname) throw new ProvisionError('Certificate domain must exactly match this installation');
  if (command === 'cleanup') {
    const id = (process.env.CERTBOT_AUTH_OUTPUT ?? '').trim();
    if (!/^[a-f0-9]{32}$/.test(id)) throw new ProvisionError('Missing challenge identifier');
    await request(`/challenges/${id}`, 'DELETE'); return;
  }
  const value = process.env.CERTBOT_VALIDATION;
  if (!/^[A-Za-z0-9_-]{43}$/.test(value ?? '')) throw new ProvisionError('Missing or invalid DNS-01 validation digest');
  const challenge = await request('/challenges', 'POST', { value });
  if (!/^[a-f0-9]{32}$/.test(challenge.id ?? '')) throw new ProvisionError('Invalid challenge response');
  // Wait for the customer's resolver to see the exact value. CA validation is authoritative;
  // cached negative answers may delay this check, so fail rather than validate prematurely.
  const name = `_acme-challenge.${installation.hostname}`;
  try {
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        if ((await resolveTxt(name)).some(parts => parts.join('') === value)) { console.log(challenge.id); return; }
      } catch { /* Propagation is not immediate. */ }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new ProvisionError('DNS propagation timed out; check LAN/VPN DNS and retry the certificate order');
  } catch (error) {
    await request(`/challenges/${challenge.id}`, 'DELETE').catch(() => {}); throw error;
  }
}
main().catch(error => {
  console.error(error instanceof ProvisionError ? error.message : 'Local provisioning failed. Check enrollment, network, API availability and certificate-domain configuration.');
  process.exitCode = 1;
});
