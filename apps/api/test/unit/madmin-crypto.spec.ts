import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MadminAlgorithm,
  MadminCryptoError,
  SIO_BUF_SIZE,
  isMadminEncrypted,
  madminDecrypt,
  madminEncrypt,
} from '../../src/providers/minio/madmin-crypto';

const PASSWORD = 'sio-dev-secret-key';

/**
 * The chunk boundaries are where a stream format goes wrong, so they are the
 * sizes worth naming: sio only emits a full chunk once it has *more* than
 * `BufSize` pending, which means an exact multiple ends as one final chunk, not
 * a full chunk plus an empty final one.
 */
const BOUNDARY_SIZES = [
  0,
  1,
  SIO_BUF_SIZE - 1,
  SIO_BUF_SIZE,
  SIO_BUF_SIZE + 1,
  2 * SIO_BUF_SIZE,
  2 * SIO_BUF_SIZE + 1,
  3 * SIO_BUF_SIZE - 7,
] as const;

describe('madmin envelope', () => {
  it('round-trips across every chunk boundary, with AES-256-GCM', async () => {
    for (const size of BOUNDARY_SIZES) {
      const plaintext = randomBytes(size);
      const sealed = await madminEncrypt(PASSWORD, plaintext, {
        algorithm: MadminAlgorithm.Argon2idAesGcm,
      });
      const opened = await madminDecrypt(PASSWORD, sealed);
      expect(opened.equals(plaintext), `size ${size}`).toBe(true);
    }
  });

  it('round-trips across every chunk boundary, with ChaCha20-Poly1305', async () => {
    // MinIO picks ChaCha20 on a CPU without AES acceleration, so both have to work.
    for (const size of BOUNDARY_SIZES) {
      const plaintext = randomBytes(size);
      const sealed = await madminEncrypt(PASSWORD, plaintext, {
        algorithm: MadminAlgorithm.Argon2idChaCha20Poly1305,
      });
      const opened = await madminDecrypt(PASSWORD, sealed);
      expect(opened.equals(plaintext), `size ${size}`).toBe(true);
    }
  });

  it('lays out the header as salt(32) | algorithm(1) | nonce(8)', async () => {
    const salt = Buffer.alloc(32, 0xa5);
    const nonce = Buffer.alloc(8, 0x5a);
    const sealed = await madminEncrypt(PASSWORD, Buffer.from('hello'), { salt, nonce });

    expect(sealed.subarray(0, 32).equals(salt)).toBe(true);
    expect(sealed[32]).toBe(MadminAlgorithm.Argon2idAesGcm);
    expect(sealed.subarray(33, 41).equals(nonce)).toBe(true);
    // 41-byte header + 5 bytes of plaintext + a 16-byte tag.
    expect(sealed.length).toBe(41 + 5 + 16);
  });

  it('adds exactly one tag per chunk', async () => {
    const oneChunk = await madminEncrypt(PASSWORD, randomBytes(SIO_BUF_SIZE));
    expect(oneChunk.length).toBe(41 + SIO_BUF_SIZE + 16);

    const twoChunks = await madminEncrypt(PASSWORD, randomBytes(SIO_BUF_SIZE + 1));
    expect(twoChunks.length).toBe(41 + SIO_BUF_SIZE + 16 + 1 + 16);
  });

  it('is deterministic given the same salt and nonce', async () => {
    const salt = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(8, 9);
    const plaintext = Buffer.from('{"probe-user":{"status":"enabled"}}');

    const first = await madminEncrypt(PASSWORD, plaintext, { salt, nonce });
    const second = await madminEncrypt(PASSWORD, plaintext, { salt, nonce });
    expect(first.equals(second)).toBe(true);
  });

  it('uses a fresh salt and nonce when none is given', async () => {
    const plaintext = Buffer.from('same');
    const first = await madminEncrypt(PASSWORD, plaintext);
    const second = await madminEncrypt(PASSWORD, plaintext);
    expect(first.equals(second)).toBe(false);
  });

  it('refuses the wrong password', async () => {
    const sealed = await madminEncrypt(PASSWORD, Buffer.from('secret payload'));
    await expect(madminDecrypt('wrong-secret-key', sealed)).rejects.toThrow(MadminCryptoError);
  });

  it('refuses a flipped byte anywhere in the ciphertext', async () => {
    const sealed = await madminEncrypt(PASSWORD, randomBytes(200));
    for (const index of [41, 100, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[index] = (tampered[index] as number) ^ 0xff;
      await expect(madminDecrypt(PASSWORD, tampered), `byte ${index}`).rejects.toThrow(
        MadminCryptoError,
      );
    }
  });

  it('refuses a truncated stream', async () => {
    const sealed = await madminEncrypt(PASSWORD, randomBytes(SIO_BUF_SIZE + 50));
    await expect(madminDecrypt(PASSWORD, sealed.subarray(0, sealed.length - 4))).rejects.toThrow(
      MadminCryptoError,
    );
  });

  it('refuses a chunk swap — the counter is authenticated', async () => {
    const plaintext = randomBytes(2 * SIO_BUF_SIZE + 10);
    const sealed = await madminEncrypt(PASSWORD, plaintext);

    const header = sealed.subarray(0, 41);
    const chunkLength = SIO_BUF_SIZE + 16;
    const first = sealed.subarray(41, 41 + chunkLength);
    const second = sealed.subarray(41 + chunkLength, 41 + 2 * chunkLength);
    const tail = sealed.subarray(41 + 2 * chunkLength);

    const swapped = Buffer.concat([header, second, first, tail]);
    await expect(madminDecrypt(PASSWORD, swapped)).rejects.toThrow(MadminCryptoError);
  });

  it('refuses a header shorter than 41 bytes', async () => {
    await expect(madminDecrypt(PASSWORD, Buffer.alloc(10))).rejects.toThrow(MadminCryptoError);
  });

  it('says so plainly for a FIPS (PBKDF2) envelope it cannot read', async () => {
    const fips = Buffer.concat([
      Buffer.alloc(32, 1),
      Buffer.from([MadminAlgorithm.Pbkdf2AesGcm]),
      Buffer.alloc(8, 2),
      Buffer.alloc(16, 3),
    ]);
    await expect(madminDecrypt(PASSWORD, fips)).rejects.toThrow(/FIPS/);
    await expect(
      madminEncrypt(PASSWORD, Buffer.from('x'), { algorithm: MadminAlgorithm.Pbkdf2AesGcm }),
    ).rejects.toThrow(/FIPS/);
  });

  it('rejects a salt or nonce of the wrong length', async () => {
    await expect(
      madminEncrypt(PASSWORD, Buffer.from('x'), { salt: Buffer.alloc(16) }),
    ).rejects.toThrow(/32 bytes/);
    await expect(
      madminEncrypt(PASSWORD, Buffer.from('x'), { nonce: Buffer.alloc(12) }),
    ).rejects.toThrow(/8 bytes/);
  });
});

describe('isMadminEncrypted', () => {
  it('recognises what madminEncrypt produced', async () => {
    const sealed = await madminEncrypt(PASSWORD, Buffer.from('{}'));
    expect(isMadminEncrypted(sealed)).toBe(true);
  });

  it('does not mistake plain JSON for an envelope', () => {
    const json = Buffer.from(JSON.stringify({ mode: 'online', servers: [{ endpoint: 'a' }] }));
    expect(json.length).toBeGreaterThan(32);
    expect(isMadminEncrypted(json)).toBe(false);
  });

  it('is false for anything too short to hold a header', () => {
    expect(isMadminEncrypted(Buffer.alloc(0))).toBe(false);
    expect(isMadminEncrypted(Buffer.alloc(32))).toBe(false);
  });

  it('is false for an unknown algorithm byte', () => {
    const unknown = Buffer.concat([Buffer.alloc(32, 1), Buffer.from([0x7f]), Buffer.alloc(24)]);
    expect(isMadminEncrypted(unknown)).toBe(false);
  });
});
