import { X509Certificate } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { issueCertificate, loadCertificateState, saveCertificateState, type AcmeDns, type CertificateState } from './acme.js';

export type SetupQuestion = (prompt: string, secret?: boolean) => Promise<string>;

export async function setupQuestion(prompt: string, secret = false) {
  process.stdout.write(prompt);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output: secret ? muted : process.stdout, terminal: true });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once('line', resolve);
      rl.once('close', () => reject(new Error('HTTPS setup cancelled.')));
      rl.once('SIGINT', () => rl.close());
    });
  } finally { rl.close(); if (secret) process.stdout.write('\n'); }
}

type ProvisionRun = (args: string[], input?: string) => Promise<string>;

async function provisionRun(provisionScript: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [provisionScript, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, failed = false;
    const cancel = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(cancel, 10 * 60_000);
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) cancel(); else stdout += chunk; });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) cancel(); });
    child.stdin.on('error', () => {}); // A failed setup may close stdin early.
    child.stdin.end(input);
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
      if (failed || code !== 0) reject(new Error(`Device HTTPS setup command failed: ${args[0] ?? ''}`));
      else resolve(stdout.trim());
    });
  });
}

const RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000; // Renew inside the last 30 days of validity.

export async function deviceHttps(options: {
  host: string; provisionScript: string; home?: string; ask?: SetupQuestion; run?: ProvisionRun;
  acme?: typeof issueCertificate; log?: (message: string) => void; now?: () => number;
}) {
  const { host, provisionScript } = options;
  const home = options.home ?? homedir();
  const ask = options.ask ?? setupQuestion;
  const run = options.run ?? ((args: string[], input?: string) => provisionRun(provisionScript, args, input));
  const acme = options.acme ?? issueCertificate;
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now;
  const [a, b] = host.split('.').map(Number);
  if (!isIPv4(host) || !(a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a === 100 && b! >= 64 && b! <= 127)) {
    throw new Error('--https requires --lan or a private/VPN IPv4 --host. For loopback/self-signed HTTPS use --self-signed-https.');
  }
  const provisionDirectory = process.env.HAZE_PROVISION_DIRECTORY ?? join(home, '.haze', 'provision');
  let enrolled = true;
  try { await stat(join(provisionDirectory, 'installation.json')); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('Cannot access device registration. Check HAZE_PROVISION_DIRECTORY.');
    enrolled = false;
  }
  if (!enrolled) {
    log(`\nTrusted device HTTPS uses the public provisioning API at https://haze.build and certificates from Let's Encrypt.\nYour private address ${host} is published in public DNS; the assigned hostname appears in certificate-transparency logs.\nTerminal/audio connect directly over LAN/VPN. All keys stay on this computer.`);
    if ((await ask('Register this computer and publish this address? Type yes to continue: ')).trim().toLowerCase() !== 'yes') throw new Error('HTTPS enrollment cancelled; nothing was registered.');
    try { await run(['enroll', host]); }
    catch { throw new Error('Device enrollment failed. Any saved registration is retained; retry --https rather than deleting it or enrolling again.'); }
  }
  let hostname: string;
  try { hostname = await run(['hostname']); }
  catch { throw new Error('Cannot load the device hostname. Check registration and HAZE_PROVISION_DIRECTORY; existing state will not be replaced.'); }
  if (hostname.length > 253 || !/^[a-f0-9]{32}\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) throw new Error('Invalid assigned device hostname.');
  try { await run(['ensure-address', host]); }
  catch { throw new Error('Device DNS address update failed. Retry after the service cooldown; --https will not fall back to an IP URL or HTTP.'); }

  const certificateDirectory = join(home, '.haze', 'acme', hostname);
  const state: CertificateState | undefined = await loadCertificateState(certificateDirectory);
  let usable = false;
  if (state) {
    try {
      const certificate = new X509Certificate(state.certificate);
      usable = certificate.checkHost(hostname, { wildcards: false }) === hostname && !certificate.verify(certificate.publicKey)
        && Date.parse(certificate.validFrom) <= now() && Date.parse(certificate.validTo) > now() + RENEW_WITHIN_MS;
    } catch { usable = false; }
  }
  const dns: AcmeDns = {
    createChallenge: async digest => {
      const stdout = await run(['challenge', digest]);
      if (!/^[a-f0-9]{32}$/.test(stdout)) throw new Error('Device DNS challenge setup failed.');
      return stdout;
    },
    deleteChallenge: async id => { await run(['challenge-cleanup', id]); },
  };
  const served = (certificate: string, key: CertificateState['certificateKey']) =>
    ({ hostname, tls: { cert: Buffer.from(certificate), key: Buffer.from(key.export({ type: 'pkcs8', format: 'pem' }) as string) } });
  if (state && usable) {
    log(`\nhaze-remote: using the device certificate for ${hostname} (valid until ${new X509Certificate(state.certificate).validTo}). TLS/ACME keys stay local.`);
    return served(state.certificate, state.certificateKey);
  }
  if (!state) {
    // First issuance for this installation: the enrollment consent above covers the CA order and terms.
    log(`\nNo device certificate yet. Requesting one for ${hostname} from Let's Encrypt via DNS-01; the terms at\nhttps://letsencrypt.org/repository/ are accepted as part of enrollment. This can take a few minutes…`);
  } else {
    log(`\nThe device certificate for ${hostname} is missing, expiring, or invalid. Renewing via Let's Encrypt DNS-01.\nExisting keys are kept; nothing is silently replaced or downgraded.`);
  }
  let issued;
  try {
    issued = await acme({ dnsName: hostname, dns, accountKey: state?.accountKey, accountUrl: state?.accountUrl,
      // Persist the ACME account as soon as it exists so retries never burn new-account rate limits.
      onAccount: async account => {
        if (state?.accountUrl) return;
        const { readFile: read, writeFile: write, mkdir: make, chmod } = await import('node:fs/promises');
        await make(certificateDirectory, { recursive: true, mode: 0o700 });
        await chmod(certificateDirectory, 0o700);
        await write(join(certificateDirectory, 'acme-account-key.pem'), account.accountKey.export({ type: 'sec1', format: 'pem' }), { mode: 0o600 });
        await write(join(certificateDirectory, 'acme-account'), account.accountUrl + '\n', { mode: 0o600 });
        await read(join(certificateDirectory, 'acme-account-key.pem')); // Surface write failures immediately.
      } });
  } catch (error) {
    throw new Error(`Certificate issuance/renewal failed: ${error instanceof Error ? error.message : 'unknown error'}. The registration is retained; retry --https.`);
  }
  await saveCertificateState(certificateDirectory, issued, state ? 'renew' : 'create');
  log(`\nhaze-remote: device certificate for ${hostname} issued and stored locally (valid until ${new X509Certificate(issued.certificate).validTo}).`);
  return served(issued.certificate, issued.certificateKey);
}
