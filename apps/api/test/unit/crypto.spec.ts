import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CryptoService,
  DecryptionError,
  constantTimeEquals,
  parseArgon2Phc,
  verifyArgon2,
} from '../../src/crypto/crypto.service';
import type { AppConfigService } from '../../src/config/app-config.service';

const SECRET = 'unit-test-app-secret-at-least-32-characters';

/**
 * A stub rather than a Nest testing module: `CryptoService` needs three values
 * from the config and nothing else, so booting DI would only slow the suite.
 */
const serviceWith = (overrides: Partial<Record<string, unknown>> = {}): CryptoService => {
  const config = {
    appSecret: SECRET,
    adminUsername: 'admin',
    adminPassword: 'admin-password',
    adminPasswordHash: undefined,
    ...overrides,
  } as unknown as AppConfigService;
  return new CryptoService(config);
};

describe('CryptoService secret envelopes', () => {
  it('round-trips a secret', () => {
    const crypto = serviceWith();
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    expect(crypto.decryptSecret(crypto.encryptSecret(secret))).toBe(secret);
  });

  it('round-trips empty, unicode and long values', () => {
    const crypto = serviceWith();
    for (const secret of ['', 'ключ-پسورد-🔐', 'x'.repeat(4096)]) {
      expect(crypto.decryptSecret(crypto.encryptSecret(secret))).toBe(secret);
    }
  });

  it('produces a different ciphertext each time for the same plaintext', () => {
    const crypto = serviceWith();
    const first = crypto.encryptSecret('same-secret');
    const second = crypto.encryptSecret('same-secret');
    // A fresh random IV per call; equal ciphertexts would mean a reused one.
    expect(first).not.toBe(second);
    expect(crypto.decryptSecret(first)).toBe(crypto.decryptSecret(second));
  });

  it('carries a version marker and four base64url parts', () => {
    const envelope = serviceWith().encryptSecret('anything');
    const parts = envelope.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    for (const part of parts.slice(1)) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a secret encrypted under a different APP_SECRET', () => {
    const envelope = serviceWith().encryptSecret('secret');
    const other = serviceWith({ appSecret: 'a-completely-different-secret-of-32-chars' });
    expect(() => other.decryptSecret(envelope)).toThrow(DecryptionError);
  });

  it('refuses a tampered ciphertext, which is what GCM authentication is for', () => {
    const crypto = serviceWith();
    const envelope = crypto.encryptSecret('secret-value');
    const [version, iv, tag, ciphertext] = envelope.split('.') as [string, string, string, string];

    const flipped = Buffer.from(ciphertext, 'base64url');
    flipped[0] = (flipped[0] as number) ^ 0xff;
    const tampered = [version, iv, tag, flipped.toString('base64url')].join('.');

    expect(() => crypto.decryptSecret(tampered)).toThrow(DecryptionError);
  });

  it('refuses a tampered authentication tag', () => {
    const crypto = serviceWith();
    const [version, iv, tag, ciphertext] = crypto.encryptSecret('v').split('.') as [
      string,
      string,
      string,
      string,
    ];
    const flipped = Buffer.from(tag, 'base64url');
    flipped[0] = (flipped[0] as number) ^ 0x01;
    expect(() =>
      crypto.decryptSecret([version, iv, flipped.toString('base64url'), ciphertext].join('.')),
    ).toThrow(DecryptionError);
  });

  it('refuses a malformed or wrongly versioned envelope', () => {
    const crypto = serviceWith();
    for (const bad of ['', 'nonsense', 'v1.only.three', 'v2.a.b.c']) {
      expect(() => crypto.decryptSecret(bad), bad).toThrow(DecryptionError);
    }
  });

  it('derives a different key per purpose from the same APP_SECRET', () => {
    const crypto = serviceWith();
    const a = crypto.deriveKey('purpose-a');
    const b = crypto.deriveKey('purpose-b');
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
    // Deterministic for the same purpose, or nothing could ever be decrypted.
    expect(crypto.deriveKey('purpose-a').equals(a)).toBe(true);
  });
});

describe('CryptoService masking', () => {
  it('shows only the last four characters', () => {
    const crypto = serviceWith();
    expect(crypto.maskSecret('wJalrXUtnFEMIabcd')).toBe('••••abcd');
  });

  it('shows nothing at all for a short secret', () => {
    const crypto = serviceWith();
    expect(crypto.maskSecret('abcd')).toBe('••••');
    expect(crypto.maskSecret('')).toBe('••••');
  });
});

describe('CryptoService tokens', () => {
  it('generates a prefixed API token and stores only its hash', () => {
    const crypto = serviceWith();
    const generated = crypto.generateApiToken();

    expect(generated.token).toMatch(/^sio_[A-Za-z0-9_-]+$/);
    expect(generated.prefix.startsWith('sio_')).toBe(true);
    expect(generated.token.startsWith(generated.prefix)).toBe(true);
    // The hash must not contain the token, or storing it would store the token.
    expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.hash).not.toContain(generated.token.slice(4));
  });

  it('hashes a token deterministically', () => {
    const crypto = serviceWith();
    expect(crypto.hashToken('abc')).toBe(crypto.hashToken('abc'));
    expect(crypto.hashToken('abc')).not.toBe(crypto.hashToken('abd'));
  });

  it('generates distinct session tokens', () => {
    const crypto = serviceWith();
    const tokens = new Set(Array.from({ length: 50 }, () => crypto.generateSessionToken().token));
    expect(tokens.size).toBe(50);
  });
});

describe('password verification', () => {
  it('accepts the configured plain password and rejects anything else', async () => {
    const crypto = serviceWith({ adminPassword: 'correct-horse' });
    await expect(crypto.verifyAdminPassword('correct-horse')).resolves.toBe(true);
    await expect(crypto.verifyAdminPassword('correct-hors')).resolves.toBe(false);
    await expect(crypto.verifyAdminPassword('')).resolves.toBe(false);
  });

  it('prefers ADMIN_PASSWORD_HASH over ADMIN_PASSWORD', async () => {
    const hashing = serviceWith();
    const hash = await hashing.hashPassword('from-the-hash');

    const crypto = serviceWith({ adminPasswordHash: hash, adminPassword: 'ignored' });
    await expect(crypto.verifyAdminPassword('from-the-hash')).resolves.toBe(true);
    await expect(crypto.verifyAdminPassword('ignored')).resolves.toBe(false);
  });

  it('produces a parseable argon2id PHC string', async () => {
    const hash = await serviceWith().hashPassword('some-password');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);

    const parsed = parseArgon2Phc(hash);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      variant: 'argon2id',
      memorySize: 65536,
      iterations: 3,
      parallelism: 4,
    });
    expect(parsed?.hash).toHaveLength(32);
  });

  it('rejects an unparseable hash loudly rather than returning false', async () => {
    // A silent false would look like a wrong password and send the operator
    // looking in the wrong place.
    await expect(verifyArgon2('not-a-phc-string', 'whatever')).rejects.toThrow(/argon2/);
  });

  it('refuses argon2i and argon2d, which are not what we hash with', async () => {
    const argon2iStyle =
      '$argon2i$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaA';
    await expect(verifyArgon2(argon2iStyle, 'x')).rejects.toThrow(/argon2id/);
  });

  it('parseArgon2Phc returns null for shapes it cannot read', () => {
    for (const bad of ['', '$argon2id$', 'plain', '$argon2id$v=19$bad$salt$hash']) {
      expect(parseArgon2Phc(bad), bad).toBeNull();
    }
  });
});

describe('constantTimeEquals', () => {
  it('compares by value regardless of length', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
    expect(constantTimeEquals('a'.repeat(1000), 'a'.repeat(1000))).toBe(true);
  });

  it('handles non-ASCII without throwing on a length mismatch', () => {
    expect(constantTimeEquals('پسورد', 'پسورد')).toBe(true);
    expect(constantTimeEquals('پسورد', 'password')).toBe(false);
  });
});

describe('encrypted secrets are unreadable without the key', () => {
  it('a stored envelope contains no substring of the plaintext', () => {
    const secret = randomBytes(24).toString('hex');
    const envelope = serviceWith().encryptSecret(secret);
    expect(envelope).not.toContain(secret);
    expect(envelope).not.toContain(secret.slice(0, 8));
  });
});
