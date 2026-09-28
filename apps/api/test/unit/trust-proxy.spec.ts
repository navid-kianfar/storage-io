import { describe, expect, it } from 'vitest';
import { parseTrustProxy, validateEnv } from '../../src/config/env.schema';

/**
 * `X-Forwarded-For` is a request header, so a client can write one. Whether the
 * API believes it is this setting, and the default has to be "no" — a trusted hop
 * that is not really there hands every caller the address the allowed-networks
 * list is checked against and the login throttler counts.
 */

const baseEnv = {
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'password-1234',
  APP_SECRET: 'a-secret-that-is-at-least-32-characters',
} as const;

describe('parseTrustProxy', () => {
  it('is off for the default, an empty value and any casing of false', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('FALSE')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('   ')).toBe(false);
  });

  it('takes a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
  });

  it('takes a list of proxy addresses and CIDRs', () => {
    expect(parseTrustProxy('10.0.0.0/8, 192.168.1.10')).toEqual(['10.0.0.0/8', '192.168.1.10']);
    expect(parseTrustProxy('::1/128')).toEqual(['::1/128']);
    expect(parseTrustProxy('loopback')).toEqual(['loopback']);
  });

  it('refuses `true`, which would mean believing anybody', () => {
    expect(typeof parseTrustProxy('true')).toBe('symbol');
  });

  it('refuses a hop count of zero or an implausible one', () => {
    expect(typeof parseTrustProxy('0')).toBe('symbol');
    expect(typeof parseTrustProxy('99')).toBe('symbol');
  });

  it('refuses anything that is not an address', () => {
    expect(typeof parseTrustProxy('proxy.internal')).toBe('symbol');
    expect(typeof parseTrustProxy('10.0.0.0/8,nonsense')).toBe('symbol');
  });
});

describe('TRUST_PROXY in the validated environment', () => {
  it('defaults to off when the variable is absent', () => {
    expect(validateEnv({ ...baseEnv }).trustProxy).toBe(false);
  });

  it('carries a configured value through', () => {
    expect(validateEnv({ ...baseEnv, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(validateEnv({ ...baseEnv, TRUST_PROXY: '10.0.0.0/8' }).trustProxy).toEqual([
      '10.0.0.0/8',
    ]);
  });

  it('stops the process rather than quietly ignoring a bad value', () => {
    expect(() => validateEnv({ ...baseEnv, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });
});
