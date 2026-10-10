import * as opaque from '@serenity-kit/opaque';
import sodium from 'libsodium-wrappers';

export { opaque };
export const cryptoReady = Promise.all([opaque.ready, sodium.ready]);
export const PROTOCOL = 'haze-remote/2';
export const PIN_MS = 60_000;
export const CONFIRM_MS = 120_000;
export const REVIEW_MS = 120_000;
export interface ChannelBinding { clientFingerprint: string; serverFingerprint: string }

// DTLS SHA-256 fingerprints are role ordered, never lexically sorted. Accept
// SDP's colon-delimited form (with an optional sha-256 label) and normalize it.
export function canonicalChannelBinding(binding: ChannelBinding): string {
  const normalize = (value: string) => {
    if (typeof value !== 'string') throw new Error('Invalid SHA-256 DTLS fingerprint');
    const hex = value.trim().replace(/^sha-256\s+/i, '').replace(/:/g, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('Invalid SHA-256 DTLS fingerprint');
    return hex;
  };
  return JSON.stringify([`${PROTOCOL}/dtls/sha-256`, normalize(binding.clientFingerprint), normalize(binding.serverFingerprint)]);
}

export type DeviceCredential = { serverId: string; deviceId: string; password: string; serverPublicKey: string };

// OPAQUE's session key is an opaque encoded string. Hash its complete encoding
// into a fixed-size key, then domain-separate the two secretstream directions.
function material(sessionKey: string) {
  return sodium.crypto_generichash(32, sodium.from_string(`${PROTOCOL}/session/${sessionKey}`), null);
}
export function confirmationCode(sessionKey: string) {
  const key = material(sessionKey);
  const hash = sodium.crypto_generichash(32, sodium.from_string(`${PROTOCOL}/local-confirmation`), key);
  sodium.memzero(key);
  const number = new DataView(hash.buffer, hash.byteOffset, hash.byteLength).getUint32(0);
  sodium.memzero(hash);
  return (number % 100_000_000).toString().padStart(8, '0');
}
export function devicePassword() { return sodium.to_hex(sodium.randombytes_buf(32)); }

// Libsodium secretstream supplies nonce management, integrity, and ordered
// message/replay protection. No custom cipher or nonce counter is implemented.
type StreamState = ReturnType<typeof sodium.crypto_secretstream_xchacha20poly1305_init_pull>;
function releaseState(state: StreamState) {
  // Pinned wrappers 0.8.4 allocates numeric WASM stream handles but does not
  // yet expose the documented high-level free(). Use its exposed native
  // allocator, obtaining the struct size from libsodium rather than guessing.
  const native = (sodium as unknown as { libsodium: { HEAPU8: Uint8Array; _free: (address: number) => void; _crypto_secretstream_xchacha20poly1305_statebytes: () => number } }).libsodium;
  const address = state as unknown as number;
  sodium.memzero(native.HEAPU8.subarray(address, address + native._crypto_secretstream_xchacha20poly1305_statebytes()));
  native._free(address);
}
export class EncryptedChannel {
  readonly header: string;
  private pushState: StreamState | undefined;
  private pullState: StreamState | undefined;
  private receiveKey: Uint8Array | undefined;
  private readonly aad: Uint8Array | null;
  constructor(sessionKey: string, role: 'client' | 'server', binding?: ChannelBinding) {
    this.aad = binding ? sodium.from_string(canonicalChannelBinding(binding)) : null;
    const root = material(sessionKey);
    const key = (direction: string) => sodium.crypto_generichash(32, sodium.from_string(`${PROTOCOL}/${direction}`), root);
    const sendKey = key(role === 'client' ? 'client-to-server' : 'server-to-client');
    this.receiveKey = key(role === 'client' ? 'server-to-client' : 'client-to-server');
    const stream = sodium.crypto_secretstream_xchacha20poly1305_init_push(sendKey);
    this.pushState = stream.state;
    this.header = sodium.to_base64(stream.header);
    sodium.memzero(sendKey);
    sodium.memzero(root);
  }
  acceptHeader(header: string) {
    if (!this.receiveKey || this.pullState !== undefined) throw new Error('Duplicate stream header');
    const bytes = sodium.from_base64(header);
    if (bytes.length !== sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES) throw new Error('Invalid stream header');
    this.pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(bytes, this.receiveKey);
    sodium.memzero(this.receiveKey);
    this.receiveKey = undefined;
  }
  seal(message: unknown) {
    if (this.pushState === undefined) throw new Error('Channel closed');
    const bytes = sodium.from_string(JSON.stringify(message));
    const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(this.pushState, bytes, this.aad, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
    sodium.memzero(bytes);
    return { type: 'encrypted' as const, data: sodium.to_base64(encrypted) };
  }
  open(frame: unknown): any {
    if (this.pullState === undefined || !frame || typeof frame !== 'object' || (frame as any).type !== 'encrypted' || typeof (frame as any).data !== 'string') throw new Error('Encrypted frame required');
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(this.pullState, sodium.from_base64((frame as any).data), this.aad);
    if (!result || result.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE) throw new Error('Invalid, modified or replayed frame');
    try { return JSON.parse(sodium.to_string(result.message)); }
    finally { sodium.memzero(result.message); }
  }
  dispose() {
    if (this.pushState !== undefined) releaseState(this.pushState);
    if (this.pullState !== undefined) releaseState(this.pullState);
    if (this.receiveKey) sodium.memzero(this.receiveKey);
    this.pushState = this.pullState = undefined;
    this.receiveKey = undefined;
  }
}

export function registration(serverSetup: string, userIdentifier: string, password: string) {
  const start = opaque.client.startRegistration({ password });
  const response = opaque.server.createRegistrationResponse({ serverSetup, userIdentifier, registrationRequest: start.registrationRequest });
  return opaque.client.finishRegistration({ password, clientRegistrationState: start.clientRegistrationState, registrationResponse: response.registrationResponse }).registrationRecord;
}
