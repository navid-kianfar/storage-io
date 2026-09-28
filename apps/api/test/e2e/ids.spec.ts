import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUCKET_CSV_COLUMNS,
  JOB_FILTER_DEFAULTS,
  JOB_SELECTION_MAX_KEYS,
  type Job,
} from '@storage-io/contracts';
import { InventoryRepository } from '../../src/modules/inventory/inventory.repository';
import { createTestApp, type TestHarness } from '../support/test-app';

/**
 * The opaque-id surface: the resolve endpoints, the route order that keeps their
 * literal siblings reachable, the two IAM bulk endpoints and the explicit
 * selection a job can be created from.
 *
 * No storage server is reachable here, which is exactly right for what these
 * prove: an id that names nothing must be a clean 404, a bulk request must answer
 * 200 with a row per target however the targets were addressed, and a literal
 * path must never be read as an id. The behaviour against a real server is
 * `test/it/iam.it.spec.ts` and `test/it/storage.it.spec.ts`.
 */

const SERVER = 'ids-lab';
/**
 * A closed port on the loopback: the connection is refused at once rather than
 * timing out, which keeps a suite full of deliberately failing calls fast.
 */
const UNREACHABLE = 'http://127.0.0.1:9';

describe('opaque ids, resolve endpoints and bulk (e2e)', () => {
  let harness: TestHarness;
  let cookie: string;
  let serverId: string;
  let inventory: InventoryRepository;

  beforeAll(async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
    inventory = harness.app.get(InventoryRepository);

    const created = await harness
      .http()
      .post('/api/v1/servers')
      .set({ Cookie: cookie, Origin: harness.origin })
      .send({
        name: SERVER,
        provider: 'minio',
        endpoint: UNREACHABLE,
        region: 'us-east-1',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI-secret-1234',
        options: { pathStyle: true, healthIntervalSec: 3600 },
      })
      .expect(201);
    serverId = created.body.id as string;
  });

  afterAll(async () => {
    await harness.close();
  });

  const auth = () => ({ Cookie: cookie, Origin: harness.origin });

  /* ------------------------------ buckets --------------------------- */

  describe('GET /buckets/:bucketId', () => {
    it('answers NOT_FOUND for an id that names nothing', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/buckets/${randomUUID()}`)
        .set('Cookie', cookie)
        .expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('requires authentication', async () => {
      await harness.http().get(`/api/v1/buckets/${randomUUID()}`).expect(401);
    });

    it('does not shadow the literal routes declared above it', async () => {
      // A route-order regression shows up here as a 404 from the resolve handler.
      await harness.http().get('/api/v1/buckets/export.csv').set('Cookie', cookie).expect(200);
    });

    /**
     * The server is unreachable, so this is the fallback path: the cached row is
     * served rather than a 502, because a settings page is still worth showing
     * during an outage and `unavailable` is how it says so.
     */
    it('falls back to the cache when the bucket lives on an unreachable server', async () => {
      inventory.upsert(serverId, [{ name: 'cached-bucket', sizeBytes: 42, objects: 1 }]);
      const bucketId = inventory.idOf(serverId, 'cached-bucket');
      expect(bucketId).toEqual(expect.any(String));

      const response = await harness
        .http()
        .get(`/api/v1/buckets/${bucketId as string}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body).toMatchObject({
        id: bucketId,
        serverId,
        name: 'cached-bucket',
        sizeBytes: 42,
      });
    });

    it('carries the same id in the list, the CSV export and a second list', async () => {
      inventory.upsert(serverId, [{ name: 'listed-bucket' }]);

      const first = await harness.http().get('/api/v1/buckets').set('Cookie', cookie).expect(200);
      const second = await harness.http().get('/api/v1/buckets').set('Cookie', cookie).expect(200);

      const find = (body: { items: { name: string; id: string }[] }): string | undefined =>
        body.items.find((item) => item.name === 'listed-bucket')?.id;

      const id = find(first.body);
      expect(id).toEqual(expect.any(String));
      expect(find(second.body)).toBe(id);

      const csv = await harness
        .http()
        .get('/api/v1/buckets/export.csv')
        .set('Cookie', cookie)
        .expect(200);
      expect(csv.text).toContain(BUCKET_CSV_COLUMNS.join(','));
      expect(csv.text).toContain(id as string);
    });

    it('reports the bucket id on every row of a bulk result', async () => {
      inventory.upsert(serverId, [{ name: 'bulk-bucket' }]);
      const bucketId = inventory.idOf(serverId, 'bulk-bucket');

      const response = await harness
        .http()
        .post('/api/v1/buckets/bulk')
        .set(auth())
        .send({
          buckets: [{ serverId, bucket: 'bulk-bucket' }],
          action: 'tags',
          payload: { tags: { team: 'ops' } },
        })
        .expect(201);

      // The server is unreachable, so the row fails — and still names the bucket
      // the caller navigated by.
      expect(response.body.results).toHaveLength(1);
      expect(response.body.results[0]).toMatchObject({
        id: bucketId,
        serverId,
        bucket: 'bulk-bucket',
        ok: false,
      });
    });
  });

  /* -------------------------------- IAM ----------------------------- */

  describe('IAM resolve endpoints', () => {
    const unknownId = (): string => randomUUID();

    it('answers NOT_FOUND for a user id that names nothing', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/iam/users/${unknownId()}`)
        .set('Cookie', cookie)
        .expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('answers NOT_FOUND for a group, policy and access-key id alike', async () => {
      for (const path of ['groups', 'policies', 'access-keys']) {
        const response = await harness
          .http()
          .get(`/api/v1/iam/${path}/${unknownId()}`)
          .set('Cookie', cookie)
          .expect(404);
        expect(response.body.code, path).toBe('NOT_FOUND');
      }
    });

    it('leaves the literal paths above them reachable', async () => {
      await harness.http().get('/api/v1/iam/users/export.csv').set('Cookie', cookie).expect(200);
      await harness
        .http()
        .get('/api/v1/iam/access-keys/export.csv')
        .set('Cookie', cookie)
        .expect(200);
      await harness
        .http()
        .post('/api/v1/iam/policies/validate')
        .set(auth())
        .send({ document: { Version: '2012-10-17', Statement: [] } })
        .expect(201);
    });

    it('requires authentication', async () => {
      await harness.http().get(`/api/v1/iam/users/${unknownId()}`).expect(401);
    });
  });

  /* ------------------------------- bulk ----------------------------- */

  describe('POST /iam/users/bulk', () => {
    it('refuses a request that names no targets at all', async () => {
      const response = await harness
        .http()
        .post('/api/v1/iam/users/bulk')
        .set(auth())
        .send({ ids: [], action: 'disable' })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION');
    });

    it('refuses attach-policy without the policy it would attach', async () => {
      await harness
        .http()
        .post('/api/v1/iam/users/bulk')
        .set(auth())
        .send({ users: [{ serverId, name: 'alice' }], action: 'attach-policy' })
        .expect(400);
    });

    it('refuses an action it does not know', async () => {
      await harness
        .http()
        .post('/api/v1/iam/users/bulk')
        .set(auth())
        .send({ users: [{ serverId, name: 'alice' }], action: 'promote' })
        .expect(400);
    });

    it('answers 200 with a per-row result, never a 4xx for a partial failure', async () => {
      const orphan = randomUUID();
      const response = await harness
        .http()
        .post('/api/v1/iam/users/bulk')
        .set(auth())
        .send({
          ids: [orphan],
          users: [{ serverId, name: 'alice' }],
          action: 'disable',
        })
        .expect(201);

      expect(response.body.results).toHaveLength(2);
      // An id nothing was ever issued for: a row, not a failed request.
      expect(response.body.results[0]).toEqual({
        id: orphan,
        serverId: null,
        name: null,
        ok: false,
        message: 'NOT_FOUND: no such user.',
      });
      // A real reference on an unreachable server: a row with a mapped code.
      expect(response.body.results[1]).toMatchObject({ serverId, name: 'alice', ok: false });
      expect(response.body.results[1].message).toEqual(expect.any(String));
      expect(response.body.results[1].message).not.toContain('127.0.0.1');
    });

    it('is a cookie mutation, so it needs a matching Origin', async () => {
      await harness
        .http()
        .post('/api/v1/iam/users/bulk')
        .set({ Cookie: cookie, Origin: 'https://elsewhere.example' })
        .send({ users: [{ serverId, name: 'alice' }], action: 'disable' })
        .expect(403);
    });
  });

  describe('POST /iam/access-keys/bulk', () => {
    it('refuses a request that names no targets', async () => {
      await harness
        .http()
        .post('/api/v1/iam/access-keys/bulk')
        .set(auth())
        .send({ action: 'disable' })
        .expect(400);
    });

    it('answers 200 with a per-row result', async () => {
      const orphan = randomUUID();
      const response = await harness
        .http()
        .post('/api/v1/iam/access-keys/bulk')
        .set(auth())
        .send({
          ids: [orphan],
          keys: [{ serverId, accessKeyId: 'AKIA0000000000000001' }],
          action: 'delete',
        })
        .expect(201);

      expect(response.body.results).toHaveLength(2);
      expect(response.body.results[0]).toEqual({
        id: orphan,
        serverId: null,
        accessKeyId: null,
        ok: false,
        message: 'NOT_FOUND: no such access key.',
      });
      expect(response.body.results[1]).toMatchObject({
        serverId,
        accessKeyId: 'AKIA0000000000000001',
        ok: false,
      });
    });

    it('does not shadow the literal export path', async () => {
      await harness
        .http()
        .get('/api/v1/iam/access-keys/export.csv')
        .set('Cookie', cookie)
        .expect(200);
    });
  });

  /* ------------------------------ search ---------------------------- */

  describe('GET /search', () => {
    it('links to a bucket by its id and carries no status for it', async () => {
      inventory.upsert(serverId, [{ name: 'searchable-bucket' }]);
      const bucketId = inventory.idOf(serverId, 'searchable-bucket');

      const response = await harness
        .http()
        .get('/api/v1/search?q=searchable-bucket')
        .set('Cookie', cookie)
        .expect(200);

      const bucket = (response.body.items as { type: string; href: string; id: string }[]).find(
        (item) => item.type === 'bucket',
      );
      expect(bucket).toMatchObject({ id: bucketId, href: `/buckets/${bucketId as string}` });
      expect(bucket).toHaveProperty('status', null);
    });

    it('links to a job by its id and badges its status', async () => {
      const created = await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send({
          name: 'searchable-job',
          type: 'delete',
          source: { serverId, bucket: 'photos', filters: { ...JOB_FILTER_DEFAULTS } },
          params: {},
          options: { conflict: 'overwrite', concurrency: 4, dryRun: false },
          schedule: { kind: 'now' },
        })
        .expect(201);
      const job = created.body as Job;

      const response = await harness
        .http()
        .get('/api/v1/search?q=searchable-job')
        .set('Cookie', cookie)
        .expect(200);

      const found = (response.body.items as { type: string; href: string; status: string }[]).find(
        (item) => item.type === 'job',
      );
      expect(found).toMatchObject({ href: `/jobs/${job.id}`, status: job.status });
    });

    it('never puts a name or a query string in an href', async () => {
      const response = await harness
        .http()
        .get('/api/v1/search?q=searchable')
        .set('Cookie', cookie)
        .expect(200);

      for (const item of response.body.items as { href: string }[]) {
        expect(item.href).not.toContain('?');
        expect(item.href).not.toContain(SERVER);
      }
    });
  });

  /* ------------------------ a job from a selection ------------------- */

  describe('POST /jobs with an explicit selection', () => {
    const jobBody = (source: Record<string, unknown>) => ({
      type: 'delete',
      source: { serverId, bucket: 'photos', filters: { ...JOB_FILTER_DEFAULTS }, ...source },
      params: {},
      options: { conflict: 'overwrite', concurrency: 4, dryRun: false },
      schedule: { kind: 'now' },
    });

    it('reports the selection as a count and the prefixes in full', async () => {
      const response = await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send(jobBody({ keys: ['a.txt', 'b.txt', 'c.txt'], prefixes: ['logs/', 'tmp/'] }))
        .expect(201);

      const job = response.body as Job;
      expect(job.source.keyCount).toBe(3);
      expect(job.source.prefixes).toEqual(['logs/', 'tmp/']);
      // The keys themselves never come back: a selection can be thousands.
      expect(JSON.stringify(job)).not.toContain('a.txt');
    });

    it('reads back the same counts on GET, so they survive the round trip', async () => {
      const created = await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send(jobBody({ keys: ['one', 'two'] }))
        .expect(201);

      const fetched = await harness
        .http()
        .get(`/api/v1/jobs/${(created.body as Job).id}`)
        .set('Cookie', cookie)
        .expect(200);

      expect((fetched.body as Job).source.keyCount).toBe(2);
      expect((fetched.body as Job).source.prefixes).toEqual([]);
    });

    it('leaves keyCount null for a job defined by its filters alone', async () => {
      const response = await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send(jobBody({}))
        .expect(201);

      expect((response.body as Job).source.keyCount).toBeNull();
      expect((response.body as Job).source.prefixes).toEqual([]);
    });

    it('refuses a selection larger than the documented bound', async () => {
      const keys = Array.from({ length: JOB_SELECTION_MAX_KEYS + 1 }, (_, index) => `k${index}`);
      const response = await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send(jobBody({ keys }))
        .expect(400);
      expect(response.body.code).toBe('VALIDATION');
    });
  });
});
