import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestHarness } from '../support/test-app';
import { IT_ENABLED, MINIO, SEAWEEDFS, assertContainersUp } from './containers';

/**
 * The servers module against the real MinIO and SeaweedFS containers.
 *
 * The e2e suite proves the shapes and the failure paths with an unreachable
 * endpoint. These prove the parts only a real server can: that the connection
 * test actually succeeds, that capability detection tells the two providers
 * apart, that MinIO's admin API yields a version and nodes and drives, and that
 * a secret survives a database round trip well enough to authenticate again.
 */
describe.skipIf(!IT_ENABLED)('servers against live containers', () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    await assertContainersUp();
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
  });

  afterAll(async () => {
    await harness.close();
  });

  const auth = () => ({ Cookie: cookie, Origin: harness.origin });

  describe('MinIO', () => {
    beforeAll(async () => {
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
    });

    it('comes up healthy with the version read from the admin API', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.status).toBe('healthy');
      expect(response.body.statusDetail).toBeNull();
      // MinIO's version is a release timestamp, reported per node.
      expect(response.body.version).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(response.body.counts.buckets).toBeGreaterThanOrEqual(0);
    });

    it('passes every connection check, including the admin API', async () => {
      const response = await harness
        .http()
        .post(`/api/v1/servers/${MINIO.name}/test`)
        .set(auth())
        .expect(201);

      const byId = new Map(
        response.body.checks.map((c: { id: string; status: string; detail: string | null }) => [
          c.id,
          c,
        ]),
      );

      expect(byId.get('dns')).toMatchObject({ status: 'ok' });
      expect(byId.get('tcp')).toMatchObject({ status: 'ok' });
      expect(byId.get('auth')).toMatchObject({ status: 'ok' });
      expect(byId.get('listBuckets')).toMatchObject({ status: 'ok' });
      expect(byId.get('admin')).toMatchObject({ status: 'ok' });
      // Plain HTTP, so TLS is honestly skipped rather than reported ok.
      expect(byId.get('tls')).toMatchObject({ status: 'skipped' });
      expect(response.body.version).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('detects the admin-only capabilities as supported', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}`)
        .set('Cookie', cookie)
        .expect(200);

      const { capabilities } = response.body;
      for (const capability of [
        'iamUsers',
        'iamGroups',
        'iamPolicies',
        'accessKeys',
        'accessKeyExpiry',
        'bucketQuota',
        'usageStats',
        'nodes',
      ]) {
        expect(capabilities[capability], capability).toBe('supported');
      }
      expect(capabilities.objects).toBe('supported');
    });

    it('lists nodes and their drives from the admin API', async () => {
      const nodes = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/nodes`)
        .set('Cookie', cookie)
        .expect(200);

      expect(nodes.body.items.length).toBeGreaterThanOrEqual(1);
      const node = nodes.body.items[0];
      expect(node).toMatchObject({
        name: expect.any(String),
        state: 'online',
        drivesTotal: expect.any(Number),
        drivesOnline: expect.any(Number),
      });
      expect(node.drivesTotal).toBeGreaterThan(0);
      expect(node.usedBytes).toBeGreaterThan(0);
      expect(node.totalBytes).toBeGreaterThan(0);

      const drives = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/nodes/${encodeURIComponent(String(node.name))}/drives`)
        .set('Cookie', cookie)
        .expect(200);

      expect(drives.body.items).toHaveLength(node.drivesTotal);
      expect(drives.body.items[0]).toMatchObject({
        path: expect.any(String),
        state: 'ok',
        healing: false,
      });
    });

    it('is 404 for a node that is not in the deployment', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/nodes/not-a-node/drives`)
        .set('Cookie', cookie)
        .expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('never leaks the admin info payload, which carries MINIO_ROOT_PASSWORD', async () => {
      // /minio/admin/v3/info includes minio_env_vars. Nothing is passed through
      // unmapped, and this is what keeps it that way.
      const nodes = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/nodes`)
        .set('Cookie', cookie)
        .expect(200);

      const serialized = JSON.stringify(nodes.body);
      expect(serialized).not.toContain('minio_env_vars');
      expect(serialized).not.toContain('MINIO_ROOT_PASSWORD');
      expect(serialized).not.toContain(MINIO.secretAccessKey);
    });

    it('records latency and a capacity snapshot after a health check', async () => {
      await harness.http().post(`/api/v1/servers/${MINIO.name}/check`).set(auth()).expect(201);

      const metrics = await harness
        .http()
        .get(`/api/v1/servers/${MINIO.name}/metrics?range=24h`)
        .set('Cookie', cookie)
        .expect(200);

      expect(metrics.body.latency.length).toBeGreaterThanOrEqual(1);
      expect(metrics.body.latency[0].ms).toBeGreaterThanOrEqual(0);
      expect(metrics.body.uptime).toBe(1);
      // Capacity comes from the admin API's drive totals.
      expect(metrics.body.capacity.length).toBeGreaterThanOrEqual(1);
      expect(metrics.body.capacity[0].usedBytes).toBeGreaterThan(0);
    });

    it('the stored secret still authenticates after a database round trip', async () => {
      // Every call above re-read the encrypted secret and decrypted it; a test
      // that signs successfully is the proof the round trip is lossless.
      const response = await harness
        .http()
        .post(`/api/v1/servers/${MINIO.name}/test`)
        .set(auth())
        .expect(201);
      const auth_ = response.body.checks.find((c: { id: string }) => c.id === 'auth');
      expect(auth_.status).toBe('ok');
    });

    it('a wrong secret is reported as a failed auth check, not a crash', async () => {
      await harness
        .http()
        .patch(`/api/v1/servers/${MINIO.name}`)
        .set(auth())
        .send({ secretAccessKey: 'definitely-the-wrong-secret' })
        .expect(200);

      const response = await harness
        .http()
        .post(`/api/v1/servers/${MINIO.name}/test`)
        .set(auth())
        .expect(201);

      const byId = new Map(
        response.body.checks.map((c: { id: string; status: string }) => [c.id, c]),
      );
      expect(byId.get('tcp')).toMatchObject({ status: 'ok' });
      expect(byId.get('auth')).toMatchObject({ status: 'fail' });
      expect(byId.get('listBuckets')).toMatchObject({ status: 'skipped' });

      // Put it back so the ordering of tests does not matter.
      await harness
        .http()
        .patch(`/api/v1/servers/${MINIO.name}`)
        .set(auth())
        .send({ secretAccessKey: MINIO.secretAccessKey })
        .expect(200);
    });
  });

  describe('SeaweedFS', () => {
    beforeAll(async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send({
          name: SEAWEEDFS.name,
          provider: SEAWEEDFS.provider,
          endpoint: SEAWEEDFS.endpoint,
          region: SEAWEEDFS.region,
          accessKeyId: SEAWEEDFS.accessKeyId,
          secretAccessKey: SEAWEEDFS.secretAccessKey,
          options: {
            pathStyle: true,
            iamEndpoint: SEAWEEDFS.iamEndpoint,
            healthIntervalSec: 3600,
          },
        })
        .expect(201);
    });

    it('comes up healthy over plain S3', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${SEAWEEDFS.name}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.status).toBe('healthy');
      expect(response.body.provider).toBe('seaweedfs');
      // No admin API driver yet, so no version — reported honestly as null.
      expect(response.body.version).toBeNull();
    });

    it('passes the S3 checks and reaches the IAM API', async () => {
      const response = await harness
        .http()
        .post(`/api/v1/servers/${SEAWEEDFS.name}/test`)
        .set(auth())
        .expect(201);

      const byId = new Map(
        response.body.checks.map((c: { id: string; status: string; detail: string | null }) => [
          c.id,
          c,
        ]),
      );
      expect(byId.get('auth')).toMatchObject({ status: 'ok' });
      expect(byId.get('listBuckets')).toMatchObject({ status: 'ok' });
      // Backend wave 2b added the aws-iam driver, and the dev container runs with
      // `-iam` on :8111, so the admin row is now a real reachability check rather
      // than the skip it was when no driver existed.
      expect(byId.get('admin')).toMatchObject({ status: 'ok', label: 'SeaweedFS IAM API' });
    });

    it('reports what SeaweedFS can and cannot do, once the IAM API answers', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${SEAWEEDFS.name}`)
        .set('Cookie', cookie)
        .expect(200);

      const { capabilities } = response.body;
      expect(capabilities.objects).toBe('supported');
      // The IAM endpoint is configured and answers, so users and keys are real.
      expect(capabilities.iamUsers).toBe('supported');
      expect(capabilities.accessKeys).toBe('supported');
      // And these stay a permanent no: verified against chrislusf/seaweedfs:3.97,
      // every group call and ListPolicies answer HTTP 501, and a key cannot be
      // deactivated — a reachable endpoint does not change any of that.
      expect(capabilities.iamGroups).toBe('not_supported');
      expect(capabilities.iamPolicies).toBe('not_supported');
      expect(capabilities.nodes).toBe('not_supported');
    });

    it('answers NOT_SUPPORTED for nodes', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/servers/${SEAWEEDFS.name}/nodes`)
        .set('Cookie', cookie)
        .expect(409);
      expect(response.body.code).toBe('NOT_SUPPORTED');
    });
  });

  describe('both servers together', () => {
    it('lists them both, and the aggregate total is right', async () => {
      const response = await harness
        .http()
        .get('/api/v1/servers')
        .set('Cookie', cookie)
        .expect(200);
      const names = response.body.items.map((server: { name: string }) => server.name);
      expect(names).toContain(MINIO.name);
      expect(names).toContain(SEAWEEDFS.name);
      expect(response.body.total).toBe(response.body.items.length);
    });

    it('filters by provider across live servers', async () => {
      const response = await harness
        .http()
        .get('/api/v1/servers?provider=minio')
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body.items.map((s: { name: string }) => s.name)).toEqual([MINIO.name]);
    });

    it('check-all leaves both healthy', async () => {
      await harness.http().post('/api/v1/servers/check-all').set(auth()).expect(202);
      // check-all is fire-and-forget by design; poll rather than sleep blindly.
      const deadline = Date.now() + 20_000;
      for (;;) {
        const response = await harness
          .http()
          .get('/api/v1/servers')
          .set('Cookie', cookie)
          .expect(200);
        const liveNames: readonly string[] = [MINIO.name, SEAWEEDFS.name];
        const live = response.body.items.filter((s: { name: string }) =>
          liveNames.includes(s.name),
        );
        if (live.every((s: { status: string }) => s.status === 'healthy')) {
          expect(live).toHaveLength(2);
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(`check-all did not settle: ${JSON.stringify(live)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });

    it('deleting a server releases it and leaves the other working', async () => {
      await harness.http().delete(`/api/v1/servers/${SEAWEEDFS.name}`).set(auth()).expect(204);
      await harness
        .http()
        .get(`/api/v1/servers/${SEAWEEDFS.name}`)
        .set('Cookie', cookie)
        .expect(404);
      await harness.http().get(`/api/v1/servers/${MINIO.name}`).set('Cookie', cookie).expect(200);
    });
  });
});
