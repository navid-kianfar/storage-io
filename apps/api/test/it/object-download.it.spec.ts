import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createTestApp, type TestHarness } from '../support/test-app';
import { IT_ENABLED, MINIO, assertContainersUp } from './containers';

/**
 * What a browser actually receives, and what a move does when the delete is
 * refused — both against a real MinIO, because both used to be asserted only
 * against what the code did rather than what came back.
 *
 * The XSS case is the important one: MinIO stores and returns the `Content-Type`
 * it was given, so an object uploaded as `text/html` came back as renderable HTML
 * on the console's own origin, with the console's session cookie attached.
 */

const HTML_BODY = '<script>document.title = "pwned"</script><p>hello</p>';

/**
 * A MinIO session policy that allows everything a move needs except the delete.
 *
 * Object lock is the obvious way to make a delete fail and it does not work here:
 * on a versioned bucket a delete with no version id writes a *delete marker*,
 * which retention permits, so the call succeeds and the move looks fine. A
 * credential that is simply not allowed to delete is the honest reproduction of
 * "the copy landed and the original could not be removed".
 */
const NO_DELETE_POLICY = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Action: ['s3:*'], Resource: ['arn:aws:s3:::*', 'arn:aws:s3:::*/*'] },
    {
      Effect: 'Deny',
      Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      Resource: ['arn:aws:s3:::*/*'],
    },
  ],
} as const;

describe.skipIf(!IT_ENABLED)('object responses against live containers', () => {
  let harness: TestHarness;
  let cookie: string;

  const run = Date.now().toString(36);
  const bucket = `sio-it-dl-${run}`;
  const createdBuckets: string[] = [];
  /** The same MinIO, reached with a credential that may not delete. */
  const readOnlyDeleteServer = `it-minio-nodelete-${run}`;
  const restrictedUser = `sio-it-nodel-${run}`;
  let restrictedKeyId: string | null = null;

  beforeAll(async () => {
    await assertContainersUp();
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();

    await harness
      .http()
      .post('/api/v1/servers')
      .set(auth())
      .send({
        name: MINIO.name,
        provider: MINIO.provider,
        endpoint: MINIO.endpoint,
        region: MINIO.region,
        accessKeyId: MINIO.accessKeyId,
        secretAccessKey: MINIO.secretAccessKey,
        options: { pathStyle: true, healthIntervalSec: 3600 },
      })
      .expect(201);

    await createBucket(bucket, {});
    await seed();
    await addRestrictedServer();
  }, 180_000);

  afterAll(async () => {
    if (restrictedKeyId !== null) {
      await harness
        .http()
        .delete(`/api/v1/servers/${MINIO.name}/iam/access-keys/${restrictedKeyId}`)
        .set(auth());
    }
    await harness
      .http()
      .delete(`/api/v1/servers/${MINIO.name}/iam/users/${restrictedUser}`)
      .set(auth());
    await harness.http().delete(`/api/v1/servers/${readOnlyDeleteServer}`).set(auth());

    for (const name of [...createdBuckets].reverse()) {
      const response = await harness
        .http()
        .delete(`/api/v1/servers/${MINIO.name}/buckets/${name}?force=true`)
        .set(auth());
      if (response.status !== 204) await forceCleanup(name);
    }
    await harness.close();
  }, 180_000);

  const auth = (): Record<string, string> => ({ Cookie: cookie, Origin: harness.origin });

  const download = (key: string, inline: boolean) =>
    harness
      .http()
      .get(
        `/api/v1/servers/${MINIO.name}/buckets/${bucket}/objects/download?key=${encodeURIComponent(key)}&inline=${String(inline)}`,
      )
      .set('Cookie', cookie);

  /* ------------------------- what comes back ------------------------ */

  it('never hands back stored HTML as HTML, even for inline=true', async () => {
    const response = await download('evil.html', true).expect(200);

    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['content-disposition']).toContain('inline');
    // The bytes are unchanged — it is a preview of the source, not a sanitiser.
    expect(response.text).toContain('<script>');
  }, 60_000);

  it('hands back an SVG as an octet-stream attachment', async () => {
    const response = await download('logo.svg', true).expect(200);

    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toContain('attachment');
  }, 60_000);

  it('hands back JavaScript and XML as attachments too', async () => {
    for (const key of ['app.js', 'feed.xml']) {
      const response = await download(key, true).expect(200);
      expect(response.headers['content-type']).toBe('application/octet-stream');
      expect(response.headers['content-disposition']).toContain('attachment');
    }
  }, 60_000);

  it('still renders an image and a PDF inline', async () => {
    const image = await download('pixel.png', true).expect(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['content-disposition']).toContain('inline');

    const pdf = await download('doc.pdf', true).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('inline');
  }, 60_000);

  it('sends nosniff and a document policy that can load nothing', async () => {
    const response = await download('evil.html', true).expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const policy = response.headers['content-security-policy'] ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain('sandbox');
    // And it is not the loose app-wide policy, which allows 'self' scripts.
    expect(policy).not.toContain("script-src 'self'");
  }, 60_000);

  it('sends the same headers on a ZIP', async () => {
    const response = await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/buckets/${bucket}/objects/download-zip`)
      .set(auth())
      .send({ keys: ['evil.html', 'pixel.png'], prefixes: [] })
      .expect(201);

    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  }, 60_000);

  /**
   * A ZIP starts piping the archive to the response before it knows every object
   * can be read, so a `GetObject` that fails partway tears the response down and
   * the pipeline rejects. Left unobserved that rejection is an unhandled promise
   * rejection, and Node ends the process — the whole API, for one bad key in one
   * selection. These two cases are that, from both sides of the first write.
   */
  /**
   * The archive is already piping to the response when the objects are read, so a
   * `GetObject` that fails partway can only end as a torn-down connection: the
   * status and headers are gone and there is no problem+json left to send. That
   * is the documented behaviour of every streamed response here and it is not
   * what these cases are about.
   *
   * What they are about is that the run must not take the API with it. The
   * pipeline promise rejects when the response is destroyed, and while it was
   * left unawaited that rejection was an unhandled promise rejection — which
   * ends the Node process. One unreadable key in one selection, and every
   * operator logged out.
   */
  const failingZip = (keys: readonly string[]): Promise<unknown> =>
    harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/buckets/${bucket}/objects/download-zip`)
      .set(auth())
      .send({ keys: [...keys], prefixes: [] })
      .then(
        (response) => response.status,
        (error: Error) => error.message,
      );

  it('survives a ZIP whose first object cannot be read', async () => {
    const outcome = await failingZip(['definitely-not-here.txt', 'pixel.png']);
    expect(outcome).not.toBe(200);
    // The point of the case: the process is still serving.
    await harness.http().get('/health').expect(200);
  }, 60_000);

  it('survives a ZIP whose later object cannot be read', async () => {
    const outcome = await failingZip(['pixel.png', 'definitely-not-here.txt']);
    expect(outcome).not.toBe(200);
    await harness.http().get('/health').expect(200);
  }, 60_000);

  it('serves a range as a 206 with the slice, as it always did', async () => {
    const response = await harness
      .http()
      .get(
        `/api/v1/servers/${MINIO.name}/buckets/${bucket}/objects/download?key=evil.html&inline=true`,
      )
      .set('Cookie', cookie)
      .set('Range', 'bytes=0-4')
      .expect(206);
    expect(response.headers['content-range']).toContain('bytes 0-4/');
  }, 60_000);

  /* ----------------- a move whose delete is refused ----------------- */

  it('reports a move whose original cannot be deleted, and does not count it', async () => {
    const key = 'nodelete/move-me.txt';
    await put(key, 'the original');

    const response = await harness
      .http()
      .post(`/api/v1/servers/${readOnlyDeleteServer}/buckets/${bucket}/objects/copy`)
      .set(auth())
      .send({
        keys: [key],
        prefixes: [],
        destServerId: readOnlyDeleteServer,
        destBucket: bucket,
        destPrefix: 'moved/',
        move: true,
        conflict: 'overwrite',
      })
      .expect(201);

    expect(response.body.job).toBeNull();
    // Not counted as moved, and the key is named in the errors.
    expect(response.body.copied).toBe(0);
    expect(response.body.errors).toHaveLength(1);
    expect(response.body.errors[0].key).toBe(key);
    expect(response.body.errors[0].message).toMatch(/could not be removed/i);

    // Both halves of that sentence are true on the server: the copy landed and
    // the original is still there.
    await expectExists('moved/move-me.txt');
    await expectExists(key);
  }, 120_000);

  it('fails a rename whose original cannot be deleted rather than claiming success', async () => {
    const key = 'nodelete/rename-me.txt';
    await put(key, 'the original');

    const response = await harness
      .http()
      .post(`/api/v1/servers/${readOnlyDeleteServer}/buckets/${bucket}/objects/rename`)
      .set(auth())
      .send({ key, newKey: 'nodelete/renamed.txt' })
      .expect(502);

    expect(response.body.code).toBe('PROVIDER_ERROR');
    expect(response.body.detail).toMatch(/both now exist/i);
    expect(response.headers['content-type']).toContain('application/problem+json');

    // Which is exactly what the store shows.
    await expectExists('nodelete/renamed.txt');
    await expectExists(key);
  }, 120_000);

  /* -------------------------- the plumbing -------------------------- */

  async function seed(): Promise<void> {
    const client = clientForMinio();
    try {
      const objects: readonly { key: string; body: string | Buffer; type: string }[] = [
        { key: 'evil.html', body: HTML_BODY, type: 'text/html' },
        {
          key: 'logo.svg',
          body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
          type: 'image/svg+xml',
        },
        { key: 'app.js', body: 'alert(1)', type: 'application/javascript' },
        { key: 'feed.xml', body: '<rss/>', type: 'application/xml' },
        { key: 'pixel.png', body: Buffer.from('89504e470d0a1a0a', 'hex'), type: 'image/png' },
        { key: 'doc.pdf', body: '%PDF-1.4\n%%EOF\n', type: 'application/pdf' },
      ];
      for (const object of objects) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: object.key,
            Body: object.body,
            ContentType: object.type,
          }),
        );
      }
    } finally {
      client.destroy();
    }
  }

  async function put(key: string, body: string): Promise<void> {
    const client = clientForMinio();
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    } finally {
      client.destroy();
    }
  }

  async function expectExists(key: string): Promise<void> {
    const response = await harness
      .http()
      .get(
        `/api/v1/servers/${MINIO.name}/buckets/${bucket}/objects/meta?key=${encodeURIComponent(key)}`,
      )
      .set('Cookie', cookie);
    expect(response.status, `expected "${key}" to exist`).toBe(200);
  }

  /**
   * The same MinIO, added a second time under a credential whose session policy
   * denies the delete. Nothing about storage-io knows the two servers are one
   * machine, which is what makes this a real refused delete rather than a stub.
   */
  async function addRestrictedServer(): Promise<void> {
    await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/iam/users`)
      .set(auth())
      .send({
        name: restrictedUser,
        secret: 'sio-it-nodelete-secret-1234',
        policies: ['readwrite'],
        groups: [],
        createAccessKey: false,
      })
      .expect(201);

    const created = await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/iam/access-keys`)
      .set(auth())
      .send({
        userName: restrictedUser,
        name: 'no-delete',
        expiresAt: null,
        policy: NO_DELETE_POLICY,
      })
      .expect(201);
    restrictedKeyId = created.body.accessKey.accessKeyId as string;

    await harness
      .http()
      .post('/api/v1/servers')
      .set(auth())
      .send({
        name: readOnlyDeleteServer,
        provider: MINIO.provider,
        endpoint: MINIO.endpoint,
        region: MINIO.region,
        accessKeyId: restrictedKeyId,
        secretAccessKey: created.body.secretAccessKey as string,
        options: { pathStyle: true, healthIntervalSec: 3600 },
      })
      .expect(201);
  }

  async function createBucket(name: string, overrides: Record<string, unknown>): Promise<void> {
    await harness
      .http()
      .post(`/api/v1/servers/${MINIO.name}/buckets`)
      .set(auth())
      .send({
        name,
        versioning: false,
        objectLock: false,
        quota: null,
        access: 'private',
        ...overrides,
      })
      .expect(201);
    createdBuckets.push(name);
  }

  /**
   * A COMPLIANCE-retained object cannot be removed until it expires, by anybody —
   * so the locked bucket is expected to survive the run. It is named after this
   * run, so it cannot break the next one.
   */
  async function forceCleanup(name: string): Promise<void> {
    const client = clientForMinio();
    try {
      const listed = await client.send(new ListObjectVersionsCommand({ Bucket: name }));
      const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
        .filter((entry) => entry.Key !== undefined)
        .map((entry) => ({ Key: entry.Key as string, VersionId: entry.VersionId }));
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: objects, Quiet: true } }),
        );
      }
      await client.send(new DeleteBucketCommand({ Bucket: name }));
    } catch {
      // Best effort; see the note above.
    } finally {
      client.destroy();
    }
  }

  function clientForMinio(): S3Client {
    return new S3Client({
      endpoint: MINIO.endpoint,
      region: MINIO.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: MINIO.accessKeyId,
        secretAccessKey: MINIO.secretAccessKey,
      },
      maxAttempts: 1,
    });
  }
});
