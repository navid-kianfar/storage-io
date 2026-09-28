import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestHarness } from '../support/test-app';

/**
 * The buckets, objects and quotas endpoints against the real application, with no
 * storage server reachable.
 *
 * What this proves is the half that does not need a container: the shapes the
 * contract promises, the auth and CSRF posture, the validation rules, and that a
 * request naming a server that does not exist is a clean `NOT_FOUND` rather than a
 * 500. The behaviour against a real S3 implementation is `test/it/storage.it.spec.ts`.
 */
describe('buckets, objects and quotas (e2e)', () => {
  let harness: TestHarness;
  let cookie: string;

  /**
   * A saved server whose endpoint answers nothing. It exists so the tests below can
   * reach the code *after* `:sid` resolution — a request naming a server that does
   * not exist is a 404 before any of it runs, which is correct but proves nothing
   * about the validation further in.
   */
  const OFFLINE_SERVER = 'e2e-offline';

  beforeAll(async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();

    await harness
      .http()
      .post('/api/v1/servers')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({
        name: OFFLINE_SERVER,
        provider: 'generic',
        // Reserved by RFC 5737 for documentation: nothing answers here.
        endpoint: 'http://192.0.2.1:9000',
        region: 'us-east-1',
        accessKeyId: 'unused',
        secretAccessKey: 'unused-secret',
        options: { pathStyle: true, healthIntervalSec: 3600 },
      })
      .expect(201);
  });

  afterAll(async () => {
    await harness.close();
  });

  const auth = () => ({ Cookie: cookie, Origin: harness.origin });

  describe('GET /buckets', () => {
    it('answers with an empty list and a zeroed summary when nothing is cached', async () => {
      const response = await harness
        .http()
        .get('/api/v1/buckets')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body).toEqual({
        items: [],
        total: 0,
        summary: { buckets: 0, sizeBytes: 0, objects: 0, withQuota: 0, nearQuota: 0, public: 0 },
      });
    });

    it('requires authentication', async () => {
      const response = await harness.http().get('/api/v1/buckets').expect(401);
      expect(response.body.code).toBe('AUTH_INVALID');
    });

    it('rejects a sort it does not know', async () => {
      const response = await harness
        .http()
        .get('/api/v1/buckets?sort=colour')
        .set('Cookie', cookie)
        .expect(400);
      expect(response.body.code).toBe('VALIDATION');
    });

    it('rejects a page size above the documented maximum', async () => {
      await harness.http().get('/api/v1/buckets?pageSize=5000').set('Cookie', cookie).expect(400);
    });

    it('reports NOT_FOUND for a serverId that does not exist', async () => {
      const response = await harness
        .http()
        .get('/api/v1/buckets?serverId=nope')
        .set('Cookie', cookie)
        .expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /buckets/export.csv', () => {
    it('streams a CSV with the documented header row', async () => {
      const response = await harness
        .http()
        .get('/api/v1/buckets/export.csv')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toContain('buckets-');
      // The BOM is what makes Excel read non-ASCII bucket names correctly.
      expect(response.text.startsWith('﻿')).toBe(true);
      expect(response.text).toContain('server,provider,bucket');
    });

    it('is declared before :bucket, so the literal path is not read as a name', async () => {
      // A route-order regression shows up here as a 404 from the detail handler.
      await harness.http().get('/api/v1/buckets/export.csv').set('Cookie', cookie).expect(200);
    });
  });

  describe('GET /quotas', () => {
    it('answers with an empty list and a zeroed summary', async () => {
      const response = await harness.http().get('/api/v1/quotas').set('Cookie', cookie).expect(200);

      expect(response.body).toEqual({
        items: [],
        total: 0,
        summary: { withQuota: 0, over90: 0, over80: 0, unlimited: 0 },
      });
    });

    it('accepts each documented filter', async () => {
      for (const filter of ['all', 'near', 'unlimited']) {
        await harness
          .http()
          .get(`/api/v1/quotas?filter=${filter}`)
          .set('Cookie', cookie)
          .expect(200);
      }
    });

    it('rejects a filter it does not know', async () => {
      await harness.http().get('/api/v1/quotas?filter=huge').set('Cookie', cookie).expect(400);
    });

    it('exports CSV with the documented header row', async () => {
      const response = await harness
        .http()
        .get('/api/v1/quotas/export.csv')
        .set('Cookie', cookie)
        .expect(200);
      expect(response.text).toContain('server,provider,bucket,limitBytes');
    });
  });

  describe('bucket creation', () => {
    it('rejects a name S3 would not accept, before any server is contacted', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/anything/buckets')
        .set(auth())
        .send({
          name: 'Not_A_Valid_Name',
          versioning: false,
          objectLock: false,
          quota: null,
          access: 'private',
        })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION');
      expect(JSON.stringify(response.body.errors)).toContain('name');
    });

    it('rejects a request that omits a required field', async () => {
      await harness
        .http()
        .post('/api/v1/servers/anything/buckets')
        .set(auth())
        .send({ name: 'valid-name' })
        .expect(400);
    });

    it('will not accept `custom` as a requested access level', async () => {
      // `custom` is derived from whatever policy is in place; asking for it is
      // meaningless, so the contract does not allow it.
      await harness
        .http()
        .post('/api/v1/servers/anything/buckets')
        .set(auth())
        .send({
          name: 'valid-name',
          versioning: false,
          objectLock: false,
          quota: null,
          access: 'custom',
        })
        .expect(400);
    });

    it('reports NOT_FOUND for a server that does not exist', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/ghost/buckets')
        .set(auth())
        .send({
          name: 'valid-name',
          versioning: false,
          objectLock: false,
          quota: null,
          access: 'private',
        })
        .expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('refuses a cookie-authenticated mutation from another origin', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/ghost/buckets')
        .set({ Cookie: cookie, Origin: 'https://evil.example.com' })
        .send({
          name: 'valid-name',
          versioning: false,
          objectLock: false,
          quota: null,
          access: 'private',
        })
        .expect(403);
      expect(response.body.code).toBe('FORBIDDEN');
    });
  });

  describe('POST /buckets/bulk', () => {
    it('validates the payload against the action it was sent with', async () => {
      // The discriminated union is the point: a lifecycle rule must not be
      // accepted down the quota path.
      const response = await harness
        .http()
        .post('/api/v1/buckets/bulk')
        .set(auth())
        .send({
          buckets: [{ serverId: 'srv', bucket: 'b' }],
          action: 'quota',
          payload: { id: 'a-lifecycle-rule', enabled: true },
        })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION');
    });

    it('requires at least one bucket', async () => {
      await harness
        .http()
        .post('/api/v1/buckets/bulk')
        .set(auth())
        .send({ buckets: [], action: 'access', payload: { access: 'private' } })
        .expect(400);
    });

    it('reports a per-bucket failure as a row rather than failing the request', async () => {
      const response = await harness
        .http()
        .post('/api/v1/buckets/bulk')
        .set(auth())
        .send({
          buckets: [{ serverId: 'ghost', bucket: 'b' }],
          action: 'access',
          payload: { access: 'private' },
        })
        .expect(201);

      expect(response.body.results).toHaveLength(1);
      expect(response.body.results[0].ok).toBe(false);
      expect(response.body.results[0].message).toContain('NOT_FOUND');
    });
  });

  describe('objects', () => {
    const path = '/api/v1/servers/ghost/buckets/b/objects';

    it('requires a key on the endpoints that act on one object', async () => {
      await harness.http().get(`${path}/meta`).set('Cookie', cookie).expect(400);
      await harness.http().get(`${path}/versions`).set('Cookie', cookie).expect(400);
      await harness.http().get(`${path}/download`).set('Cookie', cookie).expect(400);
    });

    it('rejects a presign expiry outside the documented bounds', async () => {
      for (const expiresInSeconds of [30, 604_801]) {
        await harness
          .http()
          .post(`${path}/presign`)
          .set(auth())
          .send({ key: 'a.txt', expiresInSeconds, download: false })
          .expect(400);
      }
    });

    it('rejects a list limit above the documented maximum', async () => {
      await harness.http().get(`${path}?limit=5000`).set('Cookie', cookie).expect(400);
    });

    it('rejects a cursor it did not issue', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${OFFLINE_SERVER}/buckets/b/objects?cursor=not-ours`)
        .set('Cookie', cookie)
        .expect(400);
      expect(response.body.code).toBe('VALIDATION');
    });

    it('rejects an import URL that is not http or https', async () => {
      await harness
        .http()
        .post(`${path}/import-url`)
        .set(auth())
        .send({ url: 'file:///etc/passwd', key: 'a.txt', overwrite: true })
        .expect(400);
    });

    it('refuses an import URL that resolves to loopback', async () => {
      // The guard runs before the fetch, so nothing is ever requested from :9.
      const response = await harness
        .http()
        .post(`/api/v1/servers/${OFFLINE_SERVER}/buckets/b/objects/import-url`)
        .set(auth())
        .send({ url: 'http://127.0.0.1:9/x', key: 'a.txt', overwrite: true })
        .expect(400);
      expect(response.body.detail).toContain('loopback');
    });

    it('accepts either half of the retention union and nothing else', async () => {
      // Both shapes reach the service (and fail on the missing server, 404); a
      // third shape is rejected by validation (400).
      await harness
        .http()
        .put(`${path}/retention?key=a.txt`)
        .set(auth())
        .send({ legalHold: true })
        .expect(404);
      await harness
        .http()
        .put(`${path}/retention?key=a.txt`)
        .set(auth())
        .send({ mode: 'GOVERNANCE', until: new Date(Date.now() + 86_400_000).toISOString() })
        .expect(404);
      await harness
        .http()
        .put(`${path}/retention?key=a.txt`)
        .set(auth())
        .send({ mode: 'WHENEVER' })
        .expect(400);
    });

    it('rejects a batch with no keys, or more than the documented maximum', async () => {
      await harness
        .http()
        .post(`${path}/batch`)
        .set(auth())
        .send({ keys: [], action: 'tags', payload: { tags: {} } })
        .expect(400);

      await harness
        .http()
        .post(`${path}/batch`)
        .set(auth())
        .send({
          keys: Array.from({ length: 1001 }, (_, index) => `k${index}.txt`),
          action: 'tags',
          payload: { tags: {} },
        })
        .expect(400);
    });

    it('rejects a batch payload that does not match its action', async () => {
      // The discriminated union is the point: a storage class must not reach the
      // tag path, and a tag set must not reach the retention path.
      await harness
        .http()
        .post(`${path}/batch`)
        .set(auth())
        .send({ keys: ['a.txt'], action: 'retention', payload: { tags: {} } })
        .expect(400);
    });

    it('rejects a batch action it does not know', async () => {
      await harness
        .http()
        .post(`${path}/batch`)
        .set(auth())
        .send({ keys: ['a.txt'], action: 'delete', payload: {} })
        .expect(400);
    });

    it('rejects a multipart start with no key', async () => {
      await harness
        .http()
        .post(`${path}/multipart`)
        .set(auth())
        .send({ contentType: null, metadata: {}, tags: {}, storageClass: null })
        .expect(400);
    });

    it('requires the key on every multipart part route', async () => {
      await harness
        .http()
        .get(`${path}/multipart/some-upload-id`)
        .set('Cookie', cookie)
        .expect(400);
      await harness
        .http()
        .post(`${path}/multipart/some-upload-id/complete`)
        .set(auth())
        .send({ parts: [{ partNumber: 1, etag: 'abc' }] })
        .expect(400);
    });

    it('rejects a completion with no parts', async () => {
      await harness
        .http()
        .post(`${path}/multipart/some-upload-id/complete?key=a.txt`)
        .set(auth())
        .send({ parts: [] })
        .expect(400);
    });

    it('refuses a part upload that declares no length', async () => {
      // S3 signs a part against a declared length, so a chunked body cannot be a
      // part; saying so here is clearer than the provider's own rejection.
      const response = await harness
        .http()
        .put(`/api/v1/servers/${OFFLINE_SERVER}/buckets/b/objects/multipart/up-1/parts/1?key=a.txt`)
        .set({ ...auth(), 'Transfer-Encoding': 'chunked' })
        .send('some bytes');
      expect([400, 503]).toContain(response.status);
    });

    it('rejects an archive listing with no key, or a limit over the maximum', async () => {
      await harness.http().get(`${path}/archive-entries`).set('Cookie', cookie).expect(400);
      await harness
        .http()
        .get(`${path}/archive-entries?key=a.zip&limit=99999`)
        .set('Cookie', cookie)
        .expect(400);
    });

    it('rejects a rename onto the same key', async () => {
      const response = await harness
        .http()
        .post(`${path}/rename`)
        .set(auth())
        .send({ key: 'a.txt', newKey: 'a.txt' })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION');
    });
  });
});
