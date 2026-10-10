#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { resolve, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';
import { startRemote, privateAddress } from './server.js';
import { acquireKeepAwake } from './keep-awake.js';
import { selfSignedTls } from './tls.js';
import { deviceHttps } from './device-https.js';
import { PIN_MS, CONFIRM_MS, REVIEW_MS } from '../shared/crypto.js';

async function main() {
  const args = process.argv.slice(2);
  const provisionScript = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../scripts/provision.mjs' : '../../scripts/provision.mjs', import.meta.url));
  if (args[0] === 'dns') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [provisionScript, ...args.slice(1)], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', code => { process.exitCode = code ?? 1; resolve(); });
    });
    return;
  }
  const split = args.indexOf('--');
  const parsed = parseArgs({ args: split < 0 ? args : args.slice(0, split), options: {
    host: { type: 'string' }, lan: { type: 'boolean' },
    port: { type: 'string', default: '8787' }, cwd: { type: 'string', default: process.cwd() },
    haze: { type: 'string', default: 'haze' },
    project: { type: 'string', multiple: true },
    https: { type: 'boolean' }, 'self-signed-https': { type: 'boolean' },
    'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' },
    hostname: { type: 'string' },
    'keep-awake': { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (parsed.values.help) {
    console.log(`haze-remote — locally approved, encrypted browser control of installed Haze

Usage: haze-remote [options] [-- <Haze arguments>]
       haze-remote dns <command> (see: haze-remote dns --help)
  --lan            Bind to the sole private IPv4 LAN interface (otherwise use --host)
  --host <address> Specific private/VPN or loopback IP (default: 127.0.0.1)
  --port <number>  HTTP(S) port (default: 8787; 0 selects a free port)
  --https          Use the registered haze.build device hostname; one-time guided enrollment,
                   local ACME DNS-01 certificate issuance, and automatic renewal (no Certbot needed)
  --self-signed-https  Explicit local self-signed IP certificate (requires OpenSSL on first use)
  --tls-cert <path> HTTPS certificate trusted by the browser (requires --tls-key)
  --tls-key <path>  HTTPS private key (requires --tls-cert)
  --hostname <DNS> Exact direct-access DNS name covered by the supplied TLS certificate
  --cwd <path>     Project directory (default: current directory)
  --haze <path>    Haze executable (default: haze on PATH)
  --project <path> Approve another project/worktree for new tabs (repeatable)
  --[no-]keep-awake  Prevent host standby while running (default: on; macOS caffeinate, Linux systemd-inhibit)
  -h, --help      Show help
  -v, --version   Show version

Example: haze-remote --lan -- --continue
Requires a local interactive terminal for approval. Wildcard/public binds are disabled.
Enter PIN A in the browser, enter its code B locally, review the peer, then approve.
Only one device may pair. Commands here: pair, revoke, reject, quit.
Terminal transport is encrypted, but HTTP page delivery can be modified by an active
network attacker. Use only trusted private networks. Keep this computer awake.`);
    return;
  }
  if (parsed.values.version) { console.log('@denizokcu/haze-remote 0.0.1'); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('A local interactive terminal is required for device approval. Do not pipe stdin/stdout.');
  const port = Number(parsed.values.port);
  if (!/^\d+$/.test(parsed.values.port!) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer between 0 and 65535.');
  if (parsed.values.lan && parsed.values.host) throw new Error('Choose --lan or --host, not both.');
  let host = parsed.values.host ?? '127.0.0.1';
  if (parsed.values.lan) {
    const addresses = [...new Set(Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).filter(e => e.family === 'IPv4' && !e.internal && privateAddress(e.address)).map(e => e.address)))];
    if (addresses.length !== 1) throw new Error(`Choose a private address with --host. Available: ${addresses.join(', ') || 'none'}`);
    host = addresses[0];
  }
  if (!privateAddress(host)) throw new Error('Use a specific private/VPN or loopback address, not 0.0.0.0, ::, or a public address.');
  if (!!parsed.values['tls-cert'] !== !!parsed.values['tls-key']) throw new Error('Provide both --tls-cert and --tls-key to enable HTTPS.');
  if (Number(!!parsed.values.https) + Number(!!parsed.values['self-signed-https']) + Number(!!parsed.values['tls-cert']) > 1) throw new Error('Choose --https, --self-signed-https, or --tls-cert/--tls-key, not more than one.');
  if (parsed.values.https && parsed.values.hostname !== undefined) throw new Error('--https uses the assigned device hostname; use --hostname only with supplied TLS files.');
  const command = parsed.values.haze!;
  let executable: string | undefined;
  const candidates = command.includes('/') ? [resolve(command)] : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); executable = candidate; break; } catch { /* Next PATH directory. */ }
  }
  if (!executable) throw new Error(`Haze executable not found: ${command}. Install @denizokcu/haze or use --haze /path/to/haze.`);
  const device = parsed.values.https ? await deviceHttps({ host, provisionScript }) : undefined;
  const hostname = device?.hostname ?? parsed.values.hostname;
  const automaticTls = parsed.values['self-signed-https'] ? await selfSignedTls(host) : undefined;
  const tls = device?.tls ?? automaticTls ?? (parsed.values['tls-cert'] ? { cert: await readFile(resolve(parsed.values['tls-cert'])), key: await readFile(resolve(parsed.values['tls-key']!)) } : undefined);
  if (automaticTls) console.log(`\nhaze-remote: using a persistent self-signed HTTPS certificate.\nSHA-256 fingerprint: ${automaticTls.fingerprint}\nOn first use, your browser will warn that the certificate is not trusted. On your trusted private network, verify this server/address and compare the certificate fingerprint before accepting an exception, if your browser allows it.\nThe same certificate is reused for this address across restarts; browser exceptions may not persist. Certificate files are stored under ~/.haze/remote/tls.\nAccepting a warning does not reliably enable microphones. Use a trusted certificate (--tls-cert/--tls-key) if microphone access remains blocked. Local pairing approval is still required.`);
  console.log(tls
    ? '\nhaze-remote: HTTPS enabled. Local approval still grants your OS user’s coding-agent permissions.'
    : '\nhaze-remote: terminal content will be encrypted. The HTTP-delivered application is NOT protected against active network interception.\nPair only on trusted networks. Local approval grants your OS user’s coding-agent permissions.');
  const remote = await startRemote({ host, port, tls, hostname, cwd: resolve(parsed.values.cwd!), executable,
    args: split < 0 ? [] : args.slice(split + 1), newArgs: [],
    projects: (parsed.values.project ?? []).map(path => ({ cwd: resolve(path), name: path.split('/').filter(Boolean).at(-1) ?? 'Project' })), assets: fileURLToPath(new URL('../client/', import.meta.url)),
    onPin(pin) {
      console.log(pin ? `\nPIN A: ${pin.pin} · expires ${new Date(pin.expiresAt).toLocaleTimeString()} (${PIN_MS / 1000} seconds). Enter it in the browser.` : '\nPairing closed. Use "pair" to reopen when no device is paired.');
    },
    onPending() { console.log(`\nBrowser passed PIN A. Enter the 8-digit code B shown on that device here within ${CONFIRM_MS / 60_000} minutes. Device review gets its own ${REVIEW_MS / 60_000} minutes after code entry.`); },
  });
  const keepAwake = await acquireKeepAwake({ pid: remote.pid, disable: !parsed.values['keep-awake'], log: message => console.log(message) });
  const displayHost = hostname ?? (host.includes(':') ? `[${host}]` : host);
  console.log(`\nhaze-remote · Haze PID ${remote.pid}\nProject: ${resolve(parsed.values.cwd!)}\nOpen: ${tls ? 'https' : 'http'}://${displayHost}:${remote.port}\n\nLocal commands: pair, revoke, reject, quit. Ctrl+C here stops Haze.\nOne device may pair; disconnects do not reopen pairing or stop Haze.${keepAwake.enabled ? '\nHost standby is prevented while haze-remote runs (--no-keep-awake to disable).' : ''}\n`);
  const local = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let reviewId: string | undefined;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true; local.close(); keepAwake.stop();
    console.log('\nStopping Haze and haze-remote…');
    await remote.close();
  };
  local.on('line', line => {
    try {
      const value = line.trim();
      if (/^\d{8}$/.test(value)) {
        const review = remote.local.confirm(value);
        reviewId = review.id;
        console.log(`\nApprove remote control of Haze?\nObserved network peer: ${review.peer}\nReported browser: ${review.browser}\nReported platform: ${review.platform}\nCheck the IP in your tablet’s Wi-Fi settings. Browser/platform are self-reported; VPN/proxy addresses may differ.\nNo physical location is inferred.\nThis grants terminal output/input and code execution with your permissions.\nCode B consumed. You now have ${REVIEW_MS / 60_000} minutes to review this device.\nType "approve" or "reject" before ${new Date(review.expiresAt).toLocaleTimeString()}.`);
      } else if (value === 'approve') {
        if (!reviewId) throw new Error('Enter code B locally and review the device first.');
        remote.local.approve(reviewId); reviewId = undefined;
        console.log('Device approved. Pairing closed. Use "revoke" to remove access.');
      } else if (value === 'reject') { remote.local.reject(); reviewId = undefined; console.log('Request rejected.'); }
      else if (value === 'pair') { remote.local.pair(); reviewId = undefined; }
      else if (value === 'revoke') { remote.local.revoke(); reviewId = undefined; console.log('Device revoked. Haze continues. Use "pair" to pair a new device.'); }
      else if (value === 'quit') { void shutdown(); }
      else if (value) console.log('Enter code B, approve, reject, pair, revoke, or quit.');
    } catch (error) { console.error(error instanceof Error ? error.message : 'Local operation failed'); }
    if (!closing) local.prompt();
  });
  local.setPrompt('haze-remote local> '); local.prompt();
  local.on('SIGINT', () => { void shutdown(); });
  local.on('close', () => { if (!closing) void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  void remote.exited.then(() => console.log('Initial Haze instance exited. Other instances continue; its recent output remains available in its tab.'));
}
main().catch(error => { console.error(`haze-remote: ${error.message}`); process.exitCode = 1; });
