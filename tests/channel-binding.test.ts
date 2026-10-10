import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cryptoReady, EncryptedChannel, canonicalChannelBinding, type ChannelBinding, type DeviceCredential } from '../shared/crypto.js';
import { ClientSession, type SocketTransport } from '../shared/session.js';
import { AccessController, type RemoteSocket } from '../server/access.js';
await cryptoReady;

const binding: ChannelBinding = { clientFingerprint: 'ab'.repeat(32), serverFingerprint: 'cd'.repeat(32) };
const other: ChannelBinding = { ...binding, serverFingerprint: 'ef'.repeat(32) };

test('DTLS AAD is canonical, role ordered, and rejects replay and another transport context', () => {
  const formatted = { clientFingerprint: `sha-256 ${Array(32).fill('AB').join(':')}`, serverFingerprint: Array(32).fill('CD').join(':') };
  assert.equal(canonicalChannelBinding(binding), canonicalChannelBinding(formatted));
  assert.notEqual(canonicalChannelBinding(binding), canonicalChannelBinding({ clientFingerprint: binding.serverFingerprint, serverFingerprint: binding.clientFingerprint }));
  assert.throws(() => canonicalChannelBinding({ ...binding, clientFingerprint: 'sha-1 00' }));
  const sender = new EncryptedChannel('test-session', 'client', binding);
  const receiver = new EncryptedChannel('test-session', 'server', formatted);
  const wrong = new EncryptedChannel('test-session', 'server', other);
  const unbound = new EncryptedChannel('test-session', 'server');
  try {
    for (const channel of [receiver, wrong, unbound]) channel.acceptHeader(sender.header);
    const frame = sender.seal({ type: 'enroll', password: 'test-only' });
    assert.throws(() => wrong.open(frame), /Invalid/);
    assert.throws(() => unbound.open(frame), /Invalid/);
    assert.deepEqual(receiver.open(frame), { type: 'enroll', password: 'test-only' });
    assert.throws(() => receiver.open(frame), /replayed/);
  } finally { for (const channel of [sender, receiver, wrong, unbound]) channel.dispose(); }
});

class TestSocket extends EventEmitter implements RemoteSocket {
  readyState = 1;
  bufferedAmount = 0;
  frames: string[] = [];
  client!: SocketTransport;
  send(data: string) { this.frames.push(data); queueMicrotask(() => { if (this.readyState === 1) this.client.onmessage?.({ data }); }); }
  close(code = 1000) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit('close');
    this.client?.onclose?.({ code });
  }
  terminate() { this.close(); }
  ping() {}
}
function transport(server: TestSocket, context?: ChannelBinding) {
  const sent: string[] = [];
  const client: SocketTransport = {
    readyState: 1, bufferedAmount: 0, channelBinding: context,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(data) { sent.push(data); queueMicrotask(() => { if (server.readyState === 1) server.emit('message', data, false); }); },
    close(code) { server.close(code); this.readyState = 3; },
  };
  server.client = client;
  return { client, sent };
}
async function flush() { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

test('bound auto-approval consumes the candidate only after enrollment, then resumes and rejects replay', async () => {
  let authenticated = 0, messages = 0;
  let credential: DeviceCredential | undefined;
  const access = new AccessController<TestSocket>({ requireBinding: true,
    onAuthenticated(ws) { authenticated++; access.send(ws, { type: 'snapshot' }); },
    onMessage() { messages++; },
  });
  const secret = access.gate.localPin()!.pin;
  const server = new TestSocket();
  const { client, sent } = transport(server, binding);
  const session = new ClientSession(client, { serverId: access.info().serverId, password: secret, requireBinding: true,
    onApproved(value) { credential = value; }, onError(message) { assert.fail(message); },
  });
  try {
    access.attach(server, { channelBinding: binding, autoApprove: true });
    assert.equal(authenticated, 0);
    client.onopen?.({});
    await flush();
    assert.ok(credential);
    assert.equal(authenticated, 1);
    assert.equal(access.gate.localPin(), null);
    assert.equal(access.info().pairing.pending, false);
    assert.equal(session.send({ type: 'input', data: 'test' }), true);
    await flush();
    assert.equal(messages, 1);
    server.emit('message', sent.at(-1), false);
    assert.equal(messages, 1);
    assert.equal(access.active(), undefined);

    const resumed = new TestSocket();
    const next = transport(resumed, binding);
    new ClientSession(next.client, { serverId: credential.serverId, password: credential.password, credential, requireBinding: true });
    access.attach(resumed, { channelBinding: binding });
    next.client.onopen?.({});
    await flush();
    assert.equal(authenticated, 2);
    assert.equal(access.active(), resumed);
    resumed.close();

    const mismatch = new TestSocket();
    const bad = transport(mismatch, other);
    new ClientSession(bad.client, { serverId: credential.serverId, password: credential.password, credential, requireBinding: true });
    access.attach(mismatch, { channelBinding: binding });
    bad.client.onopen?.({});
    await flush();
    assert.equal(authenticated, 2, 'Resume cannot gain authority before encrypted binding confirmation');
    assert.equal(mismatch.readyState, 3);
  } finally { access.dispose(); }
});

test('missing binding blocks auth before hello; wrong binding cannot auto-approve', async () => {
  let authenticated = 0;
  const access = new AccessController<TestSocket>({ requireBinding: true, onAuthenticated() { authenticated++; }, onMessage() { assert.fail('No application authority'); } });
  try {
    const missing = new TestSocket();
    transport(missing);
    access.attach(missing);
    assert.equal(missing.readyState, 3);
    assert.equal(missing.frames.length, 0);
    const unopened = new TestSocket();
    const noBinding = transport(unopened);
    new ClientSession(noBinding.client, { serverId: access.info().serverId, password: access.gate.localPin()!.pin, requireBinding: true });
    noBinding.client.onopen?.({});
    assert.equal(noBinding.sent.length, 0);

    const wrong = new TestSocket();
    const mismatch = transport(wrong, other);
    new ClientSession(mismatch.client, { serverId: access.info().serverId, password: access.gate.localPin()!.pin, requireBinding: true });
    access.attach(wrong, { channelBinding: binding, autoApprove: true });
    mismatch.client.onopen?.({});
    await flush();
    assert.equal(authenticated, 0);
    assert.equal(wrong.readyState, 3);
    assert.equal(access.info().paired, false);
    assert.equal(access.gate.localPin(), null, 'Failed enrollment does not renew the consumed secret');
  } finally { access.dispose(); }
});
