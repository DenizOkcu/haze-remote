import { isIP } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export type LanInterfaceInventory = Record<string, readonly NetworkInterfaceInfo[] | undefined>;

export interface LanSelectionOptions {
  /** Exact numeric address assigned to the OS interface; never a hostname. */
  address: string;
  /** Canonical IPv4 network/prefix, matching the OS netmask exactly. */
  subnet: string;
  interfaceName?: string;
  /** Tunnel-like interfaces require both a named interface and explicit approval. */
  approveTunnel?: boolean;
}

export interface LanSelection {
  readonly interfaceName: string;
  readonly address: string;
  readonly subnet: string;
  readonly netmask: string;
  readonly network: number;
  readonly prefix: number;
}

export interface LanCandidate {
  readonly address: string;
  readonly port: number;
  readonly component: number;
  readonly status: 'numeric-validated' | 'pending-native-resolution';
}

export interface LanRemotePath {
  localAddress: string;
  remoteAddress: string;
  protocol: string;
  localCandidateType: string;
  remoteCandidateType: string;
}

function ipv4(address: string): number {
  if (isIP(address) === 6) throw new Error('IPv6 LAN policy is unsupported; refusing the address');
  if (isIP(address) !== 4) throw new Error('LAN policy requires a numeric IPv4 address');
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
}

function privateAddress(value: number): boolean {
  return (value >>> 24) === 10 || (value >>> 20) === 0xac1 || (value >>> 16) === 0xc0a8;
}

function maskFor(prefix: number): number { return (0xffffffff << (32 - prefix)) >>> 0; }
function dotted(value: number): string {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

function parseSubnet(subnet: string) {
  const parts = subnet.split('/');
  if (isIP(parts[0]) === 6) throw new Error('IPv6 LAN policy is unsupported; refusing the subnet');
  if (parts.length !== 2 || !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(parts[1])) {
    throw new Error('An explicit canonical IPv4 subnet/prefix is required');
  }
  const prefix = Number(parts[1]);
  const network = ipv4(parts[0]);
  const mask = maskFor(prefix);
  if (((network & mask) >>> 0) !== network) throw new Error('Subnet must use its canonical network address');
  const last = (network | (~mask >>> 0)) >>> 0;
  if (!privateAddress(network) || !privateAddress(last)) {
    throw new Error('LAN subnet must be wholly within RFC1918 space; public, loopback and CGNAT are forbidden');
  }
  return { network, prefix, mask };
}

function validateNumericPeer(selection: LanSelection, address: string): void {
  const value = ipv4(address);
  if (!privateAddress(value) || ((value & maskFor(selection.prefix)) >>> 0) !== selection.network) {
    throw new Error('Remote address is outside the selected OS interface subnet');
  }
  const broadcast = (selection.network | (~maskFor(selection.prefix) >>> 0)) >>> 0;
  if (address === selection.address || (selection.prefix <= 30 && (value === selection.network || value === broadcast))) {
    throw new Error('Remote address must be a peer, not self, network or broadcast');
  }
}

/** Address-based selection, never first-interface or private-range guessing.
 * Names cannot prove physical topology: tunnel detection is deliberately conservative.
 */
export function selectLanInterface(
  options: LanSelectionOptions,
  inventory: LanInterfaceInventory = networkInterfaces(),
): LanSelection {
  const address = ipv4(options.address);
  if (!privateAddress(address)) throw new Error('LAN interface must have an RFC1918 address; loopback, public and CGNAT are forbidden');
  const subnet = parseSubnet(options.subnet);
  const matches = Object.entries(inventory).flatMap(([name, entries]) =>
    (entries ?? []).filter(entry => entry.address === options.address).map(entry => ({ name, entry })))
    .filter(match => options.interfaceName === undefined || match.name === options.interfaceName);
  if (matches.length !== 1) throw new Error('Address must match exactly one selected OS interface');
  const { name, entry } = matches[0];
  if (entry.internal) throw new Error('Loopback/internal interfaces are forbidden');
  if (entry.family !== 'IPv4') throw new Error('IPv6 LAN policy is unsupported');
  const tunnel = /(?:^|[^a-z])(?:tun|tap|utun|wg|vpn|ppp|ipsec|tailscale|zerotier|zt|veth|docker|virbr|br-|gif|stf|gre|sit|ipip|vti)/i.test(name);
  if (tunnel && !(options.interfaceName === name && options.approveTunnel === true)) {
    throw new Error('VPN/tunnel/virtual interface requires explicit interface and subnet approval');
  }
  if (ipv4(entry.netmask) !== subnet.mask) throw new Error('Explicit subnet must match the OS interface netmask exactly');
  if (((address & subnet.mask) >>> 0) !== subnet.network) throw new Error('Interface address is outside the explicit subnet');
  const broadcast = (subnet.network | (~subnet.mask >>> 0)) >>> 0;
  if (subnet.prefix <= 30 && (address === subnet.network || address === broadcast)) {
    throw new Error('Interface address cannot be the network or broadcast address');
  }
  return Object.freeze({ interfaceName: name, address: options.address, subnet: `${dotted(subnet.network)}/${subnet.prefix}`,
    netmask: entry.netmask, network: subnet.network, prefix: subnet.prefix });
}

/** Validate a raw trickle candidate or an SDP a=candidate line. No DNS is performed.
 * A .local result is provisional only, never authorization to send application data.
 */
export function validateIceCandidate(selection: LanSelection, candidate: string): LanCandidate {
  const line = candidate.trim().replace(/^a=/, '');
  if (/[\r\n]/.test(line)) throw new Error('Expected one ICE candidate line');
  const fields = line.split(/\s+/);
  if (fields.length < 8 || !/^candidate:[A-Za-z0-9+/]{1,32}$/.test(fields[0]) ||
      !/^[12]$/.test(fields[1]) || !/^\d+$/.test(fields[3]) || Number(fields[3]) > 0xffffffff ||
      !/^\d+$/.test(fields[5]) || Number(fields[5]) < 1 || Number(fields[5]) > 65535 || fields[6] !== 'typ') {
    throw new Error('Malformed ICE candidate');
  }
  if (fields[2].toLowerCase() !== 'udp' || fields[7] !== 'host') {
    throw new Error('LAN ICE permits only UDP host candidates; TCP, srflx, prflx and relay are forbidden');
  }
  const extensions = fields.slice(8);
  if (extensions.length % 2 !== 0 || extensions.some((field, index) => index % 2 === 0 && /^(?:raddr|rport|tcptype)$/i.test(field))) {
    throw new Error('Related addresses and TCP extensions are forbidden or malformed');
  }
  const address = fields[4];
  const mdns = address.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/i.test(address);
  if (!mdns) validateNumericPeer(selection, address);
  return Object.freeze({ address, port: Number(fields[5]), component: Number(fields[1]),
    status: mdns ? 'pending-native-resolution' : 'numeric-validated' });
}

/** Validate every advertised candidate, including candidates in every media section.
 * No candidates is allowed for trickle ICE, but is not proof of an authorized path.
 * Call validateIceCandidate for later trickle and validateSelectedRemotePath before use.
 */
export function validateSdpCandidates(selection: LanSelection, sdp: string): readonly LanCandidate[] {
  return sdp.split(/\r?\n/).filter(line => /^\s*(?:a=)?candidate:/i.test(line))
    .map(line => validateIceCandidate(selection, line));
}

/** Check the native ICE stack's actual selected pair, not SDP's c= address or DNS.
 * Caller must bind sockets to the selected interface, enforce UDP host-only ICE,
 * disable STUN/TURN, and revalidate on every pair change before application data.
 */
export function validateSelectedRemotePath(selection: LanSelection, path: LanRemotePath): void {
  if (path.protocol.toLowerCase() !== 'udp' || path.localCandidateType !== 'host' || path.remoteCandidateType !== 'host') {
    throw new Error('Selected path must be UDP with local and remote host candidates');
  }
  ipv4(path.localAddress);
  if (path.localAddress !== selection.address) throw new Error('Selected local path is not the approved OS interface address');
  validateNumericPeer(selection, path.remoteAddress);
}
