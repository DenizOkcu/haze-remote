import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type NetworkInterfaceInfo } from 'node:os';
import { chooseStartupLan, discoverLanInterfaces, selectLanInterface, validateIceCandidate, validateSdpCandidates, validateSelectedRemotePath,
  type LanInterfaceInventory, type LanRemotePath } from '../server/lan.js';

function entry(address = '192.168.50.10', netmask = '255.255.255.0', internal = false): NetworkInterfaceInfo {
  return { address, netmask, internal, family: 'IPv4', mac: '00:00:00:00:00:00', cidr: null };
}
const options = { address: '192.168.50.10', subnet: '192.168.50.0/24' };
const inventory: LanInterfaceInventory = { en0: [entry()], en1: [entry('192.168.60.10')] };
const selected = selectLanInterface(options, inventory);
const candidate = (address: string, transport = 'UDP', type = 'host') =>
  `candidate:1 1 ${transport} 2122260223 ${address} 50000 typ ${type}`;
const path: LanRemotePath = { localAddress: options.address, remoteAddress: '192.168.50.20',
  protocol: 'udp', localCandidateType: 'host', remoteCandidateType: 'host' };

test('selects exact OS address and canonical explicitly approved subnet, independent of inventory order', () => {
  assert.equal(selected.interfaceName, 'en0');
  assert.equal(selected.netmask, '255.255.255.0');
  assert.equal(selected.subnet, options.subnet);
  assert.ok(Object.isFrozen(selected));
  assert.equal(selectLanInterface(options, { en1: inventory.en1, en0: inventory.en0 }).interfaceName, 'en0');
  assert.throws(() => selectLanInterface({ ...options, address: '192.168.50.99' }, inventory), /exactly one/);
  assert.throws(() => selectLanInterface({ ...options, interfaceName: 'en1' }, inventory), /exactly one/);
  assert.throws(() => selectLanInterface(options, { en0: [entry()], en1: [entry()] }), /exactly one/);
  assert.equal(selectLanInterface({ ...options, interfaceName: 'en1' }, { en0: [entry()], en1: [entry()] }).interfaceName, 'en1');
});

test('requires canonical subnet, exact OS netmask and a private subnet containing the interface', () => {
  for (const subnet of ['', '192.168.50.0', '192.168.50.1/24', '192.168.50.0/024', '192.168.50.0/33',
    '192.168.0.0/16', '192.168.60.0/24', '128.0.0.0/1']) {
    assert.throws(() => selectLanInterface({ ...options, subnet }, inventory), undefined, subnet);
  }
  assert.throws(() => selectLanInterface(options, { en0: [entry(options.address, '255.0.255.0')] }), /netmask/);
  assert.throws(() => selectLanInterface(options, { lo0: [entry(options.address, '255.255.255.0', true)] }), /internal/);
  for (const address of ['127.0.0.1', '8.8.8.8', '100.64.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
    assert.throws(() => selectLanInterface({ ...options, address }, { en0: [entry(address)] }), /RFC1918/);
  }
  for (const address of ['192.168.50.0', '192.168.50.255']) {
    assert.throws(() => selectLanInterface({ ...options, address }, { en0: [entry(address)] }), /network or broadcast/);
  }
  assert.throws(() => selectLanInterface({ ...options, address: 'fd00::1' }, {}), /IPv6.*unsupported/);
  assert.throws(() => selectLanInterface({ ...options, subnet: 'fd00::/64' }, inventory), /IPv6.*unsupported/);
});

test('all RFC1918 blocks work with their OS mask; /31 peers are supported', () => {
  for (const [address, subnet, mask, peer] of [
    ['10.1.2.3', '10.0.0.0/8', '255.0.0.0', '10.4.5.6'],
    ['172.20.1.2', '172.16.0.0/12', '255.240.0.0', '172.31.255.254'],
    ['192.168.50.10', '192.168.50.10/31', '255.255.255.254', '192.168.50.11'],
  ]) {
    const lan = selectLanInterface({ address, subnet }, { eth0: [entry(address, mask)] });
    assert.equal(validateIceCandidate(lan, candidate(peer)).status, 'numeric-validated');
  }
});

test('VPN and tunnel names cannot be selected automatically or implicitly approved', () => {
  for (const name of ['tun0', 'tap0', 'utun4', 'wg0', 'tailscale0', 'ppp0', 'vpn0', 'zerotier0', 'docker0', 'veth123', 'br-abcd']) {
    const interfaces = { [name]: [entry()] };
    assert.throws(() => selectLanInterface(options, interfaces), /explicit.*approval/, name);
    assert.throws(() => selectLanInterface({ ...options, approveTunnel: true }, interfaces), /approval/, name);
    assert.throws(() => selectLanInterface({ ...options, interfaceName: name }, interfaces), /approval/, name);
    assert.equal(selectLanInterface({ ...options, interfaceName: name, approveTunnel: true }, interfaces).interfaceName, name);
  }
});

test('only well formed UDP host candidates inside the exact interface subnet pass', () => {
  assert.deepEqual(validateIceCandidate(selected, candidate('192.168.50.20')), {
    address: '192.168.50.20', port: 50000, component: 1, status: 'numeric-validated',
  });
  for (const address of ['192.168.60.20', '10.1.1.1', '172.16.1.1', '100.64.1.1', '127.0.0.1', '8.8.8.8',
    '192.168.50.0', '192.168.50.255', options.address, 'example.com', '192.168.050.20']) {
    assert.throws(() => validateIceCandidate(selected, candidate(address)), undefined, address);
  }
  assert.throws(() => validateIceCandidate(selected, candidate('fd00::20')), /IPv6.*unsupported/);
  for (const type of ['srflx', 'relay', 'prflx']) assert.throws(() => validateIceCandidate(selected, candidate('192.168.50.20', 'UDP', type)), /only UDP host/);
  assert.throws(() => validateIceCandidate(selected, candidate('192.168.50.20', 'TCP')), /only UDP host/);
  for (const line of ['candidate:bad', candidate('192.168.50.20').replace('50000', '0'),
    candidate('192.168.50.20').replace('50000', '65536'), candidate('192.168.50.20').replace('2122260223', '4294967296'),
    candidate('192.168.50.20') + ' raddr 192.168.50.21', candidate('192.168.50.20') + ' tcptype active',
    candidate('192.168.50.20') + ' odd', candidate('192.168.50.20') + '\nmalformed']) {
    assert.throws(() => validateIceCandidate(selected, line));
  }
});

test('mDNS is provisional and can authorize no path until native resolution yields a numeric subnet peer', () => {
  assert.equal(validateIceCandidate(selected, candidate('peer-123.local')).status, 'pending-native-resolution');
  assert.equal(validateIceCandidate(selected, candidate('PEER.local')).status, 'pending-native-resolution');
  for (const address of ['peer.local.evil', 'peer.local.', '-peer.local', 'peer..local']) {
    assert.throws(() => validateIceCandidate(selected, candidate(address)));
  }
  assert.throws(() => validateSelectedRemotePath(selected, { ...path, remoteAddress: 'peer-123.local' }), /numeric IPv4/);
  assert.doesNotThrow(() => validateSelectedRemotePath(selected, path));
  assert.throws(() => validateSelectedRemotePath(selected, { ...path, remoteAddress: '192.168.60.20' }), /outside/);
});

test('SDP validates all media candidates; candidate-free trickle is not path authorization', () => {
  const sdp = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=${candidate('192.168.50.20')}\r\na=${candidate('peer.local')}\r\na=end-of-candidates\r\n`;
  assert.deepEqual(validateSdpCandidates(selected, sdp).map(value => value.status), ['numeric-validated', 'pending-native-resolution']);
  assert.deepEqual(validateSdpCandidates(selected, 'v=0\r\na=ice-options:trickle\r\n'), []);
  assert.throws(() => validateSdpCandidates(selected, sdp + `m=audio 9 UDP/TLS/RTP/SAVPF 111\na=${candidate('8.8.8.8')}\n`), /outside/);
  assert.throws(() => validateSdpCandidates(selected, sdp + 'a=candidate:bad\n'), /Malformed/);
});

test('actual selected numeric path enforces the exact local interface and remote UDP host peer', () => {
  for (const change of [{ localAddress: '192.168.60.10' }, { localAddress: '0.0.0.0' }, { protocol: 'tcp' },
    { localCandidateType: 'relay' }, { remoteCandidateType: 'srflx' }, { remoteAddress: '100.64.0.1' },
    { remoteAddress: options.address }, { remoteAddress: '192.168.50.255' }]) {
    assert.throws(() => validateSelectedRemotePath(selected, { ...path, ...change }));
  }
  assert.throws(() => validateSelectedRemotePath(selected, { ...path, remoteAddress: '::ffff:192.168.50.20' }), /IPv6.*unsupported/);
});

test('plain startup automatically derives the sole LAN subnet, including the reported /22', async () => {
  const interfaces = { en0: [{ ...entry('192.168.68.66', '255.255.252.0'), cidr: '192.168.68.66/22' }],
    lo0: [entry('127.0.0.1', '255.0.0.0', true)], utun4: [entry('10.1.2.3')],
    public0: [entry('8.8.8.8')], cg0: [entry('100.64.0.1')],
    ipv6: [{ ...entry(), address: 'fd00::1', family: 'IPv6' as const, netmask: 'ffff:ffff:ffff:ffff::' }],
  };
  const lan = await chooseStartupLan({}, async () => { assert.fail('The sole LAN must not prompt'); }, interfaces);
  assert.equal(lan.interfaceName, 'en0');
  assert.equal(lan.address, '192.168.68.66');
  assert.equal(lan.subnet, '192.168.68.0/22');
  assert.equal(validateIceCandidate(lan, candidate('192.168.71.20')).status, 'numeric-validated');
  assert.throws(() => validateIceCandidate(lan, candidate('192.168.72.20')), /outside/);
});

test('multiple eligible interfaces require a choice and retry invalid answers instead of guessing', async () => {
  const answers = ['not a number', '0', '3', '1.5', '2'];
  let prompts = 0;
  const lan = await chooseStartupLan({}, async choices => {
    prompts++; assert.deepEqual(choices.map(choice => choice.interfaceName), ['en0', 'en1']);
    return answers.shift()!;
  }, { en1: inventory.en1, en0: inventory.en0 });
  assert.equal(prompts, 5);
  assert.equal(lan.interfaceName, 'en1');
  await assert.rejects(chooseStartupLan({}, async () => '', inventory), /cancelled/);
});

test('optional host and interface overrides infer netmask, never fall back after an invalid override', async () => {
  const noPrompt = async () => { assert.fail('A unique explicit selection must not prompt'); };
  assert.equal((await chooseStartupLan({ address: '192.168.60.10' }, noPrompt, inventory)).subnet, '192.168.60.0/24');
  assert.equal((await chooseStartupLan({ interfaceName: 'en1' }, noPrompt, inventory)).address, '192.168.60.10');
  assert.equal(discoverLanInterfaces({ subnet: '192.168.60.0/24' }, inventory).length, 1);
  for (const override of [{ address: '192.168.50.99' }, { interfaceName: 'missing' },
    { address: options.address, subnet: '192.168.0.0/16' }, { address: options.address, interfaceName: 'en1' }]) {
    await assert.rejects(chooseStartupLan(override, noPrompt, inventory));
  }
  const duplicate = { en0: [entry()], en1: [entry()] };
  assert.throws(() => discoverLanInterfaces({ address: options.address }, duplicate), /disambiguate/);
  assert.equal(discoverLanInterfaces({ address: options.address, interfaceName: 'en1' }, duplicate)[0].interfaceName, 'en1');
});

test('discovery excludes malformed masks and unsupported networks even when requested by name', () => {
  for (const interfaces of [{}, { en0: [entry(options.address, '255.0.255.0')] },
    { en0: [entry(options.address, '0.0.0.0')] }, { tun0: [entry()] }, { lo0: [entry('127.0.0.1', '255.0.0.0', true)] }]) {
    assert.throws(() => discoverLanInterfaces({}, interfaces), /No supported/);
  }
  assert.throws(() => discoverLanInterfaces({ interfaceName: 'utun4' }, { utun4: [entry()] }), /No supported/);
  assert.throws(() => discoverLanInterfaces({ address: options.address }, { en0: [entry(options.address, '255.0.255.0')] }), /invalid.*netmask/);
  for (const [address, mask, subnet] of [['192.168.70.66', '255.255.252.0', '192.168.68.0/22'],
    ['10.20.31.66', '255.255.240.0', '10.20.16.0/20'], ['192.168.50.10', '255.255.255.254', '192.168.50.10/31']]) {
    assert.equal(discoverLanInterfaces({}, { en0: [entry(address, mask)] })[0].subnet, subnet);
  }
});
