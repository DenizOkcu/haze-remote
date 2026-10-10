import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** One certificate per address, independent of port. Never silently replace an existing identity. */
export async function selfSignedTls(host: string, home = homedir()) {
  if (!isIP(host) && host !== 'localhost') throw new Error('Automatic HTTPS requires an IP address or localhost.');
  const parent = join(home, '.haze', 'remote', 'tls');
  const directory = join(parent, createHash('sha256').update(host).digest('hex'));
  async function load() {
    await chmod(directory, 0o700);
    const certPath = join(directory, 'server-cert.pem'), keyPath = join(directory, 'server-key.pem');
    await chmod(keyPath, 0o600);
    const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
    const certificate = new X509Certificate(cert);
    createSecureContext({ cert, key }); // Reject a corrupt or mismatched pair.
    if (!(isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host))
      || Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()) {
      throw new Error('Saved HTTPS certificate is expired or does not match the address.');
    }
    return { cert, key, fingerprint: certificate.fingerprint256 };
  }
  let exists = false;
  try { await stat(directory); exists = true; }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (exists) {
    try { return await load(); }
    catch {
      throw new Error(`Cannot use saved HTTPS certificate. Use --tls-cert/--tls-key or intentionally remove the saved certificate directory to regenerate: ${directory}`);
    }
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const staging = await mkdtemp(join(parent, '.generate-'));
  try {
    try {
      await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
        '-keyout', join(staging, 'server-key.pem'), '-out', join(staging, 'server-cert.pem'),
        '-days', '365', '-subj', '/CN=haze-remote', '-addext', `subjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}`,
        '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth'],
      { timeout: 30_000, maxBuffer: 64 * 1024 });
    } catch {
      throw new Error('Could not generate an HTTPS certificate. Install OpenSSL with req -addext support, or provide --tls-cert and --tls-key.');
    }
    await chmod(join(staging, 'server-key.pem'), 0o600);
    try { await rename(staging, directory); }
    catch (error) {
      // Another startup may have published its identity first; reuse it.
      if (!(error instanceof Error && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY'))) throw error;
    }
    return await load();
  } finally { await rm(staging, { recursive: true, force: true }); }
}
