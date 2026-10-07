import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cryptoReady, opaque, EncryptedChannel, confirmationCode } from '../shared/crypto.js';
import { PairingGate, describeDevice } from '../server/pairing.js';
await cryptoReady;

function handshake(gate: PairingGate, password = gate.localPin()!.pin) {
  const start = opaque.client.startLogin({ password });
  const challenge = gate.begin(start.startLoginRequest);
  const client = opaque.client.finishLogin({ password, clientLoginState: start.clientLoginState, loginResponse: challenge.loginResponse });
  return { client, challenge };
}

test('OPAQUE verifies PIN without sending it; encrypted streams reject tampering, replay and reflection', () => {
  const gate = new PairingGate();
  const { client, challenge } = handshake(gate);
  assert.ok(client);
  const server = gate.finish(challenge, client.finishLoginRequest);
  assert.equal(server.sessionKey, client.sessionKey);
  assert.equal(confirmationCode(server.sessionKey), confirmationCode(client.sessionKey));
  const a = new EncryptedChannel(client.sessionKey, 'client');
  const b = new EncryptedChannel(server.sessionKey, 'server');
  try {
    a.acceptHeader(b.header); b.acceptHeader(a.header);
    const message = { type: 'input', data: 'PRIVATE terminal café 🦊' };
    const frame = a.seal(message);
    assert.ok(!JSON.stringify(frame).includes('PRIVATE'));
    assert.deepEqual(b.open(frame), message);
    assert.throws(() => b.open(frame), /Invalid/);
    const modified = a.seal(message);
    const chars = modified.data.split(''); chars[10] = chars[10] === 'A' ? 'B' : 'A';
    assert.throws(() => b.open({ ...modified, data: chars.join('') }));
    assert.throws(() => a.open(a.seal(message)), /Invalid/);
    assert.throws(() => a.open({ type: 'input', data: 'plaintext' }), /Encrypted/);
  } finally { a.dispose(); b.dispose(); }
  assert.equal(handshake(new PairingGate(), 'not-the-pin').client, undefined);
});

test('PIN expiry, fixed cross-rotation attempt budget, code B expiry and explicit local review', () => {
  let now = 0;
  const gate = new PairingGate(() => now);
  const original = gate.localPin()!.pin;
  const { client, challenge } = handshake(gate);
  assert.ok(client);
  now = 20000;
  assert.throws(() => gate.finish(challenge, client.finishLoginRequest), /expired/);
  gate.tick();
  assert.ok(gate.localPin()!.expiresAt > now);
  // Expired PIN cannot authenticate against the new registration record.
  assert.equal(handshake(gate, original).client, undefined);
  for (let i = 0; i < 3; i++) { now += 20000; gate.tick(); handshake(gate, 'wrong'); }
  now += 20000; gate.tick();
  assert.equal(gate.localPin(), null);
  assert.throws(() => handshake(gate, 'wrong'), /closed/);
  gate.reopen();
  const valid = handshake(gate);
  assert.ok(valid.client);
  const key = gate.finish(valid.challenge, valid.client.finishLoginRequest).sessionKey;
  let approved = 0, rejected = 0;
  const pending = gate.pending(key, { peer: '192.168.1.42', browser: 'Safari', platform: 'iPad' }, () => approved++, () => rejected++);
  assert.throws(() => gate.approve(pending.id), /Confirm/);
  assert.throws(() => gate.confirm('wrong'));
  const review = gate.confirm(confirmationCode(key));
  assert.equal(review.peer, '192.168.1.42');
  assert.ok(!('code' in review));
  now += 20000;
  assert.throws(() => gate.approve(pending.id), /expired/);
  assert.equal(rejected, 1);
  gate.reopen();
  const candidate = gate.pending(key, { peer: '127.0.0.1', browser: 'Firefox', platform: 'Linux' }, () => approved++, () => rejected++);
  gate.confirm(confirmationCode(key));
  gate.approve(candidate.id);
  assert.equal(approved, 1);
  assert.equal(gate.localPin(), null);
  assert.throws(() => gate.approve(candidate.id));
});

test('requester metadata cannot inject terminal escapes or fake the observed IP', () => {
  const device = describeDevice('::ffff:192.168.1.42', 'Chrome/123.0\x1b[2J\nAPPROVED Windows');
  assert.equal(device.peer, '192.168.1.42');
  assert.equal(device.browser, 'Chrome 123.0');
  assert.ok(!JSON.stringify(device).includes('APPROVED'));
});
