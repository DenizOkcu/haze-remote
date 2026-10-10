import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descriptionFingerprint, hostCandidate } from '../client/browser-lan-socket.js';
import { consumePairingFragment } from '../client/pairing-link.js';
import { SpeechRpc } from '../client/speech-rpc.js';

test('only host UDP candidates are advertised; no reflexive or relay fallback', () => {
  for (const address of ['192.168.1.20', 'abcd-123.local']) assert.equal(hostCandidate(`candidate:1 1 udp 123 ${address} 3000 typ host`), true);
  for (const candidate of ['candidate:1 1 udp 123 fe80::1 3000 typ host', 'candidate:1 1 udp 1 1.1.1.1 3000 typ srflx', 'candidate:1 1 udp 1 1.1.1.1 3000 typ relay', 'candidate:1 1 tcp 1 192.168.1.2 3000 typ host']) assert.equal(hostCandidate(candidate), false);
});
test('binding accepts only one consistent SHA256 description fingerprint', () => {
  const fp = Array(32).fill('ab').join(':');
  assert.equal(descriptionFingerprint(`v=0\r\na=fingerprint:sha-256 ${fp}\r\na=fingerprint:sha-256 ${fp}`), fp.toUpperCase());
  for (const sdp of ['v=0', `a=fingerprint:sha-1 ${fp}`, `a=fingerprint:sha-256 ${fp}\na=fingerprint:sha-256 ${Array(32).fill('cd').join(':')}`]) assert.throws(() => descriptionFingerprint(sdp));
});
test('fragment is consumed synchronously and only nonsecret room is retained', () => {
  const room = 'a'.repeat(32), secret = 'b'.repeat(64);
  const urls: string[] = [];
  const result = consumePairingFragment({ hash: `#room=${room}&secret=${secret}`, pathname: '/remote/', search: '' }, { replaceState: (_data, _unused, url) => urls.push(String(url)) });
  assert.deepEqual(result, { room, secret }); assert.deepEqual(urls, [`/remote/#room=${room}`]);
});
test('recording start and stop reuse recording id and carry no audio payload', async () => {
  const messages: any[] = [];
  const rpc = new SpeechRpc(message => { messages.push(message); return true; });
  const id = rpc.newRequestId();
  for (const type of ['speech-record-start', 'speech-record-stop'] as const) {
    const response = rpc.request({ type }, undefined, id);
    rpc.receive({ type: 'speech-result', requestId: id, status: { state: 'ready', downloadedBytes: 0 }, ...(type === 'speech-record-stop' ? { text: 'hello' } : {}) });
    await response;
  }
  assert.deepEqual(messages, [{ type: 'speech-record-start', requestId: id }, { type: 'speech-record-stop', requestId: id }]);
});
