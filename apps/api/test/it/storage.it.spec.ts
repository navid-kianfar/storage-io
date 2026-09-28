import { createServer, type Server as HttpServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { InventoryRefresherService } from '../../src/modules/inventory/inventory-refresher.service';
import { createTestApp, type TestHarness } from '../support/test-app';
import { IT_ENABLED, MINIO, SEAWEEDFS, assertContainersUp } from './containers';

/**
 * Buckets, objects and quotas against the real MinIO and SeaweedFS containers.
 *
 * The e2e suite proves the contract shapes and the validation with no server
 * reachable. These prove what only a real S3 implementation can: that a multipart
 * upload actually becomes one, that a `Range` request comes back as a 206 with the
 * right slice, that a presigned URL works from outside the API, that a copy between
 * two different servers moves the bytes, and that MinIO's native quota rejects the
 * write.
 *
 * Every test is written against what a caller can observe — a status code, a
 * response body, the bytes that come back — never against how the service reached
 * it. The one exception is the inventory refresher, which is driven directly
 * because the background sweep is switched off in tests.
 */
describe.skipIf(!IT_ENABLED)('storage against live containers', () => {
  let harness: TestHarness;
  let cookie: string;
  let refresher: InventoryRefresherService;

  /** A suffix so a rerun never collides with a bucket a previous run left behind. */
  const run = Date.now().toString(36);
  const minioBucket = `sio-it-minio-${run}`;
  const lockBucket = `sio-it-lock-${run}`;
  const quotaBucket = `sio-it-quota-${run}`;
  const seaweedBucket = `sio-it-seaweed-${run}`;
  const createdBuckets: { server: string; bucket: string }[] = [];

  beforeAll(async () => {
    await assertContainersUp();
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
    refresher = harness.app.get(InventoryRefresherService);

    await addServer(
      MINIO.name,
      MINIO.provider,
      MINIO.endpoint,
      MINIO.accessKeyId,
      MINIO.secretAccessKey,
    );
    await addServer(
      SEAWEEDFS.name,
      SEAWEEDFS.provider,
      SEAWEEDFS.endpoint,
      SEAWEEDFS.accessKeyId,
      SEAWEEDFS.secretAccessKey,
    );
  });

  afterAll(async () => {
    // Force-delete rather than assume each test tidied up: a failing assertion
    // mid-test must not leave a bucket behind that breaks the next run.
    for (const entry of createdBuckets.reverse()) {
      const response = await harness
        .http()
        .delete(`/api/v1/servers/${entry.server}/buckets/${entry.bucket}?force=true`)
        .set(auth());
      if (response.status === 204) continue;
      await bypassCleanup(entry.server, entry.bucket);
    }
    await harness.close();
  });

  /**
   * The escape hatch for a bucket holding objects under a GOVERNANCE retention.
   *
   * `?force=true` cannot remove those, correctly: bypassing a retention lock is a
   * deliberate, audited act and not something a delete should do quietly. The test
   * suite is allowed to, because it created the lock — so it goes around the API
   * with the SDK rather than asking the product to grow a bypass it should not have.
   */
  async function bypassCleanup(server: string, bucket: string): Promise<void> {
    const target = server === MINIO.name ? MINIO : SEAWEEDFS;
    const client = new S3Client({
      endpoint: target.endpoint,
      region: target.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
      },
      maxAttempts: 1,
    });

    try {
      const listed = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
      const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
        .filter((entry) => entry.Key !== undefined)
        .map((entry) => ({ Key: entry.Key as string, VersionId: entry.VersionId }));

      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
            BypassGovernanceRetention: true,
          }),
        );
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch {
      // Cleanup is best-effort: a bucket that survives is named after this run, so
      // it cannot break the next one, and failing here would hide the real failure.
    } finally {
      client.destroy();
    }
  }

  const auth = (): Record<string, string> => ({ Cookie: cookie, Origin: harness.origin });

  async function addServer(
    name: string,
    provider: string,
    endpoint: string,
    accessKeyId: string,
    secretAccessKey: string,
  ): Promise<void> {
    await harness
      .http()
      .post('/api/v1/servers')
      .set(auth())
      .send({
        name,
        provider,
        endpoint,
        region: 'us-east-1',
        accessKeyId,
        secretAccessKey,
        options: { pathStyle: true, healthIntervalSec: 3600 },
      })
      .expect(201);
  }

  async function createBucket(
    server: string,
    bucket: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await harness
      .http()
      .post(`/api/v1/servers/${server}/buckets`)
      .set(auth())
      .send({
        name: bucket,
        versioning: false,
        objectLock: false,
        quota: null,
        access: 'private',
        ...overrides,
      })
      .expect(201);
    createdBuckets.push({ server, bucket });
    return response.body as Record<string, unknown>;
  }

  /** A raw streamed PUT, the way the web app uploads. */
  async function upload(
    server: string,
    bucket: string,
    key: string,
    body: Buffer | string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(
      `${harness.origin}/api/v1/servers/${server}/buckets/${bucket}/objects/upload?key=${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        headers: { ...auth(), 'content-type': 'application/octet-stream', ...headers },
        body: typeof body === 'string' ? body : new Uint8Array(body),
      },
    );
  }

  const objectsPath = (server: string, bucket: string): string =>
    `/api/v1/servers/${server}/buckets/${bucket}/objects`;

  /* ================================ MinIO ============================= */

  describe('MinIO: creating a bucket', () => {
    it('creates one with versioning and a quota, and reports them back', async () => {
      const body = await createBucket(MINIO.name, minioBucket, {
        versioning: true,
        quota: { limitBytes: 10_000_000, mode: 'alert' },
      });

      expect(body).toMatchObject({
        name: minioBucket,
        serverName: MINIO.name,
        provider: 'minio',
        versioning: 'enabled',
        objectLock: false,
        access: 'private',
        unavailable: false,
      });
      expect(body['quota']).toMatchObject({ limitBytes: 10_000_000, mode: 'alert' });
      // CreateBucket returns no timestamp, so the API stamps it: the response must
      // not show a blank "created" for a bucket the operator just made.
      expect(body['createdAt']).toEqual(expect.any(String));
    });

    it('refuses a name that already exists', async () => {
      const response = await harness
        .http()
        .post(`/api/v1/servers/${MINIO.name}/buckets`)
        .set(auth())
        .send({
          name: minioBucket,
          versioning: false,
          objectLock: false,
          quota: null,
          access: 'private',
        })
        .expect(409);
      expect(response.body.code).toBe('CONFLICT');
    });

    it('creates one with object lock, which implies versioning', async () => {
      const body = await createBucket(MINIO.name, lockBucket, { objectLock: true });
      expect(body).toMatchObject({ objectLock: true, versioning: 'enabled' });
    });

    it('refuses to enable object lock on a bucket that was created without it', async () => {
      const response = await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/object-lock`)
        .set(auth())
        .send({ mode: 'GOVERNANCE', days: 1, years: null })
        .expect(409);

      expect(response.body.code).toBe('NOT_SUPPORTED');
      expect(response.body.detail).toContain('created');
    });

    it('sets the default retention on a bucket that does have object lock', async () => {
      const response = await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${lockBucket}/object-lock`)
        .set(auth())
        .send({ mode: 'GOVERNANCE', days: 1, years: null })
        .expect(200);
      expect(response.body).toEqual({ enabled: true, mode: 'GOVERNANCE', days: 1, years: null });

      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${lockBucket}/object-lock`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body).toMatchObject({ enabled: true, mode: 'GOVERNANCE', days: 1 });
    });
  });

  describe('MinIO: uploading and listing', () => {
    it('uploads a small object with metadata and tags', async () => {
      const response = await upload(MINIO.name, minioBucket, 'a/1.txt', 'hello world', {
        'content-type': 'text/plain',
        'x-sio-meta-owner': 'alice',
        'x-sio-tags': 'stage=raw&team=data',
      });
      expect(response.status).toBe(200);

      const item = (await response.json()) as Record<string, unknown>;
      expect(item).toMatchObject({ key: 'a/1.txt', size: 11 });
      expect(item['etag']).toEqual(expect.any(String));

      const meta = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}/meta?key=a%2F1.txt`)
        .set('Cookie', cookie)
        .expect(200);

      expect(meta.body.contentType).toBe('text/plain');
      expect(meta.body.metadata).toMatchObject({ owner: 'alice' });
      expect(meta.body.tags).toEqual({ stage: 'raw', team: 'data' });
    });

    it('uploads a body larger than the part size as a multipart upload', async () => {
      // The part size is the operator's setting, so it is set here rather than
      // assumed; a 9 MB body then has to become two parts. A multipart ETag is the
      // digest of the part digests plus "-<count>", which is the only thing a
      // caller can observe about how the upload was performed.
      await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ transfers: { partSizeMb: 8 } })
        .expect(200);

      const nineMegabytes = Buffer.alloc(9 * 1024 * 1024, 7);
      const response = await upload(MINIO.name, minioBucket, 'big.bin', nineMegabytes);
      expect(response.status).toBe(200);

      const item = (await response.json()) as { size: number; etag: string };
      expect(item.size).toBe(nineMegabytes.length);
      expect(item.etag).toMatch(/-\d+$/);

      const download = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download?key=big.bin`,
        { headers: { Cookie: cookie } },
      );
      // The bytes survived the multipart round trip, not just the object record.
      expect(Buffer.from(await download.arrayBuffer()).equals(nineMegabytes)).toBe(true);
    });

    it('uploads a body whatever Content-Type it declares', async () => {
      // Both body parsers match on Content-Type. An upload declaring one of their
      // types used to be read into memory, parsed, and reach the handler as an
      // empty stream — a zero-byte object with a successful 200.
      for (const contentType of [
        'application/json',
        'application/x-www-form-urlencoded',
        'application/ld+json',
      ]) {
        const key = `types/${contentType.replace(/[^a-z]/g, '-')}.bin`;
        const response = await upload(MINIO.name, minioBucket, key, 'a=1&b=2', {
          'content-type': contentType,
        });
        expect(response.status).toBe(200);
        expect(((await response.json()) as { size: number }).size).toBe(7);

        const download = await fetch(
          `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download?key=${encodeURIComponent(key)}`,
          { headers: { Cookie: cookie } },
        );
        expect(await download.text()).toBe('a=1&b=2');
      }
    });

    it('refuses to overwrite when overwrite=false', async () => {
      const response = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/upload?key=a%2F1.txt&overwrite=false`,
        { method: 'PUT', headers: auth(), body: 'again' },
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe('CONFLICT');
    });

    it('lists one level, with folders as prefixes', async () => {
      await upload(MINIO.name, minioBucket, 'a/2.txt', 'two');
      await upload(MINIO.name, minioBucket, 'b/1.txt', 'one');

      const response = await harness
        .http()
        .get(objectsPath(MINIO.name, minioBucket))
        .set('Cookie', cookie)
        .expect(200);

      const prefixes = response.body.prefixes.map((p: { prefix: string }) => p.prefix) as string[];
      expect(prefixes).toContain('a/');
      expect(prefixes).toContain('b/');
      expect(response.body.objects.map((o: { key: string }) => o.key)).toContain('big.bin');
    });

    it('lists inside a prefix', async () => {
      const response = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}?prefix=a%2F`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.objects.map((o: { key: string }) => o.key).sort()).toEqual([
        'a/1.txt',
        'a/2.txt',
      ]);
      expect(response.body.prefixes).toEqual([]);
    });

    it('pages with an opaque cursor', async () => {
      const first = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}?prefix=a%2F&limit=1`)
        .set('Cookie', cookie)
        .expect(200);

      expect(first.body.objects).toHaveLength(1);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await harness
        .http()
        .get(
          `${objectsPath(MINIO.name, minioBucket)}?prefix=a%2F&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
        )
        .set('Cookie', cookie)
        .expect(200);

      expect(second.body.objects).toHaveLength(1);
      expect(second.body.objects[0].key).not.toBe(first.body.objects[0].key);
    });

    it('narrows a page with q', async () => {
      const response = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}?prefix=a%2F&q=2`)
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body.objects.map((o: { key: string }) => o.key)).toEqual(['a/2.txt']);
    });

    it('creates a folder placeholder', async () => {
      await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/folder`)
        .set(auth())
        .send({ prefix: 'empty-folder' })
        .expect(201);

      const response = await harness
        .http()
        .get(objectsPath(MINIO.name, minioBucket))
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body.prefixes.map((p: { prefix: string }) => p.prefix)).toContain(
        'empty-folder/',
      );
    });
  });

  describe('MinIO: downloading', () => {
    it('streams the whole object with the headers a browser needs', async () => {
      const response = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download?key=a%2F1.txt`,
        { headers: { Cookie: cookie } },
      );

      expect(response.status).toBe(200);
      // The charset is forced rather than left to the provider: a text response
      // with no charset can be sniffed into one the writer did not intend.
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(response.headers.get('content-disposition')).toContain('attachment');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.text()).toBe('hello world');
    });

    it('honours Range with a 206 and the right slice', async () => {
      const response = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download?key=a%2F1.txt`,
        { headers: { Cookie: cookie, Range: 'bytes=6-10' } },
      );

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 6-10/11');
      expect(await response.text()).toBe('world');
    });

    it('serves inline when asked, for the preview pane', async () => {
      const response = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download?key=a%2F1.txt&inline=true`,
        { headers: { Cookie: cookie } },
      );
      expect(response.headers.get('content-disposition')).toContain('inline');
      await response.arrayBuffer();
    });

    it('streams a ZIP of a selection of keys and prefixes', async () => {
      const response = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download-zip`,
        {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ keys: ['a/1.txt'], prefixes: ['b/'] }),
        },
      );

      expect(response.status).toBe(201);
      expect(response.headers.get('content-type')).toBe('application/zip');

      const archive = Buffer.from(await response.arrayBuffer());
      // "PK\x03\x04" is the local file header a real ZIP starts with.
      expect(archive.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
      // Both entry names appear in the central directory, uncompressed.
      expect(archive.includes(Buffer.from('a/1.txt'))).toBe(true);
      expect(archive.includes(Buffer.from('b/1.txt'))).toBe(true);
    });

    it('presigns a URL that works without the session cookie', async () => {
      const presigned = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/presign`)
        .set(auth())
        .send({ key: 'a/1.txt', expiresInSeconds: 300, download: true })
        .expect(201);

      expect(presigned.body.expiresAt).toEqual(expect.any(String));

      // Fetched with no credentials at all: this is the whole point of a share link.
      const fetched = await fetch(presigned.body.url as string);
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe('hello world');
      expect(fetched.headers.get('content-disposition')).toContain('attachment');
    });
  });

  describe('MinIO: editing an object', () => {
    it('renames, keeping the content type, metadata and tags', async () => {
      const renamed = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/rename`)
        .set(auth())
        .send({ key: 'a/2.txt', newKey: 'a/renamed.txt' })
        .expect(201);
      expect(renamed.body.key).toBe('a/renamed.txt');

      await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}/meta?key=a%2F2.txt`)
        .set('Cookie', cookie)
        .expect(404);
    });

    it('replaces the content headers and user metadata', async () => {
      const response = await harness
        .http()
        .put(`${objectsPath(MINIO.name, minioBucket)}/metadata?key=a%2F1.txt`)
        .set(auth())
        .send({
          contentType: 'text/markdown',
          cacheControl: 'max-age=60',
          contentDisposition: null,
          metadata: { owner: 'bob', reviewed: 'yes' },
        })
        .expect(200);

      expect(response.body.contentType).toBe('text/markdown');
      expect(response.body.cacheControl).toBe('max-age=60');
      expect(response.body.metadata).toEqual({ owner: 'bob', reviewed: 'yes' });
      // TaggingDirective COPY: an edit to the headers must not drop the tags.
      expect(response.body.tags).toEqual({ stage: 'raw', team: 'data' });
    });

    it('replaces object tags', async () => {
      await harness
        .http()
        .put(`${objectsPath(MINIO.name, minioBucket)}/tags?key=a%2F1.txt`)
        .set(auth())
        .send({ tags: { stage: 'curated' } })
        .expect(200);

      const read = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}/tags?key=a%2F1.txt`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body.tags).toEqual({ stage: 'curated' });
    });

    it('edits the contents in place, which becomes a new version', async () => {
      const response = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/content?key=a%2F1.txt`,
        {
          method: 'PUT',
          headers: { ...auth(), 'content-type': 'text/plain' },
          body: 'edited body',
        },
      );
      expect(response.status).toBe(200);

      const download = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download?key=a%2F1.txt`,
        { headers: { Cookie: cookie } },
      );
      expect(await download.text()).toBe('edited body');

      // A PUT replaces the tag set along with the bytes, so the edit has to read
      // the tags and write them back. It did not, and editing a file in the
      // console silently stripped tags that lifecycle rules and policies match on.
      // The preceding test left this object tagged `stage: curated`.
      const tags = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}/tags?key=a%2F1.txt`)
        .set('Cookie', cookie)
        .expect(200);
      expect(tags.body.tags).toEqual({ stage: 'curated' });
    });

    it('changes the storage class', async () => {
      const response = await harness
        .http()
        .put(`${objectsPath(MINIO.name, minioBucket)}/storage-class?key=a%2Frenamed.txt`)
        .set(auth())
        .send({ storageClass: 'REDUCED_REDUNDANCY' })
        .expect(200);
      expect(response.body.storageClass).toBe('REDUCED_REDUNDANCY');
    });

    it('sets a retention and a legal hold on a lock-enabled bucket', async () => {
      await upload(MINIO.name, lockBucket, 'held.txt', 'keep me');

      const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const retained = await harness
        .http()
        .put(`${objectsPath(MINIO.name, lockBucket)}/retention?key=held.txt`)
        .set(auth())
        .send({ mode: 'GOVERNANCE', until })
        .expect(200);
      expect(retained.body.retention).toMatchObject({ mode: 'GOVERNANCE' });

      const held = await harness
        .http()
        .put(`${objectsPath(MINIO.name, lockBucket)}/retention?key=held.txt`)
        .set(auth())
        .send({ legalHold: true })
        .expect(200);
      expect(held.body.legalHold).toBe(true);

      // Release it again, or afterAll cannot empty the bucket.
      await harness
        .http()
        .put(`${objectsPath(MINIO.name, lockBucket)}/retention?key=held.txt`)
        .set(auth())
        .send({ legalHold: false })
        .expect(200);
    });
  });

  describe('MinIO: versions', () => {
    it('lists every version of a key, newest first', async () => {
      const response = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}/versions?key=a%2F1.txt`)
        .set('Cookie', cookie)
        .expect(200);

      // Uploaded, then metadata-replaced, then edited in place.
      expect(response.body.items.length).toBeGreaterThanOrEqual(3);
      expect(response.body.items[0].isLatest).toBe(true);
    });

    it('restores an older version over the current one, keeping the history', async () => {
      const versions = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}/versions?key=a%2F1.txt`)
        .set('Cookie', cookie)
        .expect(200);
      const before = versions.body.items.length as number;

      // The oldest version is the original upload.
      const oldest = versions.body.items[before - 1] as { versionId: string };

      await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/restore-version`)
        .set(auth())
        .send({ key: 'a/1.txt', versionId: oldest.versionId })
        .expect(201);

      const download = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download?key=a%2F1.txt`,
        { headers: { Cookie: cookie } },
      );
      expect(await download.text()).toBe('hello world');

      const after = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}/versions?key=a%2F1.txt`)
        .set('Cookie', cookie)
        .expect(200);
      expect(after.body.items.length).toBe(before + 1);
    });

    it('shows versions in the listing when asked', async () => {
      const response = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}?prefix=a%2F&showVersions=true`)
        .set('Cookie', cookie)
        .expect(200);

      const forKey = response.body.objects.filter((o: { key: string }) => o.key === 'a/1.txt');
      expect(forKey.length).toBeGreaterThanOrEqual(3);
      expect(forKey.some((o: { isLatest: boolean }) => o.isLatest)).toBe(true);
    });

    it('deletes every version of a key when allVersions is set', async () => {
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/delete`)
        .set(auth())
        .send({ objects: [{ key: 'a/1.txt' }], prefixes: [], allVersions: true })
        .expect(201);

      expect(response.body.deleted).toBeGreaterThanOrEqual(3);
      expect(response.body.errors).toEqual([]);
      expect(response.body.job).toBeNull();

      const versions = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}/versions?key=a%2F1.txt`)
        .set('Cookie', cookie)
        .expect(200);
      expect(versions.body.items).toEqual([]);
    });

    it('hands a prefix delete to a job rather than doing it inline', async () => {
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/delete`)
        .set(auth())
        .send({ objects: [], prefixes: ['empty-folder/'], allVersions: false })
        .expect(201);

      expect(response.body.deleted).toBe(0);
      expect(response.body.job).toMatchObject({ type: 'delete', status: 'queued' });
      expect(response.body.job.source).toMatchObject({
        bucket: minioBucket,
        serverName: MINIO.name,
      });
    });
  });

  describe('MinIO: bucket settings', () => {
    it('round-trips lifecycle rules', async () => {
      const rules = [
        {
          id: 'expire-logs',
          enabled: true,
          prefix: 'logs/',
          tags: {},
          expireDays: 30,
          noncurrentExpireDays: 7,
          abortMultipartDays: 3,
          transition: null,
          expiredDeleteMarkers: false,
        },
      ];

      await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/lifecycle`)
        .set(auth())
        .send({ rules })
        .expect(200);

      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/lifecycle`)
        .set('Cookie', cookie)
        .expect(200);

      // `abortMultipartDays` is asserted separately below: MinIO accepts it and then
      // does not report it back, so this bucket cannot round-trip it.
      expect(read.body.rules).toEqual([{ ...rules[0], abortMultipartDays: null }]);
    });

    it('records that MinIO does not report an abort-multipart rule back', async () => {
      // Verified against MinIO DEVELOPMENT.2025-05-24T17-08-30Z: a rule carrying
      // only AbortIncompleteMultipartUpload is rejected as schema-invalid, and one
      // that carries it alongside an expiry is accepted but reads back without it.
      // Asserted so the day MinIO fixes it, this test says so.
      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/lifecycle`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body.rules[0].abortMultipartDays).toBeNull();
      expect(read.body.rules[0].noncurrentExpireDays).toBe(7);
    });

    it('removes the lifecycle configuration for an empty rule list', async () => {
      await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/lifecycle`)
        .set(auth())
        .send({ rules: [] })
        .expect(200);

      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/lifecycle`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body.rules).toEqual([]);
    });

    it('applies the public-read preset and reads the access level back', async () => {
      const applied = await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/access`)
        .set(auth())
        .send({ access: 'public-read' })
        .expect(200);
      expect(applied.body.access).toBe('public-read');
      expect(applied.body.policy).not.toBeNull();

      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/access`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body.access).toBe('public-read');
    });

    it('reports a hand-written policy that is not a preset as custom', async () => {
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject', 's3:PutObject'],
            Resource: [`arn:aws:s3:::${minioBucket}/*`],
          },
        ],
      };

      await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/policy`)
        .set(auth())
        .send({ policy })
        .expect(200);

      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/access`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body.access).toBe('custom');
    });

    it('goes back to private, which removes the policy', async () => {
      const applied = await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/access`)
        .set(auth())
        .send({ access: 'private' })
        .expect(200);
      expect(applied.body).toEqual({ access: 'private', policy: null });

      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/policy`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body.policy).toBeNull();
    });

    it('round-trips bucket tags', async () => {
      await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/tags`)
        .set(auth())
        .send({ tags: { env: 'it', owner: 'data' } })
        .expect(200);

      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/tags`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body.tags).toEqual({ env: 'it', owner: 'data' });
    });

    it('suspends and re-enables versioning', async () => {
      await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/versioning`)
        .set(auth())
        .send({ status: 'suspended' })
        .expect(200);

      const suspended = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/versioning`)
        .set('Cookie', cookie)
        .expect(200);
      expect(suspended.body.status).toBe('suspended');

      await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/versioning`)
        .set(auth())
        .send({ status: 'enabled' })
        .expect(200);
    });

    it('reports NOT_SUPPORTED for per-bucket CORS, which MinIO does not implement', async () => {
      // Verified against the container: MinIO answers NotImplemented to
      // PutBucketCors, so the capability profile refuses it before the call.
      const response = await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/cors`)
        .set(auth())
        .send({
          rules: [
            {
              allowedOrigins: ['*'],
              allowedMethods: ['GET'],
              allowedHeaders: [],
              exposeHeaders: [],
              maxAgeSeconds: null,
            },
          ],
        })
        .expect(409);
      expect(response.body.code).toBe('NOT_SUPPORTED');
    });

    it('reports notification target status as an empty list when none is configured', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}/notifications/status`)
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body).toEqual({ items: [] });
    });

    it('serves the detail view with tags and a version count', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body).toMatchObject({ name: minioBucket, versioning: 'enabled' });
      expect(response.body.tags).toEqual({ env: 'it', owner: 'data' });
      expect(response.body.noncurrentVersions).toEqual(expect.any(Number));
    });

    it('reports NOT_FOUND for a bucket the server does not have', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/no-such-bucket-${run}`)
        .set('Cookie', cookie)
        .expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('MinIO: native quotas', () => {
    it('sets a hard quota natively and reports native: true', async () => {
      await createBucket(MINIO.name, quotaBucket);

      const response = await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${quotaBucket}/quota`)
        .set(auth())
        .send({ limitBytes: 1024, mode: 'hard', threshold: 0.8 })
        .expect(200);

      expect(response.body.quota).toEqual({
        limitBytes: 1024,
        mode: 'hard',
        threshold: 0.8,
        native: true,
      });
    });

    it('refuses a write that would exceed the quota', async () => {
      // MinIO enforces this itself; the API's job is to turn its
      // XMinioAdminBucketQuotaExceeded into a 409 rather than a 502.
      const response = await upload(MINIO.name, quotaBucket, 'too-big.bin', Buffer.alloc(4096, 1));
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe('CONFLICT');
    });

    it('allows a write inside the quota', async () => {
      const response = await upload(MINIO.name, quotaBucket, 'small.bin', Buffer.alloc(512, 1));
      expect(response.status).toBe(200);
    });

    it('stores an alert-only quota without pushing it to the provider', async () => {
      const response = await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${quotaBucket}/quota`)
        .set(auth())
        .send({ limitBytes: 2048, mode: 'alert', threshold: 0.5 })
        .expect(200);

      expect(response.body.quota).toEqual({
        limitBytes: 2048,
        mode: 'alert',
        threshold: 0.5,
        native: false,
      });

      // The native limit was cleared with it, so the write MinIO refused now passes.
      const upload4k = await upload(
        MINIO.name,
        quotaBucket,
        'now-allowed.bin',
        Buffer.alloc(4096, 1),
      );
      expect(upload4k.status).toBe(200);
    });

    it('clears the quota', async () => {
      const response = await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${quotaBucket}/quota`)
        .set(auth())
        .send({ limitBytes: null, mode: 'alert', threshold: 0.8 })
        .expect(200);
      expect(response.body.quota).toBeNull();
    });
  });

  /* ============================== SeaweedFS ============================ */

  describe('SeaweedFS', () => {
    it('creates a bucket with versioning', async () => {
      const body = await createBucket(SEAWEEDFS.name, seaweedBucket, { versioning: true });
      expect(body).toMatchObject({
        name: seaweedBucket,
        provider: 'seaweedfs',
        versioning: 'enabled',
      });
    });

    /**
     * SeaweedFS 3.97 accepts `ObjectLockEnabledForBucket` and reports a retention
     * back, but does not enforce it: a delete under GOVERNANCE retention succeeds
     * (verified against the container). Its profile therefore marks object lock
     * `not_supported`, and no capability probe may promote that.
     */
    it('refuses object lock on SeaweedFS, which accepts it but does not enforce it', async () => {
      const server = await harness
        .http()
        .get(`/api/v1/servers/${SEAWEEDFS.name}`)
        .set('Cookie', cookie)
        .expect(200);
      // The profile's permanent `not_supported` must win over any probe result.
      expect(server.body.capabilities.objectLock).toBe('not_supported');

      const response = await harness
        .http()
        .post(`/api/v1/servers/${SEAWEEDFS.name}/buckets`)
        .set(auth())
        .send({
          name: `sio-it-sw-lock-${run}`,
          versioning: false,
          objectLock: true,
          quota: null,
          access: 'private',
        });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('NOT_SUPPORTED');
    });

    it('uploads and downloads an object', async () => {
      const uploaded = await upload(SEAWEEDFS.name, seaweedBucket, 'sw/hello.txt', 'seaweed body', {
        'content-type': 'text/plain',
      });
      expect(uploaded.status).toBe(200);

      const download = await fetch(
        `${harness.origin}${objectsPath(SEAWEEDFS.name, seaweedBucket)}/download?key=sw%2Fhello.txt`,
        { headers: { Cookie: cookie } },
      );
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('seaweed body');
    });

    /**
     * A restore copies a version over its own key. SeaweedFS rejects a self-copy
     * that changes nothing — the 409 "copy an object to itself" — even when the
     * source names an older version, so the restore has to replace the metadata
     * rather than copy it. MinIO never showed this; SeaweedFS is the regression.
     */
    it('restores an older version over the current one', async () => {
      const key = 'sw/restore.txt';
      expect((await upload(SEAWEEDFS.name, seaweedBucket, key, 'first')).status).toBe(200);
      expect((await upload(SEAWEEDFS.name, seaweedBucket, key, 'second')).status).toBe(200);

      const versions = await harness
        .http()
        .get(
          `${objectsPath(SEAWEEDFS.name, seaweedBucket)}/versions?key=${encodeURIComponent(key)}`,
        )
        .set('Cookie', cookie)
        .expect(200);
      const items = versions.body.items as { versionId: string }[];
      const oldest = items[items.length - 1];
      expect(oldest).toBeDefined();

      await harness
        .http()
        .post(`${objectsPath(SEAWEEDFS.name, seaweedBucket)}/restore-version`)
        .set(auth())
        .send({ key, versionId: oldest?.versionId })
        .expect(201);

      const download = await fetch(
        `${harness.origin}${objectsPath(SEAWEEDFS.name, seaweedBucket)}/download?key=${encodeURIComponent(key)}`,
        { headers: { Cookie: cookie } },
      );
      expect(await download.text()).toBe('first');
    });

    it('round-trips CORS rules, which it does implement', async () => {
      const rules = [
        {
          allowedOrigins: ['https://app.example.com'],
          allowedMethods: ['GET', 'PUT'],
          allowedHeaders: ['*'],
          exposeHeaders: [],
          maxAgeSeconds: 3600,
        },
      ];

      await harness
        .http()
        .put(`/api/v1/servers/${SEAWEEDFS.name}/buckets/${seaweedBucket}/cors`)
        .set(auth())
        .send({ rules })
        .expect(200);

      const read = await harness
        .http()
        .get(`/api/v1/servers/${SEAWEEDFS.name}/buckets/${seaweedBucket}/cors`)
        .set('Cookie', cookie)
        .expect(200);

      expect(read.body.rules).toHaveLength(1);
      expect(read.body.rules[0]).toMatchObject({
        allowedOrigins: ['https://app.example.com'],
        maxAgeSeconds: 3600,
      });
    });

    it('stores an alert-only quota, because it has no native one', async () => {
      const response = await harness
        .http()
        .put(`/api/v1/servers/${SEAWEEDFS.name}/buckets/${seaweedBucket}/quota`)
        .set(auth())
        .send({ limitBytes: 5_000_000, mode: 'hard', threshold: 0.9 })
        .expect(200);

      expect(response.body.quota).toMatchObject({ limitBytes: 5_000_000, native: false });
    });
  });

  /* ============================ cross-server =========================== */

  describe('copying between two different servers', () => {
    it('streams an object from MinIO to SeaweedFS', async () => {
      await upload(MINIO.name, minioBucket, 'travel/one.txt', 'crossing over', {
        'content-type': 'text/plain',
      });

      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/copy`)
        .set(auth())
        .send({
          keys: ['travel/one.txt'],
          prefixes: [],
          destServerId: SEAWEEDFS.name,
          destBucket: seaweedBucket,
          destPrefix: 'from-minio/',
          move: false,
          conflict: 'overwrite',
        })
        .expect(201);

      expect(response.body).toMatchObject({ copied: 1, errors: [], job: null });

      const download = await fetch(
        `${harness.origin}${objectsPath(SEAWEEDFS.name, seaweedBucket)}/download?key=${encodeURIComponent('from-minio/one.txt')}`,
        { headers: { Cookie: cookie } },
      );
      expect(await download.text()).toBe('crossing over');
      // The source is untouched by a copy.
      await harness
        .http()
        .get(
          `${objectsPath(MINIO.name, minioBucket)}/meta?key=${encodeURIComponent('travel/one.txt')}`,
        )
        .set('Cookie', cookie)
        .expect(200);
    });

    it('skips an existing destination key when the policy says skip', async () => {
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/copy`)
        .set(auth())
        .send({
          keys: ['travel/one.txt'],
          prefixes: [],
          destServerId: SEAWEEDFS.name,
          destBucket: seaweedBucket,
          destPrefix: 'from-minio/',
          move: false,
          conflict: 'skip',
        })
        .expect(201);
      expect(response.body).toMatchObject({ copied: 0, errors: [] });
    });

    it('writes beside the existing key when the policy says rename', async () => {
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/copy`)
        .set(auth())
        .send({
          keys: ['travel/one.txt'],
          prefixes: [],
          destServerId: SEAWEEDFS.name,
          destBucket: seaweedBucket,
          destPrefix: 'from-minio/',
          move: false,
          conflict: 'rename',
        })
        .expect(201);
      expect(response.body.copied).toBe(1);

      // The inventory has to know the bucket is versioned for the SeaweedFS listing
      // workaround to engage — see ObjectsService.needsVersionedListingWorkaround.
      await refresher.refreshNow(SEAWEEDFS.name);

      const listed = await harness
        .http()
        .get(
          `${objectsPath(SEAWEEDFS.name, seaweedBucket)}?prefix=${encodeURIComponent('from-minio/')}`,
        )
        .set('Cookie', cookie)
        .expect(200);

      expect(listed.body.objects.map((o: { key: string }) => o.key).sort()).toEqual([
        'from-minio/one (1).txt',
        'from-minio/one.txt',
      ]);
    });

    it('moves an object from SeaweedFS to MinIO, leaving nothing behind', async () => {
      await upload(SEAWEEDFS.name, seaweedBucket, 'outbound/two.txt', 'going home');

      const response = await harness
        .http()
        .post(`${objectsPath(SEAWEEDFS.name, seaweedBucket)}/copy`)
        .set(auth())
        .send({
          keys: ['outbound/two.txt'],
          prefixes: [],
          destServerId: MINIO.name,
          destBucket: minioBucket,
          destPrefix: 'from-seaweed/',
          move: true,
          conflict: 'overwrite',
        })
        .expect(201);
      expect(response.body.copied).toBe(1);

      const download = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download?key=${encodeURIComponent('from-seaweed/two.txt')}`,
        { headers: { Cookie: cookie } },
      );
      expect(await download.text()).toBe('going home');

      const gone = await harness
        .http()
        .get(
          `${objectsPath(SEAWEEDFS.name, seaweedBucket)}?prefix=${encodeURIComponent('outbound/')}`,
        )
        .set('Cookie', cookie)
        .expect(200);
      expect(gone.body.objects).toEqual([]);
    });

    it('copies server-side within one server', async () => {
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/copy`)
        .set(auth())
        .send({
          keys: ['travel/one.txt'],
          prefixes: [],
          destServerId: MINIO.name,
          destBucket: lockBucket,
          destPrefix: 'copied/',
          move: false,
          conflict: 'overwrite',
        })
        .expect(201);
      expect(response.body.copied).toBe(1);
    });

    it('hands a prefix copy to a job', async () => {
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/copy`)
        .set(auth())
        .send({
          keys: [],
          prefixes: ['travel/'],
          destServerId: SEAWEEDFS.name,
          destBucket: seaweedBucket,
          destPrefix: 'bulk/',
          move: false,
          conflict: 'overwrite',
        })
        .expect(201);

      expect(response.body.copied).toBe(0);
      expect(response.body.job).toMatchObject({ type: 'copy', status: 'queued' });
      expect(response.body.job.target).toMatchObject({
        serverName: SEAWEEDFS.name,
        bucket: seaweedBucket,
        prefix: 'bulk/',
      });
    });
  });

  /* ========================== batch over a selection =================== */

  describe('MinIO: a batch action over a selection', () => {
    const batchKeys = ['batch/1.txt', 'batch/2.txt', 'batch/3.txt'];

    beforeAll(async () => {
      for (const key of batchKeys) {
        await upload(MINIO.name, minioBucket, key, `body of ${key}`);
      }
    });

    it('applies tags to every key and reports the count', async () => {
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/batch`)
        .set(auth())
        .send({ keys: batchKeys, action: 'tags', payload: { tags: { reviewed: 'yes' } } })
        .expect(201);

      expect(response.body).toEqual({ updated: 3, errors: [] });

      for (const key of batchKeys) {
        const read = await harness
          .http()
          .get(`${objectsPath(MINIO.name, minioBucket)}/tags?key=${encodeURIComponent(key)}`)
          .set('Cookie', cookie)
          .expect(200);
        expect(read.body.tags).toEqual({ reviewed: 'yes' });
      }
    });

    it('changes the storage class of every key', async () => {
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/batch`)
        .set(auth())
        .send({
          keys: batchKeys,
          action: 'storage-class',
          payload: { storageClass: 'REDUCED_REDUNDANCY' },
        })
        .expect(201);
      expect(response.body.updated).toBe(3);

      const meta = await harness
        .http()
        .get(
          `${objectsPath(MINIO.name, minioBucket)}/meta?key=${encodeURIComponent('batch/1.txt')}`,
        )
        .set('Cookie', cookie)
        .expect(200);
      expect(meta.body.storageClass).toBe('REDUCED_REDUNDANCY');
    });

    it('reports a per-key failure as a row and still applies to the rest', async () => {
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/batch`)
        .set(auth())
        .send({
          keys: [...batchKeys, 'batch/does-not-exist.txt'],
          action: 'tags',
          payload: { tags: { pass: 'two' } },
        })
        .expect(201);

      expect(response.body.updated).toBe(3);
      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].key).toBe('batch/does-not-exist.txt');
      expect(response.body.errors[0].message).toContain('NOT_FOUND');
    });

    it('sets a retention across a selection on a lock-enabled bucket', async () => {
      await upload(MINIO.name, lockBucket, 'batch/held-1.txt', 'one');
      await upload(MINIO.name, lockBucket, 'batch/held-2.txt', 'two');

      const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, lockBucket)}/batch`)
        .set(auth())
        .send({
          keys: ['batch/held-1.txt', 'batch/held-2.txt'],
          action: 'retention',
          payload: { mode: 'GOVERNANCE', until },
        })
        .expect(201);
      expect(response.body).toEqual({ updated: 2, errors: [] });

      const meta = await harness
        .http()
        .get(
          `${objectsPath(MINIO.name, lockBucket)}/meta?key=${encodeURIComponent('batch/held-1.txt')}`,
        )
        .set('Cookie', cookie)
        .expect(200);
      expect(meta.body.retention).toMatchObject({ mode: 'GOVERNANCE' });
    });

    it('turns a legal hold on and off across a selection', async () => {
      const keys = ['batch/held-1.txt', 'batch/held-2.txt'];
      const on = await harness
        .http()
        .post(`${objectsPath(MINIO.name, lockBucket)}/batch`)
        .set(auth())
        .send({ keys, action: 'legal-hold', payload: { legalHold: true } })
        .expect(201);
      expect(on.body.updated).toBe(2);

      const off = await harness
        .http()
        .post(`${objectsPath(MINIO.name, lockBucket)}/batch`)
        .set(auth())
        .send({ keys, action: 'legal-hold', payload: { legalHold: false } })
        .expect(201);
      expect(off.body.updated).toBe(2);
    });

    it('refuses an action the provider cannot do at all', async () => {
      // SeaweedFS has no storage classes, so the whole batch is refused up front
      // rather than reported as a thousand identical per-key failures.
      const response = await harness
        .http()
        .post(`${objectsPath(SEAWEEDFS.name, seaweedBucket)}/batch`)
        .set(auth())
        .send({
          keys: ['sw/hello.txt'],
          action: 'storage-class',
          payload: { storageClass: 'GLACIER' },
        });

      expect([200, 201, 409]).toContain(response.status);
      if (response.status === 409) expect(response.body.code).toBe('NOT_SUPPORTED');
    });

    it('rejects a selection larger than the documented maximum', async () => {
      const tooMany = Array.from({ length: 1001 }, (_, index) => `k${index}.txt`);
      await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/batch`)
        .set(auth())
        .send({ keys: tooMany, action: 'tags', payload: { tags: {} } })
        .expect(400);
    });

    it('rejects a payload that does not match the action', async () => {
      await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/batch`)
        .set(auth())
        .send({ keys: ['batch/1.txt'], action: 'tags', payload: { storageClass: 'GLACIER' } })
        .expect(400);
    });
  });

  /* ======================== resumable multipart upload ================= */

  describe('MinIO: a resumable multipart upload', () => {
    const key = 'resumable/large.bin';
    /** 5 MiB is S3's minimum for every part but the last. */
    const partSize = 5 * 1024 * 1024;
    const first = Buffer.alloc(partSize, 1);
    const second = Buffer.alloc(1024, 2);

    const multipartPath = (suffix = ''): string =>
      `${objectsPath(MINIO.name, minioBucket)}/multipart${suffix}`;

    const putPart = async (uploadId: string, partNumber: number, body: Buffer): Promise<Response> =>
      fetch(
        `${harness.origin}${multipartPath(`/${uploadId}/parts/${partNumber}`)}?key=${encodeURIComponent(key)}`,
        {
          method: 'PUT',
          headers: { ...auth(), 'content-type': 'application/octet-stream' },
          body: new Uint8Array(body),
        },
      );

    it('uploads in parts, resumes from what the server holds, and completes', async () => {
      const started = await harness
        .http()
        .post(multipartPath())
        .set(auth())
        .send({
          key,
          contentType: 'application/octet-stream',
          metadata: { origin: 'browser' },
          tags: { stage: 'resumable' },
          storageClass: null,
        })
        .expect(201);

      const uploadId = started.body.uploadId as string;
      expect(uploadId).toEqual(expect.any(String));
      expect(started.body.key).toBe(key);
      // Never below S3's own minimum, whatever the operator configured.
      expect(started.body.partSizeBytes).toBeGreaterThanOrEqual(partSize);

      const firstPart = await putPart(uploadId, 1, first);
      expect(firstPart.status).toBe(200);
      const firstBody = (await firstPart.json()) as {
        partNumber: number;
        etag: string;
        size: number;
      };
      expect(firstBody).toMatchObject({ partNumber: 1, size: first.length });

      // The client "comes back": it asks what is already stored before continuing.
      const resumed = await harness
        .http()
        .get(`${multipartPath(`/${uploadId}`)}?key=${encodeURIComponent(key)}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(resumed.body.parts).toEqual([
        { partNumber: 1, etag: firstBody.etag, size: first.length },
      ]);

      const secondPart = await putPart(uploadId, 2, second);
      expect(secondPart.status).toBe(200);
      const secondBody = (await secondPart.json()) as { etag: string };

      // Completed out of order on purpose: the API sorts the parts, because S3
      // rejects a completion whose part numbers are not ascending.
      const completed = await harness
        .http()
        .post(`${multipartPath(`/${uploadId}/complete`)}?key=${encodeURIComponent(key)}`)
        .set(auth())
        .send({
          parts: [
            { partNumber: 2, etag: secondBody.etag },
            { partNumber: 1, etag: firstBody.etag },
          ],
        })
        .expect(201);

      expect(completed.body).toMatchObject({ key, size: first.length + second.length });
      // Assembled by the provider, so the ETag is a multipart one.
      expect(completed.body.etag).toMatch(/-2$/);

      const download = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download?key=${encodeURIComponent(key)}`,
        { headers: { Cookie: cookie } },
      );
      const bytes = Buffer.from(await download.arrayBuffer());
      expect(bytes.length).toBe(first.length + second.length);
      expect(bytes.subarray(0, first.length).equals(first)).toBe(true);
      expect(bytes.subarray(first.length).equals(second)).toBe(true);

      // The metadata and tags given at the start survived the assembly.
      const meta = await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}/meta?key=${encodeURIComponent(key)}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(meta.body.metadata).toMatchObject({ origin: 'browser' });
      expect(meta.body.tags).toEqual({ stage: 'resumable' });
    });

    it('aborts an upload and forgets its parts', async () => {
      const started = await harness
        .http()
        .post(multipartPath())
        .set(auth())
        .send({
          key: 'resumable/abandoned.bin',
          contentType: null,
          metadata: {},
          tags: {},
          storageClass: null,
        })
        .expect(201);
      const uploadId = started.body.uploadId as string;

      await fetch(
        `${harness.origin}${multipartPath(`/${uploadId}/parts/1`)}?key=${encodeURIComponent('resumable/abandoned.bin')}`,
        {
          method: 'PUT',
          headers: { ...auth(), 'content-type': 'application/octet-stream' },
          body: new Uint8Array(Buffer.alloc(partSize, 9)),
        },
      );

      await harness
        .http()
        .delete(
          `${multipartPath(`/${uploadId}`)}?key=${encodeURIComponent('resumable/abandoned.bin')}`,
        )
        .set(auth())
        .expect(204);

      // The upload is gone, so asking for its parts is a 404 rather than an empty list.
      await harness
        .http()
        .get(
          `${multipartPath(`/${uploadId}`)}?key=${encodeURIComponent('resumable/abandoned.bin')}`,
        )
        .set('Cookie', cookie)
        .expect(404);

      // And no object was created.
      await harness
        .http()
        .get(
          `${objectsPath(MINIO.name, minioBucket)}/meta?key=${encodeURIComponent('resumable/abandoned.bin')}`,
        )
        .set('Cookie', cookie)
        .expect(404);
    });

    it('rejects a part number outside the S3 range', async () => {
      const started = await harness
        .http()
        .post(multipartPath())
        .set(auth())
        .send({
          key: 'resumable/bad-part.bin',
          contentType: null,
          metadata: {},
          tags: {},
          storageClass: null,
        })
        .expect(201);
      const uploadId = started.body.uploadId as string;

      const response = await fetch(
        `${harness.origin}${multipartPath(`/${uploadId}/parts/10001`)}?key=${encodeURIComponent('resumable/bad-part.bin')}`,
        { method: 'PUT', headers: auth(), body: 'x' },
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('VALIDATION');

      await harness
        .http()
        .delete(
          `${multipartPath(`/${uploadId}`)}?key=${encodeURIComponent('resumable/bad-part.bin')}`,
        )
        .set(auth())
        .expect(204);
    });
  });

  /* ============================ archive preview ======================== */

  describe('MinIO: listing what is inside an archive', () => {
    it("reads a ZIP's entries from its central directory", async () => {
      // Built by the ZIP download endpoint, so this is an archive the app produced.
      const zip = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download-zip`,
        {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ keys: ['batch/1.txt', 'batch/2.txt'], prefixes: [] }),
        },
      );
      const archive = Buffer.from(await zip.arrayBuffer());
      await upload(MINIO.name, minioBucket, 'archives/bundle.zip', archive, {
        'content-type': 'application/zip',
      });

      const response = await harness
        .http()
        .get(
          `${objectsPath(MINIO.name, minioBucket)}/archive-entries?key=${encodeURIComponent('archives/bundle.zip')}`,
        )
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.format).toBe('zip');
      expect(response.body.truncated).toBe(false);
      expect(response.body.entries.map((entry: { path: string }) => entry.path).sort()).toEqual([
        'batch/1.txt',
        'batch/2.txt',
      ]);
      expect(response.body.entries[0].size).toBeGreaterThan(0);
    });

    it('honours the entry limit', async () => {
      const response = await harness
        .http()
        .get(
          `${objectsPath(MINIO.name, minioBucket)}/archive-entries?key=${encodeURIComponent('archives/bundle.zip')}&limit=1`,
        )
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body.entries).toHaveLength(1);
      expect(response.body.truncated).toBe(true);
    });

    it('reads a gzipped tar', async () => {
      const { gzipSync } = await import('node:zlib');
      const header = Buffer.alloc(512);
      header.write('inside/file.txt', 0, 100, 'utf8');
      header.write('0000644\0', 100, 8, 'latin1');
      header.write(`${(5).toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
      header.write(`${(1_772_000_000).toString(8).padStart(11, '0')}\0`, 136, 12, 'latin1');
      header.write('0', 156, 1, 'latin1');
      header.write('ustar\0', 257, 6, 'latin1');
      const tar = Buffer.concat([
        header,
        Buffer.from('hello'),
        Buffer.alloc(512 - 5),
        Buffer.alloc(1024),
      ]);

      await upload(MINIO.name, minioBucket, 'archives/bundle.tar.gz', gzipSync(tar), {
        'content-type': 'application/gzip',
      });

      const response = await harness
        .http()
        .get(
          `${objectsPath(MINIO.name, minioBucket)}/archive-entries?key=${encodeURIComponent('archives/bundle.tar.gz')}`,
        )
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.format).toBe('tar');
      expect(response.body.entries).toEqual([
        {
          path: 'inside/file.txt',
          size: 5,
          compressedSize: null,
          modified: expect.any(String),
          dir: false,
        },
      ]);
    });

    it('reports a plain object as unsupported rather than failing', async () => {
      const response = await harness
        .http()
        .get(
          `${objectsPath(MINIO.name, minioBucket)}/archive-entries?key=${encodeURIComponent('batch/1.txt')}`,
        )
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body).toEqual({ format: 'unsupported', entries: [], truncated: false });
    });

    it('reports a zero-byte object as unsupported, not as a provider error', async () => {
      // A ranged read of an empty object is a 416; the question "is this an archive?"
      // has a perfectly good answer, so it must not surface as a 502.
      await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/folder`)
        .set(auth())
        .send({ prefix: 'archives/empty-dir' })
        .expect(201);

      const response = await harness
        .http()
        .get(
          `${objectsPath(MINIO.name, minioBucket)}/archive-entries?key=${encodeURIComponent('archives/empty-dir/')}`,
        )
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body).toEqual({ format: 'unsupported', entries: [], truncated: false });
    });

    it('is a 404 for a key that does not exist', async () => {
      await harness
        .http()
        .get(`${objectsPath(MINIO.name, minioBucket)}/archive-entries?key=nope.zip`)
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  /* ============================== inventory ============================ */

  describe('the inventory refresher', () => {
    it('caches every bucket on both servers with its size', async () => {
      // Driven directly: the background sweep is switched off under test.
      expect(await refresher.refreshNow(MINIO.name)).toBeGreaterThanOrEqual(3);
      expect(await refresher.refreshNow(SEAWEEDFS.name)).toBeGreaterThanOrEqual(1);

      const response = await harness
        .http()
        .get('/api/v1/buckets?pageSize=500')
        .set('Cookie', cookie)
        .expect(200);

      const names = response.body.items.map((b: { name: string }) => b.name);
      expect(names).toContain(minioBucket);
      expect(names).toContain(seaweedBucket);

      const mine = response.body.items.find((b: { name: string }) => b.name === minioBucket);
      expect(mine).toMatchObject({ serverName: MINIO.name, unavailable: false });
      // MinIO reports usage through its admin API, so the size is a real number.
      expect(mine.sizeBytes).toBeGreaterThan(0);
      expect(response.body.summary.buckets).toBe(response.body.total);
    });

    it('filters and sorts the aggregated list', async () => {
      const byServer = await harness
        .http()
        .get(`/api/v1/buckets?serverId=${SEAWEEDFS.name}&pageSize=500`)
        .set('Cookie', cookie)
        .expect(200);
      expect(
        byServer.body.items.every((b: { serverName: string }) => b.serverName === SEAWEEDFS.name),
      ).toBe(true);

      const search = await harness
        .http()
        .get(`/api/v1/buckets?q=${quotaBucket}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(search.body.items.map((b: { name: string }) => b.name)).toEqual([quotaBucket]);

      const byName = await harness
        .http()
        .get('/api/v1/buckets?sort=name&pageSize=500')
        .set('Cookie', cookie)
        .expect(200);
      const listed: string[] = byName.body.items.map((b: { name: string }) => b.name);
      expect(listed).toEqual([...listed].sort());
    });

    it('lists the quota rows with a usage ratio and a support level', async () => {
      const response = await harness
        .http()
        .get('/api/v1/quotas?pageSize=500')
        .set('Cookie', cookie)
        .expect(200);

      const row = response.body.items.find(
        (item: { bucket: { name: string } }) => item.bucket.name === seaweedBucket,
      );
      expect(row).toBeDefined();
      expect(row.supported).toBe('alert-only');
      expect(row.usageRatio).toEqual(expect.any(Number));
      // A daily sample was written by the refresh above, so the trend is not empty.
      expect(row.trend.length).toBeGreaterThanOrEqual(1);
      expect(response.body.summary.withQuota).toBeGreaterThanOrEqual(1);
    });

    it('filters the quota list to the buckets with no limit', async () => {
      const response = await harness
        .http()
        .get('/api/v1/quotas?filter=unlimited&pageSize=500')
        .set('Cookie', cookie)
        .expect(200);
      expect(
        response.body.items.every(
          (item: { bucket: { quota: unknown } }) => item.bucket.quota === null,
        ),
      ).toBe(true);
    });

    it('exports the bucket list as CSV with the cached rows in it', async () => {
      const response = await harness
        .http()
        .get('/api/v1/buckets/export.csv')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.text).toContain('server,provider,bucket');
      expect(response.text).toContain(minioBucket);
      expect(response.text).toContain(MINIO.name);
    });

    it('exports the quota list as CSV', async () => {
      const response = await harness
        .http()
        .get('/api/v1/quotas/export.csv')
        .set('Cookie', cookie)
        .expect(200);
      expect(response.text).toContain(seaweedBucket);
    });
  });

  /* ================================ bulk =============================== */

  describe('bulk bucket actions', () => {
    const bulkA = `sio-it-bulk-a-${run}`;
    const bulkB = `sio-it-bulk-b-${run}`;

    beforeAll(async () => {
      await createBucket(MINIO.name, bulkA);
      await createBucket(MINIO.name, bulkB);
    });

    it('applies tags to several buckets at once', async () => {
      const response = await harness
        .http()
        .post('/api/v1/buckets/bulk')
        .set(auth())
        .send({
          buckets: [
            { serverId: MINIO.name, bucket: bulkA },
            { serverId: MINIO.name, bucket: bulkB },
          ],
          action: 'tags',
          payload: { tags: { batch: run } },
        })
        .expect(201);

      expect(response.body.results).toHaveLength(2);
      expect(response.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);

      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${bulkA}/tags`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body.tags).toEqual({ batch: run });
    });

    it('applies a quota to several buckets at once', async () => {
      await harness
        .http()
        .post('/api/v1/buckets/bulk')
        .set(auth())
        .send({
          buckets: [
            { serverId: MINIO.name, bucket: bulkA },
            { serverId: MINIO.name, bucket: bulkB },
          ],
          action: 'quota',
          payload: { limitBytes: 9_000_000, mode: 'alert', threshold: 0.75 },
        })
        .expect(201);

      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${bulkB}/quota`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body.quota).toMatchObject({ limitBytes: 9_000_000, mode: 'alert' });
    });

    it('adds one lifecycle rule without dropping the rules already there', async () => {
      const existing = {
        id: 'keep-me',
        enabled: true,
        prefix: 'keep/',
        tags: {},
        expireDays: 90,
        noncurrentExpireDays: null,
        abortMultipartDays: null,
        transition: null,
        expiredDeleteMarkers: false,
      };
      await harness
        .http()
        .put(`/api/v1/servers/${MINIO.name}/buckets/${bulkA}/lifecycle`)
        .set(auth())
        .send({ rules: [existing] })
        .expect(200);

      await harness
        .http()
        .post('/api/v1/buckets/bulk')
        .set(auth())
        .send({
          buckets: [{ serverId: MINIO.name, bucket: bulkA }],
          action: 'lifecycle-rule',
          payload: {
            id: 'added-by-bulk',
            enabled: true,
            prefix: 'tmp/',
            tags: {},
            expireDays: 1,
            noncurrentExpireDays: null,
            abortMultipartDays: null,
            transition: null,
            expiredDeleteMarkers: false,
          },
        })
        .expect(201);

      const read = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/buckets/${bulkA}/lifecycle`)
        .set('Cookie', cookie)
        .expect(200);
      expect(read.body.rules.map((r: { id: string }) => r.id).sort()).toEqual([
        'added-by-bulk',
        'keep-me',
      ]);
    });

    it('deletes the empty buckets and reports the non-empty one as a failed row', async () => {
      await upload(MINIO.name, bulkA, 'blocker.txt', 'still here');

      const response = await harness
        .http()
        .post('/api/v1/buckets/bulk')
        .set(auth())
        .send({
          buckets: [
            { serverId: MINIO.name, bucket: bulkA },
            { serverId: MINIO.name, bucket: bulkB },
          ],
          action: 'delete',
          payload: { force: false },
        })
        .expect(201);

      const byBucket = new Map<string, { ok: boolean; message: string | null }>(
        response.body.results.map((r: { bucket: string; ok: boolean; message: string | null }) => [
          r.bucket,
          r,
        ]),
      );

      expect(byBucket.get(bulkB)?.ok).toBe(true);
      expect(byBucket.get(bulkA)?.ok).toBe(false);
      expect(byBucket.get(bulkA)?.message).toContain('BUCKET_NOT_EMPTY');
    });

    it('deletes the non-empty one when force empties it first', async () => {
      const response = await harness
        .http()
        .post('/api/v1/buckets/bulk')
        .set(auth())
        .send({
          buckets: [{ serverId: MINIO.name, bucket: bulkA }],
          action: 'delete',
          payload: { force: true },
        })
        .expect(201);

      expect(response.body.results[0]).toMatchObject({ ok: true, message: null });

      const listed = await harness
        .http()
        .get(`/api/v1/buckets?q=${bulkA}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(listed.body.items).toEqual([]);
    });
  });

  /* ========================= deleting a bucket ========================= */

  describe('deleting a bucket', () => {
    it('refuses a bucket that still holds objects, even on SeaweedFS', async () => {
      // SeaweedFS 3.97 deletes a non-empty bucket and everything in it without
      // complaint, so this 409 is the API's own check rather than the provider's.
      // Without it, DELETE would be silently destructive on that backend.
      const response = await harness
        .http()
        .delete(`/api/v1/servers/${SEAWEEDFS.name}/buckets/${seaweedBucket}`)
        .set(auth())
        .expect(409);
      expect(response.body.code).toBe('BUCKET_NOT_EMPTY');

      // And it is still there.
      const still = await harness
        .http()
        .get(`/api/v1/servers/${SEAWEEDFS.name}/buckets/${seaweedBucket}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(still.body.name).toBe(seaweedBucket);
    });

    it('refuses a MinIO bucket that still holds objects', async () => {
      const response = await harness
        .http()
        .delete(`/api/v1/servers/${MINIO.name}/buckets/${minioBucket}`)
        .set(auth())
        .expect(409);
      expect(response.body.code).toBe('BUCKET_NOT_EMPTY');
    });

    it('empties and deletes it with force, and drops it from the list', async () => {
      await harness
        .http()
        .delete(`/api/v1/servers/${SEAWEEDFS.name}/buckets/${seaweedBucket}?force=true`)
        .set(auth())
        .expect(204);

      const listed = await harness
        .http()
        .get(`/api/v1/buckets?q=${seaweedBucket}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(listed.body.items).toEqual([]);
    });

    it('queues a job for POST /empty rather than doing it inline', async () => {
      const response = await harness
        .http()
        .post(`/api/v1/servers/${MINIO.name}/buckets/${quotaBucket}/empty`)
        .set(auth())
        .send({ includeVersions: true })
        .expect(202);

      expect(response.body).toMatchObject({
        type: 'empty-bucket',
        status: 'queued',
        params: { includeVersions: true },
      });
      expect(response.body.source.bucket).toBe(quotaBucket);
    });
  });

  /* ============================= import URL ============================ */

  describe('importing from a URL', () => {
    let server: HttpServer | null = null;
    let sourceUrl: string | null = null;

    beforeAll(async () => {
      // The guard refuses loopback, so a source on 127.0.0.1 cannot be used. A
      // LAN address on this machine can: it is a private range, which an
      // on-premise install has to be able to import from.
      const host = firstPrivateIpv4();
      if (host === null) return;

      server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '13' });
        response.end('imported body');
      });
      await new Promise<void>((resolve) => server?.listen(0, host, resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') return;
      sourceUrl = `http://${host}:${address.port}/payload.txt`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        if (server === null) return resolve();
        server.close(() => resolve());
      });
    });

    it('fetches the URL server-side and streams it into the bucket', async () => {
      if (sourceUrl === null) {
        // No non-loopback interface on this machine; the refusal path is covered
        // by the e2e suite and the unit tests for the guard.
        return;
      }

      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/import-url`)
        .set(auth())
        .send({ url: sourceUrl, key: 'imported/payload.txt', overwrite: true })
        .expect(201);

      expect(response.body).toMatchObject({ key: 'imported/payload.txt', size: 13 });

      const download = await fetch(
        `${harness.origin}${objectsPath(MINIO.name, minioBucket)}/download?key=${encodeURIComponent('imported/payload.txt')}`,
        { headers: { Cookie: cookie } },
      );
      expect(await download.text()).toBe('imported body');
    });

    it('refuses a URL that resolves to loopback', async () => {
      const response = await harness
        .http()
        .post(`${objectsPath(MINIO.name, minioBucket)}/import-url`)
        .set(auth())
        .send({ url: 'http://localhost:9/x', key: 'nope.txt', overwrite: true })
        .expect(400);
      expect(response.body.detail).toContain('loopback');
    });
  });
});

/* ------------------------------ helpers --------------------------- */

/**
 * A private-range IPv4 on this machine. `import-url` must be reachable from a
 * source that is not loopback, and a private address is exactly what an
 * on-premise install imports from.
 */
function firstPrivateIpv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      return address.address;
    }
  }
  return null;
}
