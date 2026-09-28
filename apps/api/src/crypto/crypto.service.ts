import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { argon2id } from 'hash-wasm';
import { API_TOKEN_PREFIX } from '@storage-io/contracts';
import { AppConfigService } from '../config/app-config.service';

/* ------------------------------ constants ------------------------- */

const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Envelope version, so a future key rotation can tell old blobs apart. */
const ENVELOPE_VERSION = 1;

/** HKDF salt/info. Fixed strings: the secret is the entropy, not these. */
const HKDF_SALT = 'storage-io/v1/hkdf-salt';
const HKDF_INFO_SECRETS = 'storage-io/v1/server-secrets';

/** Session and API tokens: 32 random bytes, base64url, stored only as SHA-256. */
const TOKEN_BYTES = 32;
const TOKEN_PREFIX_LENGTH = 8;

/** argon2id parameters for `ADMIN_PASSWORD` when no hash was supplied. */
const ADMIN_ARGON2 = {
  parallelism: 4,
  iterations: 3,
  memorySize: 65536,
  hashLength: 32,
} as const;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export interface GeneratedToken {
  readonly token: string;
  readonly hash: string;
  readonly prefix: string;
}

/* ------------------------------- service -------------------------- */

/**
 * Everything cryptographic the API does, in one place, so no feature module
 * reaches for `node:crypto` and picks its own parameters.
 *
 * Server secrets are sealed with AES-256-GCM under a key derived from
 * `APP_SECRET` by HKDF-SHA256 — the env value is never used as a key directly,
 * and a second purpose (a config export, say) derives its own key from the same
 * secret with a different `info`.
 */
@Injectable()
export class CryptoService {
  private readonly secretKey: Buffer;

  constructor(private readonly config: AppConfigService) {
    this.secretKey = this.deriveKey(HKDF_INFO_SECRETS);
  }

  /** HKDF-SHA256 from APP_SECRET. `info` separates purposes. */
  deriveKey(info: string): Buffer {
    const derived = hkdfSync('sha256', this.config.appSecret, HKDF_SALT, info, KEY_BYTES);
    return Buffer.from(derived);
  }

  /**
   * `v1.<iv>.<tag>.<ciphertext>`, each part base64url. Self-describing so the
   * format can change without a schema migration guessing game.
   */
  encryptSecret(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, this.secretKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      `v${ENVELOPE_VERSION}`,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decryptSecret(envelope: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 4) throw new DecryptionError('Malformed secret envelope.');

    const [version, ivPart, tagPart, ciphertextPart] = parts as [string, string, string, string];
    if (version !== `v${ENVELOPE_VERSION}`) {
      throw new DecryptionError(`Unsupported secret envelope ${version}.`);
    }

    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new DecryptionError('Malformed secret envelope.');
    }

    const decipher = createDecipheriv(CIPHER, this.secretKey, iv);
    decipher.setAuthTag(tag);
    try {
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, 'base64url')),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      // A GCM tag mismatch means the wrong APP_SECRET or a tampered row. Either
      // way the original error says nothing useful and may leak internals.
      throw new DecryptionError(
        'A stored secret could not be decrypted. APP_SECRET may have changed.',
      );
    }
  }

  /** `"••••last4"`, or all dots when the secret is too short to show a tail. */
  maskSecret(secret: string): string {
    if (secret.length <= 4) return '••••';
    return `••••${secret.slice(-4)}`;
  }

  /* ------------------------------ tokens --------------------------- */

  /** An opaque bearer token. Only its hash is ever stored. */
  generateApiToken(): GeneratedToken {
    const random = randomBytes(TOKEN_BYTES).toString('base64url');
    const token = `${API_TOKEN_PREFIX}${random}`;
    return {
      token,
      hash: this.hashToken(token),
      prefix: token.slice(0, API_TOKEN_PREFIX.length + TOKEN_PREFIX_LENGTH),
    };
  }

  generateSessionToken(): { token: string; hash: string } {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    return { token, hash: this.hashToken(token) };
  }

  /**
   * SHA-256 is right here and bcrypt/argon2 would be wrong: the input is 256
   * bits of our own randomness, so there is nothing to brute-force and a slow
   * hash would only tax every authenticated request.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  newId(): string {
    return randomUUID();
  }

  /* ----------------------------- passwords -------------------------- */

  /**
   * Verifies the login password against `ADMIN_PASSWORD_HASH` when one is set,
   * otherwise against `ADMIN_PASSWORD`. Both comparisons are constant-time.
   */
  async verifyAdminPassword(candidate: string): Promise<boolean> {
    const hash = this.config.adminPasswordHash;
    if (hash !== undefined) return verifyArgon2(hash, candidate);

    const expected = this.config.adminPassword;
    if (expected === undefined) return false;
    return constantTimeEquals(expected, candidate);
  }

  /** Produces an argon2id PHC string, for documenting ADMIN_PASSWORD_HASH. */
  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    return argon2id({
      password,
      salt,
      ...ADMIN_ARGON2,
      outputType: 'encoded',
    });
  }
}

/* ------------------------------ helpers --------------------------- */

/** Length-independent: comparing digests, not the strings themselves. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

interface Argon2Phc {
  readonly variant: string;
  readonly memorySize: number;
  readonly iterations: number;
  readonly parallelism: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

/**
 * hash-wasm can produce a PHC string but not verify one, so the parameters are
 * read back from the stored hash and the candidate is hashed with exactly those.
 * Rejecting an unparseable hash is deliberate: a silent `false` would look like
 * a wrong password and send the operator hunting in the wrong place.
 */
export function parseArgon2Phc(phc: string): Argon2Phc | null {
  const parts = phc.split('$');
  // ['', 'argon2id', 'v=19', 'm=65536,t=3,p=4', '<salt>', '<hash>']
  if (parts.length !== 6 || parts[0] !== '') return null;

  const variant = parts[1] as string;
  if (!variant.startsWith('argon2')) return null;

  const parameters = new Map<string, number>();
  for (const pair of (parts[3] as string).split(',')) {
    const [key, value] = pair.split('=');
    if (key === undefined || value === undefined) return null;
    const numeric = Number.parseInt(value, 10);
    if (Number.isNaN(numeric)) continue;
    parameters.set(key, numeric);
  }

  const memorySize = parameters.get('m');
  const iterations = parameters.get('t');
  const parallelism = parameters.get('p');
  if (memorySize === undefined || iterations === undefined || parallelism === undefined)
    return null;

  return {
    variant,
    memorySize,
    iterations,
    parallelism,
    salt: Buffer.from(parts[4] as string, 'base64'),
    hash: Buffer.from(parts[5] as string, 'base64'),
  };
}

export async function verifyArgon2(phc: string, candidate: string): Promise<boolean> {
  const parsed = parseArgon2Phc(phc);
  if (parsed === null) throw new Error('ADMIN_PASSWORD_HASH is not a parseable argon2 hash.');
  if (parsed.variant !== 'argon2id') {
    throw new Error(`ADMIN_PASSWORD_HASH uses ${parsed.variant}; only argon2id is supported.`);
  }

  const computed = await argon2id({
    password: candidate,
    salt: parsed.salt,
    parallelism: parsed.parallelism,
    iterations: parsed.iterations,
    memorySize: parsed.memorySize,
    hashLength: parsed.hash.length,
    outputType: 'binary',
  });

  const computedBuffer = Buffer.from(computed);
  if (computedBuffer.length !== parsed.hash.length) return false;
  return timingSafeEqual(computedBuffer, parsed.hash);
}
