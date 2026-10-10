import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, createSign, randomBytes, KeyObject, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const USER_AGENT = 'haze-remote/0.0.1 acme-dns01';
const DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';
const RETRIES = 20;
const BACKOFF = [2, 5, 10, 20, 30];
const OID = {
  extensionRequest: Buffer.from('06092A864886F70D01090E', 'hex'),
  subjectAltName: Buffer.from('0603551D11', 'hex'),
  ecdsaWithSha256: Buffer.from('06082A8648CE3D040302', 'hex'),
};
const base64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length < 128 ? Buffer.from([content.length])
    : content.length < 256 ? Buffer.from([0x81, content.length]) : Buffer.from([0x82, content.length >> 8, content.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

/** PKCS#10 CSR with one dNSName SAN and an empty subject, signed ES256. */
export function buildCsr(dnsName: string, key: KeyObject): Buffer {
  const extension = tlv(0x30, Buffer.concat([OID.subjectAltName, tlv(0x04, tlv(0x30, tlv(0x82, Buffer.from(dnsName))))]));
  const attribute = tlv(0x30, Buffer.concat([OID.extensionRequest, tlv(0x31, tlv(0x30, extension))]));
  const info = tlv(0x30, Buffer.concat([
    tlv(0x02, Buffer.from([0])), tlv(0x30, Buffer.alloc(0)),
    createPublicKey(key).export({ format: 'der', type: 'spki' }),
    tlv(0xa0, attribute),
  ]));
  const signature = createSign('SHA256').update(info).sign(key) as Buffer;
  return tlv(0x30, Buffer.concat([info, tlv(0x30, OID.ecdsaWithSha256), tlv(0x03, Buffer.concat([Buffer.from([0]), signature]))]));
}

export type AcmeDns = {
  createChallenge: (digest: string) => Promise<string>;
  deleteChallenge: (id: string) => Promise<void>;
};

/** Minimal RFC 8555 DNS-01 flow: ES256 JWS, account, order, DNS challenge, finalize, chain download. */
export async function issueCertificate(options: {
  dnsName: string; dns: AcmeDns; directoryUrl?: string; accountKey?: KeyObject; accountUrl?: string;
  request?: typeof fetch; sleep?: (ms: number) => Promise<void>;
}) {
  const request = options.request ?? fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const dnsName = options.dnsName.toLowerCase();
  const accountKey = options.accountKey ?? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const jwk = createPublicKey(accountKey).export({ format: 'jwk' });
  const thumbprint = base64url(sha256(JSON.stringify(jwk)));
  let nonce: string | undefined;
  async function takeNonce(url: string) {
    if (nonce) { const value = nonce; nonce = undefined; return value; }
    const response = await request(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
    const value = response.headers.get('replay-nonce');
    if ((!response.ok && response.status !== 405) || !value) throw new Error('ACME service is unavailable or returned no nonce');
    return value;
  }
  async function signed(url: string, payload: Record<string, unknown>, useKid: boolean) {
    const head = { alg: 'ES256', url, nonce: await takeNonce(url), ...(useKid ? { kid: accountUrl } : { jwk }) };
    const body = `${base64url(JSON.stringify(head))}.${base64url(JSON.stringify(payload))}`;
    const signature = base64url(createSign('SHA256').update(body).sign(accountKey) as Buffer);
    const response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/jose+json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ protected: base64url(JSON.stringify(head)), payload: base64url(JSON.stringify(payload)), signature }) });
    const next = response.headers.get('replay-nonce');
    if (next) nonce = next;
    if (!response.ok) throw new Error(`ACME request failed (HTTP ${response.status})`);
    return { json: async () => await response.json(), headers: response.headers };
  }
  const get = async (url: string) => {
    const response = await request(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) throw new Error(`ACME request failed (HTTP ${response.status})`);
    return await response.json();
  };
  const directory = await get(options.directoryUrl ?? DIRECTORY);
  const terms = (directory as { meta?: { termsOfService?: string } }).meta?.termsOfService;
  if (typeof terms !== 'string' || !terms.startsWith('https://')) throw new Error('ACME terms of service are required before ordering');
  let accountUrl = options.accountUrl;
  if (!accountUrl) {
    const created = await signed(directory.newAccount, { termsOfServiceAgreed: true }, false);
    accountUrl = created.headers.get('location') ?? undefined;
    if (!accountUrl) throw new Error('ACME account creation failed');
  }
  const digest = base64url(sha256(`${base64url(randomBytes(32))}.${thumbprint}`));
  const challengeId = await options.dns.createChallenge(digest);
  try {
    const ordered = await signed(directory.newOrder, { identifiers: [{ type: 'dns', value: dnsName }] }, true);
    const orderUrl = ordered.headers.get('location')!;
    const authorizationUrl = (await ordered.json()).authorizations?.[0];
    if (!authorizationUrl) throw new Error('ACME order returned no authorization');
    const authorization = await get(authorizationUrl);
    const challenge = authorization.challenges?.find((entry: { type: string }) => entry.type === 'dns-01');
    if (!challenge?.url) throw new Error('ACME authorization does not offer DNS-01');
    await signed(challenge.url, {}, true);
    for (let attempt = 0; ; attempt++) {
      const state = await get(authorizationUrl);
      if (state.status === 'valid') break;
      if (state.status === 'invalid' || attempt >= RETRIES) throw new Error('ACME DNS validation failed or timed out');
      await sleep(BACKOFF[Math.min(attempt, BACKOFF.length - 1)] * 1000);
    }
    const { privateKey: certificateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await signed(orderUrl, { csr: base64url(buildCsr(dnsName, certificateKey)) }, true);
    let certificateUrl: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const order = await get(orderUrl);
      if (order.status === 'invalid') throw new Error('ACME order failed');
      if (order.certificate) { certificateUrl = order.certificate; break; }
      if (attempt >= RETRIES) throw new Error('ACME finalization timed out');
      await sleep(BACKOFF[Math.min(attempt, BACKOFF.length - 1)] * 1000);
    }
    const response = await request(certificateUrl!, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/pem-certificate-chain' } } as RequestInit);
    if (!response.ok) throw new Error(`ACME certificate download failed (HTTP ${response.status})`);
    const chain = (await response.text()).split(/(?=-----BEGIN CERTIFICATE-----)/).map(part => part.trim()).filter(part => part.startsWith('-----'));
    if (chain.length < 2) throw new Error('ACME returned an incomplete certificate chain');
    const leaf = new X509Certificate(chain[0]);
    if (!leaf.checkHost(dnsName, { wildcards: false }) || leaf.verify(leaf.publicKey)) throw new Error('Issued certificate does not match the device hostname');
    return { certificate: chain.join('\n') + '\n', certificateKey, accountKey, accountUrl, validTo: Date.parse(leaf.validTo) };
  } finally { await options.dns.deleteChallenge(challengeId).catch(() => {}); }
}

export type CertificateState = { accountKey: KeyObject; accountUrl: string; certificate: string; certificateKey: KeyObject };

export async function loadCertificateState(directory: string): Promise<CertificateState | undefined> {
  try {
    const [accountKey, accountUrl, certificate, certificateKey] = await Promise.all([
      readFile(join(directory, 'acme-account-key.pem')),
      readFile(join(directory, 'acme-account'), 'utf8'),
      readFile(join(directory, 'fullchain.pem'), 'utf8'),
      readFile(join(directory, 'privkey.pem')),
    ]);
    return { accountKey: createPrivateKey(accountKey), accountUrl: accountUrl.trim(), certificate, certificateKey: createPrivateKey(certificateKey) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Atomic publication with 0700/0600 permissions; existing files are replaced only per renewal. */
export async function saveCertificateState(directory: string, state: CertificateState, mode: 'create' | 'renew') {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const staging = join(directory, `.save-${randomBytes(8).toString('hex')}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    const files: Array<[string, string]> = [
      ['acme-account-key.pem', state.accountKey.export({ type: 'sec1', format: 'pem' }).toString()],
      ['acme-account', state.accountUrl + '\n'], ['fullchain.pem', state.certificate],
      ['privkey.pem', state.certificateKey.export({ type: 'sec1', format: 'pem' }).toString()],
    ];
    for (const [name, content] of files) {
      if (mode === 'create' && name !== 'fullchain.pem' && name !== 'privkey.pem') {
        try { await stat(join(directory, name)); continue; } catch { /* Write the account once. */ }
      }
      await writeFile(join(staging, name), content, { mode: 0o600 });
      await rename(join(staging, name), join(directory, name));
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
}
