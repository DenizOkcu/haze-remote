import test from 'node:test';

import assert from 'node:assert/strict';
import { Connection, StunProtocol, Event, type RTCDataChannel, type RTCPeerConnection } from 'werift';
import { encodeFrames, Framer, RTC_FRAME_LIMIT, RTC_WIRE_LIMIT } from '../shared/rtc-framing.js';
import { descriptionFingerprint, admitsRemoteCandidate, selectedPeerAddress, RtcRemoteSocket, startLanPeer, restrictHostGathering, validateLocalCandidates } from '../server/webrtc.js';
import { SignalingClient } from '../shared/signaling.js';
import type { LanSelection } from '../server/lan.js';

const lan: LanSelection = { interfaceName: 'test', address: '192.168.4.10', subnet: '192.168.4.0/24', netmask: '255.255.255.0', network: 0xc0a80400, prefix: 24 };
const candidate = (host: string) => `candidate:1 1 UDP 123 ${host} 12345 typ host`;
const fp = Array(32).fill('AB').join(':');
function loopbackGather(t: test.TestContext) {
  t.mock.method(Connection.prototype, 'gatherCandidates', async function (this: Connection) {
    this.localCandidatesStart = true;
    await Promise.all(this.getCandidatePromises(['127.0.0.1', '192.0.2.2']));
    this.localCandidatesEnd = true;
  });
}

test('framing roundtrips text, escaping, Unicode and large secure wires within 64KiB', () => {
  for (const wire of ['', '{"type":"hello"}', '\u0000'.repeat(30000), 'a'.repeat(7999) + '😀'.repeat(20000), 'x'.repeat(RTC_WIRE_LIMIT)]) {
    const frames = encodeFrames(wire);
    const framer = new Framer();
    frames.forEach((frame, index) => {
      assert.ok(Buffer.byteLength(frame) <= RTC_FRAME_LIMIT);
      assert.equal(framer.push(frame), index === frames.length - 1 ? wire : undefined);
    });
  }
  assert.throws(() => encodeFrames('x'.repeat(RTC_WIRE_LIMIT + 1)));
});

test('framing rejects binary, reordered/interleaved, oversized and malformed input; resets', () => {
  const framer = new Framer();
  const frames = encodeFrames('x'.repeat(20000));
  assert.throws(() => framer.push(frames[1]));
  assert.equal(framer.push(frames[0]), undefined);
  assert.throws(() => framer.push(frames[0]));
  for (const bad of ['{}', 'null', 'x'.repeat(65537), JSON.stringify({ rtc: 1, count: 999999, index: 0, data: '' })]) assert.throws(() => framer.push(bad));
  assert.equal(framer.push(encodeFrames('ok')[0]), 'ok');
});

test('DTLS bindings require one consistent SHA256 fingerprint', () => {
  assert.equal(descriptionFingerprint(`v=0\r\na=fingerprint:sha-256 ${fp}\r\na=fingerprint:sha-256 ${fp.toLowerCase()}`), fp);
  for (const sdp of ['v=0', `a=fingerprint:sha-1 ${fp}`, 'a=fingerprint:sha-256 ab', `a=fingerprint:sha-256 ${fp}\na=fingerprint:sha-256 ${Array(32).fill('CD').join(':')}`]) assert.throws(() => descriptionFingerprint(sdp));
});

test('remote candidates are admitted only when numeric, in-subnet and host; .local mDNS never reaches ICE', () => {
  assert.equal(admitsRemoteCandidate(lan, candidate('192.168.4.22')), true);
  assert.equal(admitsRemoteCandidate(lan, candidate(lan.address)), true, 'same-machine hairpin peer');
  for (const line of [
    candidate('browser.local'), candidate('192.168.5.2'), candidate('8.8.8.8'), candidate('127.0.0.1'), candidate('::1'),
    candidate('192.168.4.22').replace('typ host', 'typ relay'), candidate('192.168.4.22').replace('UDP', 'TCP'),
    candidate('192.168.4.22').replace(' 1 UDP', ' 2 UDP'),
  ]) assert.equal(admitsRemoteCandidate(lan, line), false, line);
});

test('native nominated pair authorization re-reads pair changes and requires connected DTLS', () => {
  const pair = { localCandidate: { host: lan.address, transport: 'udp', type: 'host' },
    remoteCandidate: { type: 'host' }, remoteAddr: ['192.168.4.22', 12345] };
  const native = { connectionState: 'connected', dtlsTransports: [{ state: 'connected' }],
    iceTransports: [{ connection: { nominated: pair as typeof pair | undefined } }] };
  const check = () => selectedPeerAddress(native as unknown as RTCPeerConnection, lan);
  assert.equal(check(), '192.168.4.22');
  pair.remoteAddr[0] = '192.168.5.22'; assert.throws(check);
  pair.remoteAddr[0] = '192.168.4.22'; pair.localCandidate.host = '192.168.4.11'; assert.throws(check);
  pair.localCandidate.host = lan.address; pair.remoteCandidate.type = 'srflx'; assert.throws(check);
  pair.remoteCandidate.type = 'prflx'; assert.equal(check(), '192.168.4.22', 'peer-reflexive browser source is valid');
  pair.remoteCandidate.type = 'host'; native.dtlsTransports[0].state = 'connecting'; assert.throws(check);
  native.dtlsTransports[0].state = 'connected'; native.iceTransports[0].connection.nominated = undefined; assert.throws(check);
});

function fakeChannel() {
  return { readyState: 'open', bufferedAmount: 0, onMessage: new Event<[string | Buffer]>(),
    stateChange: new Event<[string]>(), error: new Event<[Error]>(), sent: [] as string[],
    send(frame: string) { this.sent.push(frame); }, close() { this.readyState = 'closed'; } };
}

test('RemoteSocket checks actual path on every message/send and bounds backpressure', () => {
  const channel = fakeChannel(); let allowed = true;
  const socket = new RtcRemoteSocket(channel as unknown as RTCDataChannel, () => allowed);
  const messages: string[] = []; let closed = 0;
  socket.on('message', (data, binary) => { assert.equal(binary, false); messages.push(data.toString()); });
  socket.on('close', () => closed++);
  for (const frame of encodeFrames('x'.repeat(90000))) channel.onMessage.execute(frame);
  assert.equal(messages[0].length, 90000);
  socket.send('hello'); assert.equal(new Framer().push(channel.sent[0]), 'hello');
  allowed = false;
  channel.onMessage.execute(encodeFrames('forbidden')[0]);
  assert.equal(messages.length, 1); assert.equal(socket.readyState, 3); assert.equal(closed, 1);
  socket.close(); assert.equal(closed, 1);
  const slow = fakeChannel(); slow.bufferedAmount = RTC_WIRE_LIMIT;
  const blocked = new RtcRemoteSocket(slow as unknown as RTCDataChannel, () => true);
  blocked.send('x'.repeat(300000)); assert.equal(blocked.readyState, 3);
});

test('native peer offers reliable terminal + recvonly PCMU, polls, resets lease, closes', async t => {
  const offers: string[] = []; let leaves = 0; let closes = 0; let polls = 0;
  const fake = { send: async (signal: any) => { offers.push(signal.sdp); }, receive: async () => { polls++; return []; }, leave: async () => { leaves++; }, close: async () => { closes++; } };
  t.mock.method(SignalingClient, 'create', async () => fake);
  // Loopback only as a socket-binding fixture: never attach a peer or authorize it.
  loopbackGather(t);
  let publicStun = 0;
  t.mock.method(StunProtocol.prototype, 'request', async () => { publicStun++; throw new Error('public STUN must never gather'); });
  const host = await startLanPeer({ lan: { ...lan, address: '127.0.0.1' }, roomId: 'fixture', onSocket: () => assert.fail('no authorized nominated pair') });
  try {
    assert.match(offers[0], /a=ice-lite/);
    validateLocalCandidates(offers[0], { ...lan, address: '127.0.0.1' });
    assert.equal(publicStun, 0);
    assert.match(offers[0], /a=rtpmap:0 PCMU\/8000/);
    assert.match(offers[0], /a=recvonly/);
    assert.match(offers[0], /m=application/);
    assert.match(offers[0], /a=max-message-size:65536/);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.ok(polls >= 1);
    await host.resetPeer(); assert.equal(leaves, 1); assert.equal(offers.length, 2);
    assert.notEqual(/a=ice-ufrag:([^\r\n]+)/.exec(offers[0])?.[1], /a=ice-ufrag:([^\r\n]+)/.exec(offers[1])?.[1]);
  } finally { await host.close(); }
  assert.equal(closes, 1);
  assert.equal(publicStun, 0);
});

test('native gather input excludes extra interfaces and missing selected address fails closed', () => {
  let gathered: string[] = [];
  const connection = { getCandidatePromises(addresses: string[]) { gathered = addresses; return []; } };
  restrictHostGathering({ iceTransports: [{ connection }] } as unknown as RTCPeerConnection, lan);
  connection.getCandidatePromises(['192.168.5.10', lan.address]);
  assert.deepEqual(gathered, [lan.address]);
  assert.throws(() => connection.getCandidatePromises(['192.168.5.10']), /no longer available/);
  validateLocalCandidates(`a=${candidate(lan.address)}`, lan);
  for (const sdp of ['', `a=${candidate('192.168.5.10')}`, `a=${candidate(lan.address).replace('typ host', 'typ srflx')}`,
    `a=${candidate(lan.address)}\r\na=${candidate('192.168.5.10')}`]) assert.throws(() => validateLocalCandidates(sdp, lan));
});

test('rejected or out-of-subnet candidates are skipped, not fatal; a permitted candidate still connects the poll', async t => {
  loopbackGather(t);
  const signals: any[] = [
    { type: 'candidate', candidate: candidate('8.8.8.8'), sdpMid: '0', sdpMLineIndex: 0 },
    { type: 'candidate', candidate: candidate('192.168.9.9'), sdpMid: '0', sdpMLineIndex: 0 },
    { type: 'candidate', candidate: candidate('some-host.local'), sdpMid: '0', sdpMLineIndex: 0 },
    { type: 'candidate', candidate: candidate('192.168.4.77'), sdpMid: '0', sdpMLineIndex: 0 },
  ];
  const errors: string[] = [];
  let leaves = 0;
  t.mock.method(SignalingClient, 'create', async () => ({
    send: async () => {},
    receive: async () => signals.splice(0, 8),
    leave: async () => { leaves++; },
    close: async () => {},
  }));
  const host = await startLanPeer({ lan: { ...lan, address: '127.0.0.1' }, roomId: 'fixture', onSocket: () => assert.fail(), onError: message => errors.push(message) });
  try {
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.deepEqual(errors, [], 'no recovery must be triggered by rejected candidates');
    assert.equal(leaves, 0, 'the browser lease must not be invalidated');
  } finally { await host.close(); }
});

test('poll failures recover with leave + new offer, bounded backoff and shutdown cancellation', async t => {
  loopbackGather(t);
  let offers = 0; let leaves = 0; let closes = 0; let active = 0; let maxActive = 0;
  const errors: string[] = [];
  t.mock.method(SignalingClient, 'create', async () => ({
    send: async () => { offers++; }, receive: async () => { throw new Error('offline'); },
    leave: async () => { active++; maxActive = Math.max(active, maxActive); await Promise.resolve(); leaves++; active--; },
    close: async () => { closes++; },
  }));
  const host = await startLanPeer({ lan: { ...lan, address: '127.0.0.1' }, roomId: 'fixture', onSocket: () => assert.fail(), onError: message => errors.push(message) });
  // Real short bounded backoff (500ms, 1s, 2s) also exercises native teardown.
  try {
    const end = Date.now() + 9000;
    while (!errors.some(message => /stopped after 3 retries/.test(message)) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(offers, 4); assert.equal(leaves, 3); assert.equal(maxActive, 1);
    assert.ok(errors.some(message => /stopped after 3 retries/.test(message)));
    await host.resetPeer(); assert.equal(offers, 5);
    await new Promise(resolve => setTimeout(resolve, 650)); // Failure schedules first retry.
  } finally { await host.close(); }
  const count = offers;
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(offers, count); assert.equal(closes, 1);
});
