import { describe, expect, it } from 'vitest';
import {
  addressIsAllowed,
  addressMatchesCidr,
  normalizeClientAddress,
  parseAddress,
  parseCidr,
} from '../../src/common/net/cidr';

describe('addressMatchesCidr — IPv4', () => {
  it('matches inside a /24 and rejects outside it', () => {
    expect(addressMatchesCidr('10.0.0.0/24', '10.0.0.1')).toBe(true);
    expect(addressMatchesCidr('10.0.0.0/24', '10.0.0.255')).toBe(true);
    expect(addressMatchesCidr('10.0.0.0/24', '10.0.1.0')).toBe(false);
  });

  it('handles the /0 and /32 boundaries', () => {
    expect(addressMatchesCidr('0.0.0.0/0', '203.0.113.9')).toBe(true);
    expect(addressMatchesCidr('203.0.113.9/32', '203.0.113.9')).toBe(true);
    expect(addressMatchesCidr('203.0.113.9/32', '203.0.113.10')).toBe(false);
  });

  it('handles a prefix that is not a whole number of bytes', () => {
    // /20 covers 10.1.0.0 – 10.1.15.255.
    expect(addressMatchesCidr('10.1.0.0/20', '10.1.15.255')).toBe(true);
    expect(addressMatchesCidr('10.1.0.0/20', '10.1.16.0')).toBe(false);
    // /1 would break under a signed shift.
    expect(addressMatchesCidr('0.0.0.0/1', '127.255.255.255')).toBe(true);
    expect(addressMatchesCidr('0.0.0.0/1', '128.0.0.0')).toBe(false);
  });

  it('treats a bare address as a full-length prefix', () => {
    expect(addressMatchesCidr('192.168.1.5', '192.168.1.5')).toBe(true);
    expect(addressMatchesCidr('192.168.1.5', '192.168.1.6')).toBe(false);
  });

  it('rejects malformed entries and addresses rather than matching them', () => {
    expect(addressMatchesCidr('10.0.0.0/33', '10.0.0.1')).toBe(false);
    expect(addressMatchesCidr('10.0.0.0/-1', '10.0.0.1')).toBe(false);
    expect(addressMatchesCidr('999.0.0.0/8', '999.0.0.1')).toBe(false);
    expect(addressMatchesCidr('10.0.0.0/24', 'not-an-address')).toBe(false);
    expect(addressMatchesCidr('', '10.0.0.1')).toBe(false);
  });
});

describe('addressMatchesCidr — IPv6 and the mapped form', () => {
  it('matches an IPv6 prefix', () => {
    expect(addressMatchesCidr('2001:db8::/32', '2001:db8:1234::1')).toBe(true);
    expect(addressMatchesCidr('2001:db8::/32', '2001:db9::1')).toBe(false);
    expect(addressMatchesCidr('::1/128', '::1')).toBe(true);
  });

  it('matches an IPv4 rule against an IPv4-mapped client address', () => {
    // Node reports ::ffff:127.0.0.1 on a dual-stack listener; without
    // normalisation an IPv4 rule would silently never match.
    expect(addressMatchesCidr('127.0.0.0/8', '::ffff:127.0.0.1')).toBe(true);
    expect(addressMatchesCidr('10.0.0.0/8', '::ffff:10.1.2.3')).toBe(true);
    expect(addressMatchesCidr('10.0.0.0/8', '::ffff:11.1.2.3')).toBe(false);
  });

  it('never matches across families', () => {
    expect(addressMatchesCidr('10.0.0.0/8', '2001:db8::1')).toBe(false);
    expect(addressMatchesCidr('2001:db8::/32', '10.0.0.1')).toBe(false);
  });

  it('normalizeClientAddress strips only the mapped prefix', () => {
    expect(normalizeClientAddress('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeClientAddress('::FFFF:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeClientAddress('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeClientAddress('10.0.0.1')).toBe('10.0.0.1');
  });
});

describe('parseAddress and parseCidr', () => {
  it('parses the forms the settings schema accepts', () => {
    expect(parseAddress('10.0.0.1')).toHaveLength(4);
    expect(parseAddress('2001:db8::1')).toHaveLength(16);
    expect(parseAddress('::')).toHaveLength(16);
    expect(parseAddress('::ffff:1.2.3.4')).toHaveLength(16);
  });

  it('returns null for what is not an address', () => {
    for (const bad of [
      '',
      ' ',
      '10.0.0',
      '10.0.0.0.0',
      '10.0.0.256',
      'gggg::1',
      '1:2:3:4:5:6:7:8:9',
    ]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });

  it('reads the prefix length', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ bytes: expect.anything(), prefixLength: 8 });
    expect(parseCidr('2001:db8::/48')?.prefixLength).toBe(48);
    expect(parseCidr('10.0.0.0/129')).toBeNull();
    expect(parseCidr('2001:db8::/129')).toBeNull();
  });
});

describe('addressIsAllowed', () => {
  it('allows everything when the list is empty — that is what no restriction means', () => {
    expect(addressIsAllowed([], '203.0.113.9')).toBe(true);
    expect(addressIsAllowed([], null)).toBe(true);
  });

  it('allows an address matching any entry', () => {
    const allowed = ['10.0.0.0/8', '192.168.1.5', '2001:db8::/32'];
    expect(addressIsAllowed(allowed, '10.5.6.7')).toBe(true);
    expect(addressIsAllowed(allowed, '192.168.1.5')).toBe(true);
    expect(addressIsAllowed(allowed, '2001:db8::99')).toBe(true);
    expect(addressIsAllowed(allowed, '203.0.113.9')).toBe(false);
  });

  it('denies an unknown address when a list is set — fail closed', () => {
    expect(addressIsAllowed(['10.0.0.0/8'], null)).toBe(false);
  });

  it('a malformed entry does not accidentally allow everything', () => {
    expect(addressIsAllowed(['nonsense'], '10.0.0.1')).toBe(false);
  });
});
