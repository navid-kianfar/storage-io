/**
 * CIDR matching for the allowed-networks list. Handles IPv4, IPv6 and the
 * IPv4-mapped form (`::ffff:10.0.0.1`) Node hands back on a dual-stack socket —
 * without that last case an IPv4 rule would silently never match.
 */

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_MAPPED_PREFIX = '::ffff:';

export interface ParsedCidr {
  readonly bytes: Uint8Array;
  readonly prefixLength: number;
}

function parseIpv4(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index] as string;
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return null;
    bytes[index] = octet;
  }
  return bytes;
}

function parseIpv6(address: string): Uint8Array | null {
  // A trailing IPv4 form (`::ffff:1.2.3.4`) is expanded to two groups first.
  const lastColon = address.lastIndexOf(':');
  let head = address;
  let tail: Uint8Array | null = null;
  if (lastColon !== -1 && address.slice(lastColon + 1).includes('.')) {
    tail = parseIpv4(address.slice(lastColon + 1));
    if (tail === null) return null;
    head = address.slice(0, lastColon + 1);
    const high = ((tail[0] as number) << 8) | (tail[1] as number);
    const low = ((tail[2] as number) << 8) | (tail[3] as number);
    head += `${high.toString(16)}:${low.toString(16)}`;
  }

  const doubleColon = head.indexOf('::');
  const groups: number[] = [];

  const toGroups = (text: string): number[] | null => {
    if (text.length === 0) return [];
    const parsed: number[] = [];
    for (const group of text.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      parsed.push(Number.parseInt(group, 16));
    }
    return parsed;
  };

  if (doubleColon === -1) {
    const all = toGroups(head);
    if (all === null || all.length !== 8) return null;
    groups.push(...all);
  } else {
    const left = toGroups(head.slice(0, doubleColon));
    const right = toGroups(head.slice(doubleColon + 2));
    if (left === null || right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups.push(...left, ...new Array<number>(missing).fill(0), ...right);
  }

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/** `null` when the text is not an address at all. */
export function parseAddress(address: string): Uint8Array | null {
  const trimmed = address.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(':')) return parseIpv6(trimmed);
  return parseIpv4(trimmed);
}

/** Accepts a bare address (treated as a full-length prefix) or `addr/len`. */
export function parseCidr(entry: string): ParsedCidr | null {
  const slash = entry.indexOf('/');
  if (slash === -1) {
    const bytes = parseAddress(entry);
    if (bytes === null) return null;
    return { bytes, prefixLength: bytes.length * 8 };
  }

  const bytes = parseAddress(entry.slice(0, slash));
  if (bytes === null) return null;

  const prefixLength = Number.parseInt(entry.slice(slash + 1), 10);
  const maxBits = bytes.length === 4 ? IPV4_BITS : IPV6_BITS;
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > maxBits) return null;

  return { bytes, prefixLength };
}

/**
 * Normalises a client address so an IPv4 rule matches an IPv4-mapped client.
 * Express reports `::ffff:127.0.0.1` on a dual-stack listener.
 */
export function normalizeClientAddress(address: string): string {
  const lower = address.toLowerCase();
  if (lower.startsWith(IPV4_MAPPED_PREFIX)) return address.slice(IPV4_MAPPED_PREFIX.length);
  return address;
}

function sameFamilyPrefixMatches(network: ParsedCidr, candidate: Uint8Array): boolean {
  const fullBytes = Math.floor(network.prefixLength / 8);
  const remainingBits = network.prefixLength % 8;

  for (let index = 0; index < fullBytes; index += 1) {
    if (network.bytes[index] !== candidate[index]) return false;
  }
  if (remainingBits === 0) return true;

  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (
    ((network.bytes[fullBytes] as number) & mask) === ((candidate[fullBytes] as number) & mask)
  );
}

export function addressMatchesCidr(entry: string, address: string): boolean {
  const network = parseCidr(entry);
  if (network === null) return false;

  const candidate = parseAddress(normalizeClientAddress(address));
  if (candidate === null) return false;
  if (candidate.length !== network.bytes.length) return false;

  return sameFamilyPrefixMatches(network, candidate);
}

/** An empty list allows everything — that is what "no restriction" means. */
export function addressIsAllowed(allowed: readonly string[], address: string | null): boolean {
  if (allowed.length === 0) return true;
  if (address === null) return false;
  return allowed.some((entry) => addressMatchesCidr(entry, address));
}
