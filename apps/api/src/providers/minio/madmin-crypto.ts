import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id } from 'hash-wasm';

/**
 * MinIO's madmin `EncryptData` / `DecryptData`, which wrap most Admin API v3
 * request and response bodies. Implemented from the upstream sources rather than
 * from documentation, because the framing is not documented anywhere:
 *
 * - `minio/madmin-go/encrypt.go` — the outer envelope and the KDF parameters.
 * - `secure-io/sio-go` (`sio.go`, `writer.go`, `reader.go`) — the chunked AEAD
 *   stream inside it.
 *
 * ## Envelope
 *
 * ```
 *   salt (32) | algorithm id (1) | nonce (8) | sio stream
 * ```
 *
 * The key is `argon2id(password, salt, t=1, m=64 MiB, p=4, len=32)`. The password
 * is the MinIO secret key. Algorithm id 0x00 is AES-256-GCM, 0x01 is
 * ChaCha20-Poly1305 (MinIO picks AES when the CPU has hardware support, so both
 * must be handled), 0x02 is PBKDF2+AES-GCM, which only FIPS builds emit.
 *
 * ## sio stream
 *
 * The plaintext is split into 16 KiB chunks. Each chunk is sealed on its own with
 *
 * - a 12-byte nonce: the envelope's 8-byte nonce followed by a little-endian
 *   uint32 chunk counter that **starts at 1**;
 * - 17 bytes of associated data: a flag byte — `0x00` for every chunk but the
 *   last, `0x80` for the last — followed by the 16-byte tag produced by sealing
 *   an *empty* plaintext under counter 0.
 *
 * The final chunk always exists and may be empty, so a stream is never just full
 * chunks. Both the flag and the counter are authenticated, which is what stops a
 * chunk being dropped, reordered or truncated.
 */

/* ------------------------------ constants ------------------------- */

export const MADMIN_SALT_BYTES = 32;
export const MADMIN_NONCE_BYTES = 8;
export const SIO_BUF_SIZE = 1 << 14; // sio.BufSize
export const AEAD_TAG_BYTES = 16;
const AEAD_NONCE_BYTES = 12;
const KEY_BYTES = 32;
const SIO_CHUNK_CIPHERTEXT_BYTES = SIO_BUF_SIZE + AEAD_TAG_BYTES;
const HEADER_BYTES = MADMIN_SALT_BYTES + 1 + MADMIN_NONCE_BYTES;

const FLAG_CHUNK = 0x00;
const FLAG_FINAL = 0x80;

/** argon2id parameters, fixed by madmin. */
const ARGON2 = { iterations: 1, memorySize: 64 * 1024, parallelism: 4 } as const;

export const MadminAlgorithm = {
  Argon2idAesGcm: 0x00,
  Argon2idChaCha20Poly1305: 0x01,
  Pbkdf2AesGcm: 0x02,
} as const;
export type MadminAlgorithmId = (typeof MadminAlgorithm)[keyof typeof MadminAlgorithm];

export class MadminCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MadminCryptoError';
  }
}

/* ------------------------------- helpers -------------------------- */

/**
 * Which AEAD an algorithm id selects. Kept as a narrow union rather than a
 * string so every `createCipheriv` call below resolves to one overload — Node's
 * GCM and ChaCha20-Poly1305 signatures take different option types.
 */
type AeadName = 'aes-256-gcm' | 'chacha20-poly1305';

const nodeCipherFor = (algorithm: number): AeadName => {
  if (algorithm === MadminAlgorithm.Argon2idAesGcm || algorithm === MadminAlgorithm.Pbkdf2AesGcm) {
    return 'aes-256-gcm';
  }
  if (algorithm === MadminAlgorithm.Argon2idChaCha20Poly1305) return 'chacha20-poly1305';
  throw new MadminCryptoError(`Unsupported madmin algorithm id 0x${algorithm.toString(16)}.`);
};

/** Branching on the literal is what lets TypeScript pick the right overload. */
function newCipher(name: AeadName, key: Buffer, nonce: Buffer) {
  return name === 'aes-256-gcm'
    ? createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AEAD_TAG_BYTES })
    : createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: AEAD_TAG_BYTES });
}

function newDecipher(name: AeadName, key: Buffer, nonce: Buffer) {
  return name === 'aes-256-gcm'
    ? createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: AEAD_TAG_BYTES })
    : createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: AEAD_TAG_BYTES });
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const key = await argon2id({
    password,
    salt,
    ...ARGON2,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });
  return Buffer.from(key);
}

/** envelope nonce (8) + little-endian uint32 counter = the AEAD's 12-byte nonce. */
function chunkNonce(streamNonce: Buffer, counter: number): Buffer {
  const nonce = Buffer.alloc(AEAD_NONCE_BYTES);
  streamNonce.copy(nonce, 0, 0, MADMIN_NONCE_BYTES);
  nonce.writeUInt32LE(counter >>> 0, MADMIN_NONCE_BYTES);
  return nonce;
}

function sealEmpty(cipherName: AeadName, key: Buffer, nonce: Buffer): Buffer {
  const cipher = newCipher(cipherName, key, nonce);
  cipher.final();
  return cipher.getAuthTag();
}

/**
 * The 17-byte associated data: flag byte, then the tag of an empty plaintext
 * sealed under counter 0. sio computes this once per stream and only flips the
 * flag, so both directions must derive it identically.
 */
function associatedData(
  cipherName: AeadName,
  key: Buffer,
  streamNonce: Buffer,
  final: boolean,
): Buffer {
  const tag = sealEmpty(cipherName, key, chunkNonce(streamNonce, 0));
  return Buffer.concat([Buffer.from([final ? FLAG_FINAL : FLAG_CHUNK]), tag]);
}

function sealChunk(
  cipherName: AeadName,
  key: Buffer,
  nonce: Buffer,
  aad: Buffer,
  plaintext: Buffer,
): Buffer {
  const cipher = newCipher(cipherName, key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

function openChunk(
  cipherName: AeadName,
  key: Buffer,
  nonce: Buffer,
  aad: Buffer,
  chunk: Buffer,
): Buffer {
  if (chunk.length < AEAD_TAG_BYTES) {
    throw new MadminCryptoError('Truncated madmin chunk.');
  }
  const body = chunk.subarray(0, chunk.length - AEAD_TAG_BYTES);
  const tag = chunk.subarray(chunk.length - AEAD_TAG_BYTES);

  const decipher = newDecipher(cipherName, key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // A tag mismatch means the wrong secret key or a modified body. The original
    // OpenSSL message says nothing useful and nothing safe.
    throw new MadminCryptoError(
      'madmin payload is not authentic: wrong secret key, or the response was altered.',
    );
  }
}

/* ------------------------------ public API ------------------------ */

/** Matches madmin's `IsEncrypted`: a long-enough body whose byte 32 is a known id. */
export function isMadminEncrypted(data: Buffer): boolean {
  if (data.length <= MADMIN_SALT_BYTES) return false;
  const id = data[MADMIN_SALT_BYTES];
  return (
    id === MadminAlgorithm.Argon2idAesGcm ||
    id === MadminAlgorithm.Argon2idChaCha20Poly1305 ||
    id === MadminAlgorithm.Pbkdf2AesGcm
  );
}

export interface EncryptOptions {
  /** Force an algorithm. Defaults to AES-256-GCM, which is what MinIO emits. */
  readonly algorithm?: MadminAlgorithmId;
  /** Fixed salt and nonce, for a deterministic test vector. */
  readonly salt?: Buffer;
  readonly nonce?: Buffer;
}

/** madmin `EncryptData`. Used for request bodies MinIO expects encrypted. */
export async function madminEncrypt(
  password: string,
  plaintext: Buffer,
  options: EncryptOptions = {},
): Promise<Buffer> {
  const algorithm = options.algorithm ?? MadminAlgorithm.Argon2idAesGcm;
  if (algorithm === MadminAlgorithm.Pbkdf2AesGcm) {
    throw new MadminCryptoError('Encrypting with the FIPS (PBKDF2) profile is not supported.');
  }

  const salt = options.salt ?? randomBytes(MADMIN_SALT_BYTES);
  if (salt.length !== MADMIN_SALT_BYTES) {
    throw new MadminCryptoError(`Salt must be ${MADMIN_SALT_BYTES} bytes.`);
  }
  const nonce = options.nonce ?? randomBytes(MADMIN_NONCE_BYTES);
  if (nonce.length !== MADMIN_NONCE_BYTES) {
    throw new MadminCryptoError(`Nonce must be ${MADMIN_NONCE_BYTES} bytes.`);
  }

  const cipherName = nodeCipherFor(algorithm);
  const key = await deriveKey(password, salt);
  const chunkAad = associatedData(cipherName, key, nonce, false);
  const finalAad = associatedData(cipherName, key, nonce, true);

  const parts: Buffer[] = [salt, Buffer.from([algorithm]), nonce];

  // sio's writer only emits a full chunk once it has MORE than bufSize pending,
  // so a plaintext that is an exact multiple of bufSize ends as one final chunk.
  let counter = 1;
  let offset = 0;
  while (plaintext.length - offset > SIO_BUF_SIZE) {
    const slice = plaintext.subarray(offset, offset + SIO_BUF_SIZE);
    parts.push(sealChunk(cipherName, key, chunkNonce(nonce, counter), chunkAad, slice));
    offset += SIO_BUF_SIZE;
    counter += 1;
  }

  const tail = plaintext.subarray(offset);
  parts.push(sealChunk(cipherName, key, chunkNonce(nonce, counter), finalAad, tail));

  return Buffer.concat(parts);
}

/** madmin `DecryptData`. Used for every encrypted Admin API response body. */
export async function madminDecrypt(password: string, data: Buffer): Promise<Buffer> {
  if (data.length < HEADER_BYTES) {
    throw new MadminCryptoError('madmin payload is shorter than its header.');
  }

  const salt = data.subarray(0, MADMIN_SALT_BYTES);
  const algorithm = data[MADMIN_SALT_BYTES] ?? -1;
  const nonce = data.subarray(MADMIN_SALT_BYTES + 1, HEADER_BYTES);

  if (algorithm === MadminAlgorithm.Pbkdf2AesGcm) {
    throw new MadminCryptoError(
      'This MinIO is a FIPS build (PBKDF2 envelope), which storage-io does not decrypt.',
    );
  }

  const cipherName = nodeCipherFor(algorithm);
  const key = await deriveKey(password, Buffer.from(salt));
  const streamNonce = Buffer.from(nonce);
  const chunkAad = associatedData(cipherName, key, streamNonce, false);
  const finalAad = associatedData(cipherName, key, streamNonce, true);

  const plaintext: Buffer[] = [];
  let offset = HEADER_BYTES;
  let counter = 1;

  for (;;) {
    const remaining = data.length - offset;
    // The stream always ends in a final chunk, so anything longer than one full
    // ciphertext chunk must be a non-final chunk.
    const isFinal = remaining <= SIO_CHUNK_CIPHERTEXT_BYTES;
    const size = isFinal ? remaining : SIO_CHUNK_CIPHERTEXT_BYTES;
    const chunk = data.subarray(offset, offset + size);

    plaintext.push(
      openChunk(
        cipherName,
        key,
        chunkNonce(streamNonce, counter),
        isFinal ? finalAad : chunkAad,
        chunk,
      ),
    );

    offset += size;
    counter += 1;
    if (isFinal) break;
  }

  return Buffer.concat(plaintext);
}

/** Exposed for the round-trip test, which asserts the derivation itself. */
export async function madminDeriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return deriveKey(password, salt);
}

/** Constant-time buffer comparison, for tests that check a derived key. */
export function buffersEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
