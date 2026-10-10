import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const run = promisify(execFile);

export const TEST_HOSTNAME = `${'a'.repeat(32)}.devices.haze.build`;

/** Sign a CSR DER with a temporary CA: the certificate keeps the CSR public key (not self-signed). */
async function certificateFor(csrDer: Buffer, caKey: KeyObject, san: string, days: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'haze-acme-sign-'));
  try {
    await writeFile(join(directory, 'request.der'), csrDer);
    await writeFile(join(directory, 'ca-key.pem'), caKey.export({ type: 'sec1', format: 'pem' }));
    await run('openssl', ['req', '-x509', '-new', '-key', join(directory, 'ca-key.pem'), '-days', '1',
      '-subj', '/CN=Local ACME CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-out', join(directory, 'ca-cert.pem')]);
    await writeFile(join(directory, 'extensions.cnf'), `subjectAltName=DNS:${san}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n`);
    const { stdout } = await run('openssl', ['x509', '-req', '-in', join(directory, 'request.der'), '-inform', 'DER',
      '-CA', join(directory, 'ca-cert.pem'), '-CAkey', join(directory, 'ca-key.pem'), '-CAcreateserial',
      '-days', String(days), '-sha256', '-extfile', join(directory, 'extensions.cnf')]);
    return stdout.trim();
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** A local RFC 8555 directory that verifies the ES256 JWE/JWS, DNS-01 digest, CSR shape, and chain. */
export function localAcme(options: { leafDays?: number; failValidation?: boolean } = {}) {
  const { privateKey: caKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let nonce = 0, orders = 0;
  let challengeId: string | undefined, challengeDigest: string | undefined, csrDer: Buffer | undefined;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers({ 'replay-nonce': `nonce-${++nonce}` });
    const respond = (status: number, body?: unknown, extra: Record<string, string> = {}) => {
      for (const [name, value] of Object.entries(extra)) headers.set(name, value);
      if (body !== undefined) headers.set('content-type', 'application/json');
      return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
    };
    if (url.pathname === '/directory') return respond(200, { newAccount: `${url.origin}/acct`, newOrder: `${url.origin}/order`,
      meta: { termsOfService: 'https://letsencrypt.org/repository/' } });
    if (init?.method === 'HEAD') return respond(200);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { protected: string; payload: string; signature: string };
      const header = JSON.parse(Buffer.from(body.protected, 'base64url').toString());
      const payload = body.payload ? JSON.parse(Buffer.from(body.payload, 'base64url').toString()) : {};
      assert.equal(header.alg, 'ES256');
      assert.match(header.nonce, /^nonce-\d+$/, 'Every signed request must consume a replay nonce');
      if (url.pathname === '/acct') {
        assert.deepEqual(payload, { termsOfServiceAgreed: true });
        return respond(201, { status: 'valid' }, { location: `${url.origin}/account/1` });
      }
      if (url.pathname === '/order') {
        orders++;
        assert.deepEqual(payload.identifiers, [{ type: 'dns', value: TEST_HOSTNAME }]);
        return respond(201, { status: 'pending', authorizations: [`${url.origin}/auth/1`] }, { location: `${url.origin}/order/1` });
      }
      if (url.pathname === '/auth/1') return respond(200, { status: options.failValidation ? 'invalid' : 'valid',
        challenges: [{ type: 'dns-01', url: `${url.origin}/challenge/1` }], identifier: { value: TEST_HOSTNAME } });
      if (url.pathname === '/challenge/1') { assert.deepEqual(payload, {}); return respond(200, { status: 'valid' }); }
      if (url.pathname === '/order/1') {
        if (payload.csr) csrDer = Buffer.from(String(payload.csr), 'base64url');
        return respond(200, { status: 'valid', certificate: `${url.origin}/cert/1` });
      }
    }
    if (url.pathname === '/auth/1') return respond(200, { status: options.failValidation ? 'invalid' : 'valid', challenges: [{ type: 'dns-01', url: `${url.origin}/challenge/1` }] });
    if (url.pathname === '/order/1') return respond(200, { status: 'valid', certificate: `${url.origin}/cert/1` });
    if (url.pathname === '/cert/1') {
      assert.ok(csrDer, 'The certificate must be requested after finalizing a CSR');
      const leaf = await certificateFor(csrDer!, caKey, TEST_HOSTNAME, options.leafDays ?? 90);
      const intermediate = await certificateFor(csrDer!, caKey, 'haze-remote-intermediate', 90);
      return new Response(`${leaf}\n${intermediate}\n`, { status: 200, headers });
    }
    return respond(404, { error: 'unrecognized' });
  };
  return { request, get orderCount() { return orders; } };
}
