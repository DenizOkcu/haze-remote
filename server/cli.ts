#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, delimiter, join } from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import qr from 'qrcode-terminal';
import { startRemote } from './server.js';
import { chooseStartupLan, type LanSelection } from './lan.js';
import { acquireKeepAwake } from './keep-awake.js';

async function main() {
  const args = process.argv.slice(2), split = args.indexOf('--');
  const { values } = parseArgs({ args: split < 0 ? args : args.slice(0, split), options: {
    host: { type: 'string' }, subnet: { type: 'string' }, interface: { type: 'string' },
    cwd: { type: 'string', default: process.cwd() }, haze: { type: 'string', default: 'haze' },
    project: { type: 'string', multiple: true }, 'keep-awake': { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  }, allowNegative: true });
  if (values.help) {
    console.log(`haze-remote — HTTPS-hosted UI, authenticated LAN WebRTC control of Haze
Usage: haze-remote [options] [-- <Haze arguments>]
Uses the sole eligible LAN interface automatically; asks you to choose if there are several.
  --host <IPv4>       Optional exact local interface address
  --subnet <CIDR>     Optional subnet override; must match the OS netmask
  --interface <name>  Optional interface selection; VPN/tunnel interfaces are unsupported
  --cwd <path>        Project directory (default: current directory)
  --haze <path>       Haze executable (default: haze on PATH)
  --project <path>    Approve an additional project/worktree (repeatable)
  --[no-]keep-awake   Prevent host standby while running (default: on)
  -h, --help         Show help
  -v, --version      Show version

Scan the short-lived QR code on a device on the permitted LAN.
Internet is required for the HTTPS UI and hosted signaling service.
No local HTTP/TLS listener, certificate setup, STUN, TURN, or cloud relay.
Commands: pair, cancel, revoke, quit. Ctrl+C here stops owned Haze processes.
Pairing grants terminal control with your OS user's permissions.`);
    return;
  }
  if (values.version) { console.log('@denizokcu/haze-remote 0.0.1'); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run in a local interactive terminal. Pairing links grant control of this PC and must not be piped into logs.');
  let picker: ReturnType<typeof createPrompt> | undefined;
  let lan: LanSelection;
  const selection = new AbortController();
  try {
    lan = await chooseStartupLan({ address: values.host, subnet: values.subnet, interfaceName: values.interface }, async choices => {
      if (!picker) {
        picker = createPrompt({ input: process.stdin, output: process.stdout, terminal: true });
        picker.once('SIGINT', () => selection.abort());
        picker.once('close', () => selection.abort());
      }
      console.log('\nChoose the network your tablet is connected to:');
      choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice.interfaceName.replace(/[\x00-\x1f\x7f]/g, '')}: ${choice.address} (${choice.subnet})`));
      return picker.question(`Network [1-${choices.length}] (Enter cancels): `, { signal: selection.signal });
    });
  } finally { picker?.close(); }
  console.log(`Using LAN: ${lan.interfaceName} ${lan.address} (${lan.subnet}). Only this network is permitted.`);
  const command = values.haze!;
  let executable: string | undefined;
  const candidates = command.includes('/') ? [resolve(command)] : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); executable = candidate; break; } catch { /* Next PATH directory. */ }
  }
  if (!executable) throw new Error(`Haze executable not found: ${command}. Install @denizokcu/haze or use --haze /path/to/haze.`);
  const remote = await startRemote({ lan, cwd: resolve(values.cwd!), executable,
    args: split < 0 ? [] : args.slice(split + 1), newArgs: [],
    projects: (values.project ?? []).map(path => ({ cwd: resolve(path), name: path.split('/').filter(Boolean).at(-1) ?? 'Project' })),
    onError: message => console.error(message),
  });
  const keepAwake = await acquireKeepAwake({ pid: remote.pid, disable: !values['keep-awake'], log: message => console.log(message) });
  console.log(`\nhaze-remote · Haze PID ${remote.pid}\nPermitted LAN: ${lan.interfaceName} ${lan.address} / ${lan.subnet}\nProject: ${resolve(values.cwd!)}\nDisconnecting the browser does not stop Haze.`);
  function showPairing() {
    const url = remote.pairingUrl(), pin = remote.local.pin();
    if (!url || !pin) { console.log('Pairing closed. Use pair when no device is authorized.'); return; }
    console.log(`\nPairing link (single-use; expires ${new Date(pin.expiresAt).toLocaleTimeString()}):\n${url}\nKeep this link private. Scan on a device on the permitted LAN:`);
    qr.generate(url, { small: true });
  }
  showPairing();
  const local = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true; local.close(); keepAwake.stop(); console.log('\nStopping Haze and haze-remote…'); await remote.close();
  };
  local.on('line', line => {
    void (async () => {
      try {
        const value = line.trim();
        if (value === 'pair') { await remote.local.pair(); showPairing(); }
        else if (value === 'cancel') { await remote.local.cancel(); console.log('Pairing cancelled.'); }
        else if (value === 'revoke') { await remote.local.revoke(); console.log('Session revoked. Haze continues. Use pair to authorize a device.'); }
        else if (value === 'quit') await shutdown();
        else if (value) console.log('Commands: pair, cancel, revoke, quit.');
      } catch { console.error('Local operation failed. Revoke an existing device before pairing again.'); }
      if (!closing) local.prompt();
    })();
  });
  local.setPrompt('haze-remote local> '); local.prompt();
  local.on('SIGINT', () => { void shutdown(); });
  local.on('close', () => { if (!closing) void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
  void remote.exited.then(() => console.log('Initial Haze instance exited. Its final screen and other instances remain available.'));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'haze-remote could not start. Check --help and internet access.'); process.exitCode = 1; });
