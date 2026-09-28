import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  type ScryptOptions,
} from 'node:crypto';
import { z } from 'zod';
import { serverOptionsSchema, settingsSchema } from '@storage-io/contracts';

/**
 * The encrypted configuration archive behind `POST /settings/export` and
 * `POST /settings/import`.
 *
 * ## Why a passphrase and not `APP_SECRET`
 *
 * The archive's whole purpose is to survive the machine: it is what an operator
 * restores onto a new host, and `APP_SECRET` is exactly the thing that will be
 * different there. So the key comes from a passphrase the operator supplies on
 * both sides, and the file is readable with nothing but that passphrase.
 *
 * ## The envelope
 *
 * ```
 * magic (8)  "SIOCFG\0" + version byte
 * salt (32)  scrypt salt, fresh per export
 * nonce (12) AES-GCM nonce, fresh per export
 * body       AES-256-GCM ciphertext ‖ 16-byte tag
 * ```
 *
 * The magic and version are **additional authenticated data**, not just a prefix:
 * a file whose header was edited to claim a different version fails the tag check
 * rather than being parsed as that version.
 *
 * scrypt with `N = 2^15, r = 8, p = 1` — about 32 MiB and a tenth of a second,
 * which is the point. `maxmem` is passed explicitly because Node's default is
 * 32 MiB and these parameters sit exactly at it; relying on the default makes the
 * call throw on some releases and not others.
 *
 * ## What is inside
 *
 * The whole settings document **including its secrets**, and every server
 * connection **including its secret access key and admin token**. That is what
 * makes the archive a restore rather than a checklist — and why it is encrypted and
 * why the passphrase has a minimum length in the contract.
 */

const MAGIC = Buffer.from('SIOCFG\0', 'ascii');
const ARCHIVE_VERSION = 1;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const CIPHER = 'aes-256-gcm';

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES;
/** A 10 MiB ceiling: the archive is a few kilobytes even with fifty servers. */
export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;

/**
 * `promisify(scrypt)` types the 4-argument overload away, so the options object
 * cannot be passed. Wrapping it keeps the explicit `maxmem` — which is the whole
 * reason these parameters are safe to use.
 */
const scryptAsync = (
  passphrase: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(passphrase, salt, keylen, options, (error, key) => {
      if (error !== null) reject(error);
      else resolve(key);
    });
  });

/* ------------------------------- the payload ---------------------- */

/**
 * One saved connection, with its credentials in the clear inside the encrypted
 * body. `name` is the identity across installations — an id would be meaningless
 * on the machine the archive is restored onto.
 */
export const archivedServerSchema = z.object({
  name: z.string().min(1).max(63),
  provider: z.string().min(1).max(32),
  endpoint: z.string().min(1).max(2048),
  region: z.string().min(1).max(64),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().max(1024),
  adminToken: z.string().max(4096).nullable(),
  options: serverOptionsSchema,
  maintenance: z.boolean(),
});
export type ArchivedServer = z.infer<typeof archivedServerSchema>;

export const configArchiveSchema = z.object({
  version: z.literal(ARCHIVE_VERSION),
  exportedAt: z.string(),
  /** Which storage-io wrote it, for a support question later. */
  appVersion: z.string(),
  settings: settingsSchema,
  servers: z.array(archivedServerSchema),
});
export type ConfigArchive = z.infer<typeof configArchiveSchema>;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/* ------------------------------- encrypting ----------------------- */

export async function encryptArchive(archive: ConfigArchive, passphrase: string): Promise<Buffer> {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveKey(passphrase, salt);

  const header = Buffer.concat([MAGIC, Buffer.from([ARCHIVE_VERSION]), salt, nonce]);
  const cipher = createCipheriv(CIPHER, key, nonce);
  // The header is authenticated but not encrypted: it has to be readable to find
  // the salt, and authenticating it is what stops it being rewritten.
  cipher.setAAD(header.subarray(0, MAGIC.length + 1));

  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(archive), 'utf8')),
    cipher.final(),
  ]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

/* ------------------------------- decrypting ----------------------- */

/**
 * The inverse. Every failure — a file that is not an archive, a wrong passphrase, a
 * truncated body, a payload that no longer validates — comes back as
 * `ArchiveError` with a sentence an operator can act on and nothing an attacker can
 * use to tell one failure from another beyond what they already know.
 */
export async function decryptArchive(file: Buffer, passphrase: string): Promise<ConfigArchive> {
  if (file.length > MAX_ARCHIVE_BYTES) {
    throw new ArchiveError('That file is too large to be a storage-io configuration archive.');
  }
  if (file.length <= HEADER_BYTES + TAG_BYTES) {
    throw new ArchiveError('That file is not a storage-io configuration archive.');
  }
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ArchiveError('That file is not a storage-io configuration archive.');
  }

  const version = file[MAGIC.length];
  if (version !== ARCHIVE_VERSION) {
    throw new ArchiveError(
      `That archive says version ${String(version)}; this storage-io reads version ${ARCHIVE_VERSION}.`,
    );
  }

  const saltStart = MAGIC.length + 1;
  const salt = file.subarray(saltStart, saltStart + SALT_BYTES);
  const nonce = file.subarray(saltStart + SALT_BYTES, HEADER_BYTES);
  const tag = file.subarray(file.length - TAG_BYTES);
  const body = file.subarray(HEADER_BYTES, file.length - TAG_BYTES);

  const key = await deriveKey(passphrase, salt);
  const decipher = createDecipheriv(CIPHER, key, nonce);
  decipher.setAAD(file.subarray(0, MAGIC.length + 1));
  decipher.setAuthTag(tag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // A wrong passphrase and a tampered file are indistinguishable here, and
    // saying so is correct: GCM cannot tell them apart either.
    throw new ArchiveError('Wrong passphrase, or the archive has been altered.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new ArchiveError('The archive decrypted but its contents are not readable.');
  }

  const validated = configArchiveSchema.safeParse(parsed);
  if (!validated.success) {
    const where = validated.error.issues
      .slice(0, 3)
      .map((issue) => issue.path.join('.'))
      .join(', ');
    throw new ArchiveError(`The archive's contents are not valid (${where}).`);
  }
  return validated.data;
}

/* ------------------------------- helpers -------------------------- */

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  // NFKC so a passphrase typed with a different Unicode normalisation on the
  // restoring machine still derives the same key.
  const normalized = passphrase.normalize('NFKC');
  return scryptAsync(normalized, salt, KEY_BYTES, SCRYPT);
}

export { ARCHIVE_VERSION };
