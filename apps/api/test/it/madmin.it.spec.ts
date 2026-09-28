import { createHash, randomBytes } from 'node:crypto';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MadminAlgorithm,
  SIO_BUF_SIZE,
  isMadminEncrypted,
  madminDecrypt,
  madminEncrypt,
} from '../../src/providers/minio/madmin-crypto';
import { IT_ENABLED, MINIO, assertContainersUp } from './containers';

/**
 * The madmin envelope against a real MinIO.
 *
 * A unit round trip only proves the implementation agrees with itself. These
 * tests prove it agrees with MinIO, in both directions:
 *
 * - **decrypt**: `list-users` answers a madmin envelope that MinIO produced, and
 *   it has to come out as the JSON MinIO meant.
 * - **encrypt**: `add-user` takes a madmin envelope that *we* produced, and MinIO
 *   has to be able to open it — which is only provable by MinIO acting on it.
 *
 * Together they pin the framing, the argon2id parameters, the chunk counter's
 * start value and the associated-data flag byte. Getting any of them wrong makes
 * one direction or the other fail.
 */
describe.skipIf(!IT_ENABLED)('madmin against live MinIO', () => {
  const probeUser = `sio-it-${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    await assertContainersUp();
  });

  afterAll(async () => {
    // Leave the container as it was found.
    await adminRequest(`/remove-user`, { method: 'DELETE', query: { accessKey: probeUser } }).catch(
      () => undefined,
    );
  });

  it('signs an admin request MinIO accepts (SigV4, service s3)', async () => {
    const response = await adminRequest('/info');
    expect(response.status).toBe(200);

    const info = JSON.parse(response.raw.toString('utf8')) as {
      mode?: string;
      servers?: { version?: string; endpoint?: string; drives?: unknown[] }[];
    };
    expect(info.mode).toBe('online');
    expect(info.servers?.[0]?.version).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(info.servers?.[0]?.drives?.length).toBeGreaterThan(0);
  });

  it('DECRYPTS the list-users response MinIO produced', async () => {
    const response = await adminRequest('/list-users');
    expect(response.status).toBe(200);

    // This is the load-bearing assertion: MinIO chose the algorithm, the salt and
    // the nonce, so a decrypt that works here cannot be self-consistency.
    expect(isMadminEncrypted(response.raw)).toBe(true);
    const algorithmId = response.raw[32];
    expect([MadminAlgorithm.Argon2idAesGcm, MadminAlgorithm.Argon2idChaCha20Poly1305]).toContain(
      algorithmId,
    );

    const plaintext = await madminDecrypt(MINIO.secretAccessKey, response.raw);
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
  });

  it('refuses to decrypt a MinIO payload with the wrong secret key', async () => {
    const response = await adminRequest('/list-users');
    await expect(madminDecrypt('not-the-secret-key', response.raw)).rejects.toThrow(
      /not authentic/,
    );
  });

  it('ENCRYPTS a body MinIO can open — add-user, then read the user back', async () => {
    const body = Buffer.from(
      JSON.stringify({ secretKey: 'sio-it-user-secret-123', status: 'enabled' }),
      'utf8',
    );
    const sealed = await madminEncrypt(MINIO.secretAccessKey, body);

    const added = await adminRequest('/add-user', {
      method: 'PUT',
      query: { accessKey: probeUser },
      body: sealed,
    });
    // A 200 here means MinIO derived the same key and opened our envelope.
    expect(added.status).toBe(200);

    const listed = await adminRequest('/list-users');
    const users = JSON.parse(
      (await madminDecrypt(MINIO.secretAccessKey, listed.raw)).toString('utf8'),
    ) as Record<string, { status?: string }>;

    expect(Object.keys(users)).toContain(probeUser);
    expect(users[probeUser]?.status).toBe('enabled');
  });

  it('round-trips a payload larger than one sio chunk through MinIO', async () => {
    // A single-chunk payload would never exercise the chunk counter, which is the
    // part of the format most easily got wrong.
    const user = `${probeUser}-big`;
    const padding = 'x'.repeat(SIO_BUF_SIZE + 1000);
    const body = Buffer.from(
      JSON.stringify({ secretKey: 'sio-it-user-secret-456', status: 'enabled', note: padding }),
      'utf8',
    );
    expect(body.length).toBeGreaterThan(SIO_BUF_SIZE);

    const sealed = await madminEncrypt(MINIO.secretAccessKey, body);
    const added = await adminRequest('/add-user', {
      method: 'PUT',
      query: { accessKey: user },
      body: sealed,
    });
    expect(added.status).toBe(200);

    await adminRequest('/remove-user', { method: 'DELETE', query: { accessKey: user } });
  });

  it('exposes the data-usage endpoint the usage sub-driver reads', async () => {
    const response = await adminRequest('/datausageinfo');
    expect(response.status).toBe(200);

    const raw = isMadminEncrypted(response.raw)
      ? await madminDecrypt(MINIO.secretAccessKey, response.raw)
      : response.raw;
    const usage = JSON.parse(raw.toString('utf8')) as { bucketsCount?: number };
    expect(typeof usage.bucketsCount === 'number' || usage.bucketsCount === undefined).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * A deliberately independent signer.
 *
 * These tests sign with @smithy/signature-v4 directly rather than through
 * MinioAdminClient, so a bug in the client cannot make a crypto test pass. The
 * client's own behaviour is covered by the servers integration spec.
 * ------------------------------------------------------------------ */

interface AdminResult {
  readonly status: number;
  readonly raw: Buffer;
}

async function adminRequest(
  path: string,
  options: {
    readonly method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
    readonly query?: Record<string, string>;
    readonly body?: Buffer;
  } = {},
): Promise<AdminResult> {
  const url = new URL(MINIO.endpoint);
  const method = options.method ?? 'GET';
  const query = options.query ?? {};
  const payload = options.body ?? Buffer.alloc(0);
  const fullPath = `/minio/admin/v3${path}`;

  const signer = new SignatureV4({
    service: 's3',
    region: MINIO.region,
    credentials: {
      accessKeyId: MINIO.accessKeyId,
      secretAccessKey: MINIO.secretAccessKey,
    },
    sha256: Sha256,
    uriEscapePath: false,
    applyChecksum: true,
  });

  const headers: Record<string, string> = {
    host: url.port.length > 0 ? `${url.hostname}:${url.port}` : url.hostname,
    'x-amz-content-sha256': createHash('sha256').update(payload).digest('hex'),
  };
  if (payload.length > 0) headers['content-length'] = String(payload.length);

  const signed = await signer.sign(
    new HttpRequest({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port.length > 0 ? Number(url.port) : undefined,
      path: fullPath,
      query,
      headers,
      body: payload.length > 0 ? payload : undefined,
    }),
  );

  const search = new URLSearchParams(query).toString();
  const target = `${url.origin}${fullPath}${search.length > 0 ? `?${search}` : ''}`;

  const response = await fetch(target, {
    method,
    headers: signed.headers as Record<string, string>,
    body: payload.length > 0 ? new Uint8Array(payload) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  return { status: response.status, raw: Buffer.from(await response.arrayBuffer()) };
}
