import { describe, expect, it } from 'vitest';
import { SERVER_OPTION_DEFAULTS, SETTINGS_DEFAULTS } from '@storage-io/contracts';
import {
  ARCHIVE_VERSION,
  ArchiveError,
  decryptArchive,
  encryptArchive,
  type ConfigArchive,
} from '../../src/modules/config-backup/config-archive';

/**
 * The configuration archive's envelope.
 *
 * This is the one file storage-io produces that is meant to leave the machine with
 * every credential the installation holds in it, so the properties worth proving
 * are the negative ones: a wrong passphrase does not decrypt, an edited header does
 * not decrypt, and neither failure says anything useful about which it was.
 */

const archive: ConfigArchive = {
  version: 1,
  exportedAt: '2026-03-15T10:00:00.000Z',
  appVersion: '0.1.0',
  settings: {
    ...SETTINGS_DEFAULTS,
    notifications: {
      ...SETTINGS_DEFAULTS.notifications,
      email: { ...SETTINGS_DEFAULTS.notifications.email, password: 'smtp-secret' },
    },
  },
  servers: [
    {
      name: 'minio-lab',
      provider: 'minio',
      endpoint: 'http://minio.internal:9000',
      region: 'us-east-1',
      accessKeyId: 'AKIA-LAB',
      secretAccessKey: 'the-secret-access-key',
      adminToken: null,
      options: { ...SERVER_OPTION_DEFAULTS, pathStyle: true },
      maintenance: false,
    },
  ],
};

const PASSPHRASE = 'a-long-enough-passphrase';

describe('config archive', () => {
  it('round-trips the whole document including its secrets', async () => {
    const file = await encryptArchive(archive, PASSPHRASE);
    const restored = await decryptArchive(file, PASSPHRASE);

    expect(restored).toEqual(archive);
    // The point of the archive: the credentials come back.
    expect(restored.servers[0]?.secretAccessKey).toBe('the-secret-access-key');
    expect(restored.settings.notifications.email.password).toBe('smtp-secret');
  });

  it('produces a different file every time, for the same input', async () => {
    const first = await encryptArchive(archive, PASSPHRASE);
    const second = await encryptArchive(archive, PASSPHRASE);
    // Fresh salt and nonce per export: two identical exports must not be
    // byte-identical, or the salt is not doing its job.
    expect(first.equals(second)).toBe(false);
  });

  it('never leaves a credential readable in the file', async () => {
    const file = await encryptArchive(archive, PASSPHRASE);
    const raw = file.toString('latin1');
    expect(raw).not.toContain('the-secret-access-key');
    expect(raw).not.toContain('smtp-secret');
    expect(raw).not.toContain('minio-lab');
  });

  it('refuses a wrong passphrase', async () => {
    const file = await encryptArchive(archive, PASSPHRASE);
    await expect(decryptArchive(file, 'not-the-passphrase')).rejects.toThrow(ArchiveError);
    await expect(decryptArchive(file, 'not-the-passphrase')).rejects.toThrow(/Wrong passphrase/);
  });

  it('refuses a file whose ciphertext was edited', async () => {
    const file = await encryptArchive(archive, PASSPHRASE);
    const tampered = Buffer.from(file);
    // Somewhere inside the body, well past the header.
    const offset = tampered.length - 40;
    tampered.writeUInt8(tampered.readUInt8(offset) ^ 0xff, offset);
    await expect(decryptArchive(tampered, PASSPHRASE)).rejects.toThrow(/Wrong passphrase/);
  });

  it('refuses a file whose version byte was edited, because the header is authenticated', async () => {
    const file = await encryptArchive(archive, PASSPHRASE);
    const tampered = Buffer.from(file);
    // The magic is 7 bytes, so index 7 is the version.
    tampered[7] = ARCHIVE_VERSION + 1;
    await expect(decryptArchive(tampered, PASSPHRASE)).rejects.toThrow(/version/);
  });

  it('refuses a file that is not an archive at all', async () => {
    await expect(
      decryptArchive(Buffer.from('hello world, at some length'), PASSPHRASE),
    ).rejects.toThrow(/not a storage-io configuration archive/);
  });

  it('refuses a truncated archive', async () => {
    const file = await encryptArchive(archive, PASSPHRASE);
    await expect(decryptArchive(file.subarray(0, 20), PASSPHRASE)).rejects.toThrow(ArchiveError);
  });

  it('refuses a payload that decrypts but no longer validates', async () => {
    const broken = { ...archive, settings: { nonsense: true } } as unknown as ConfigArchive;
    const file = await encryptArchive(broken, PASSPHRASE);
    await expect(decryptArchive(file, PASSPHRASE)).rejects.toThrow(/not valid/);
  });

  it('derives the same key from a differently normalised passphrase', async () => {
    // "é" as one code point and as "e" + combining acute are the same passphrase to
    // an operator typing it on a different machine.
    const composed = 'passphrase-é-x';
    const decomposed = 'passphrase-é-x';
    const file = await encryptArchive(archive, composed);
    await expect(decryptArchive(file, decomposed)).resolves.toMatchObject({ version: 1 });
  });
});
