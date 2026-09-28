import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@storage-io/contracts';
import { createTestApp, type TestHarness } from '../support/test-app';

/**
 * Servers CRUD without touching a real provider: the endpoint here is a closed
 * port, which is a real and important case — a server that cannot be reached
 * must still be saved, because the operator needs the row in order to fix it.
 *
 * The same endpoints against live MinIO and SeaweedFS are in
 * `test/it/servers.it.spec.ts`, behind `S3_IT=1`.
 */
const UNREACHABLE = 'http://127.0.0.1:9';

const serverBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'lab-one',
  provider: 'minio',
  endpoint: UNREACHABLE,
  region: 'us-east-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI-secret-1234',
  options: { pathStyle: true, healthIntervalSec: 60 },
  ...overrides,
});

describe('servers (e2e)', () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
  });

  afterAll(async () => {
    await harness.close();
  });

  const auth = () => ({ Cookie: cookie, Origin: harness.origin });

  describe('POST /servers', () => {
    it('creates a server and never returns the secret', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'create-one' }))
        .expect(201);

      expect(response.body).toMatchObject({
        id: expect.any(String),
        name: 'create-one',
        provider: 'minio',
        endpoint: UNREACHABLE,
        accessKeyId: 'AKIAEXAMPLE',
        // Last four characters only.
        secretMasked: '••••1234',
        maintenance: false,
        tls: false,
      });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('wJalrXUtnFEMI');
      expect(serialized).not.toContain('secretAccessKey');
      expect(serialized).not.toContain('secretEncrypted');
    });

    it('saves an unreachable server as offline rather than refusing it', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'offline-one' }))
        .expect(201);

      expect(response.body.status).toBe('offline');
      expect(response.body.statusDetail).toBeTruthy();
      // The row exists and is fetchable, which is the point.
      await harness.http().get('/api/v1/servers/offline-one').set('Cookie', cookie).expect(200);
    });

    it('returns a complete capability map, every key present', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'caps-one' }))
        .expect(201);

      expect(Object.keys(response.body.capabilities).sort()).toEqual([...CAPABILITIES].sort());
      for (const [name, state] of Object.entries(response.body.capabilities)) {
        expect(['supported', 'not_configured', 'not_supported'], name).toContain(state);
      }
    });

    it('fills in the default options the client omitted', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send({ ...serverBody({ name: 'defaults-one' }), options: {} })
        .expect(201);

      expect(response.body.options).toEqual({
        pathStyle: true,
        tlsVerify: true,
        caPem: null,
        adminEndpoint: null,
        iamEndpoint: null,
        healthIntervalSec: 30,
      });
    });

    it('never echoes a write-only adminToken back', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(
          serverBody({
            name: 'garage-one',
            provider: 'garage',
            options: { adminToken: 'garage-admin-token-value' },
          }),
        )
        .expect(201);

      expect(JSON.stringify(response.body)).not.toContain('garage-admin-token-value');
      expect(response.body.options).not.toHaveProperty('adminToken');
    });

    it('refuses a duplicate name with 409 CONFLICT', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'dup' }))
        .expect(201);
      const clash = await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'dup' }))
        .expect(409);
      expect(clash.body.code).toBe('CONFLICT');
    });

    it('rejects a name that is not a slug, and an unknown provider', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'Not A Slug', provider: 'dropbox' }))
        .expect(400);

      expect(response.body.code).toBe('VALIDATION');
      expect(response.body.errors.map((e: { path: string }) => e.path)).toEqual(
        expect.arrayContaining(['name', 'provider']),
      );
    });

    it('rejects a non-http endpoint', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'bad-scheme', endpoint: 'ftp://example.com' }))
        .expect(400);
    });

    it('rejects a health interval outside the documented range', async () => {
      for (const healthIntervalSec of [1, 5000]) {
        await harness
          .http()
          .post('/api/v1/servers')
          .set(auth())
          .send(serverBody({ name: 'bad-interval', options: { healthIntervalSec } }))
          .expect(400);
      }
    });

    it('strips a trailing slash from the endpoint', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'slashy', endpoint: `${UNREACHABLE}/` }))
        .expect(201);
      expect(response.body.endpoint).toBe(UNREACHABLE);
    });
  });

  describe('GET /servers', () => {
    it('lists with a total, and filters by name, provider and status', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'filter-minio', provider: 'minio' }))
        .expect(201);
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'filter-ceph', provider: 'ceph' }))
        .expect(201);

      const all = await harness.http().get('/api/v1/servers').set('Cookie', cookie).expect(200);
      expect(all.body.total).toBe(all.body.items.length);
      expect(all.body.total).toBeGreaterThanOrEqual(2);

      const byProvider = await harness
        .http()
        .get('/api/v1/servers?provider=ceph')
        .set('Cookie', cookie)
        .expect(200);
      expect(byProvider.body.items.every((s: { provider: string }) => s.provider === 'ceph')).toBe(
        true,
      );

      const byQuery = await harness
        .http()
        .get('/api/v1/servers?q=filter-minio')
        .set('Cookie', cookie)
        .expect(200);
      expect(byQuery.body.items.map((s: { name: string }) => s.name)).toContain('filter-minio');

      const byStatus = await harness
        .http()
        .get('/api/v1/servers?status=offline')
        .set('Cookie', cookie)
        .expect(200);
      expect(byStatus.body.items.every((s: { status: string }) => s.status === 'offline')).toBe(
        true,
      );
    });

    it('rejects an unknown status value instead of ignoring it', async () => {
      await harness.http().get('/api/v1/servers?status=banana').set('Cookie', cookie).expect(400);
    });
  });

  describe('GET /servers/:id', () => {
    it('accepts either the id or the name', async () => {
      const created = await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'by-either' }))
        .expect(201);

      const byName = await harness
        .http()
        .get('/api/v1/servers/by-either')
        .set('Cookie', cookie)
        .expect(200);
      const byId = await harness
        .http()
        .get(`/api/v1/servers/${String(created.body.id)}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(byName.body.id).toBe(created.body.id);
      expect(byId.body.name).toBe('by-either');
    });

    it('is 404 NOT_FOUND for an unknown server', async () => {
      const response = await harness
        .http()
        .get('/api/v1/servers/nope')
        .set('Cookie', cookie)
        .expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /servers/:id', () => {
    it('keeps the stored secret when the body omits it', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'keep-secret' }))
        .expect(201);

      const patched = await harness
        .http()
        .patch('/api/v1/servers/keep-secret')
        .set(auth())
        .send({ region: 'eu-west-1' })
        .expect(200);

      expect(patched.body.region).toBe('eu-west-1');
      // Unchanged mask means the stored secret was not touched.
      expect(patched.body.secretMasked).toBe('••••1234');
    });

    it('replaces the secret when one is supplied', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'new-secret' }))
        .expect(201);

      const patched = await harness
        .http()
        .patch('/api/v1/servers/new-secret')
        .set(auth())
        .send({ secretAccessKey: 'a-completely-different-secret-9876' })
        .expect(200);

      expect(patched.body.secretMasked).toBe('••••9876');
    });

    it('refuses a rename onto an existing name', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'taken-a' }))
        .expect(201);
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'taken-b' }))
        .expect(201);

      const clash = await harness
        .http()
        .patch('/api/v1/servers/taken-b')
        .set(auth())
        .send({ name: 'taken-a' })
        .expect(409);
      expect(clash.body.code).toBe('CONFLICT');
    });

    it('updates one option without clearing the others', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(
          serverBody({ name: 'opt-merge', options: { pathStyle: true, healthIntervalSec: 120 } }),
        )
        .expect(201);

      const patched = await harness
        .http()
        .patch('/api/v1/servers/opt-merge')
        .set(auth())
        .send({ options: { tlsVerify: false } })
        .expect(200);

      expect(patched.body.options.tlsVerify).toBe(false);
      expect(patched.body.options.healthIntervalSec).toBe(120);
    });
  });

  describe('DELETE /servers/:id', () => {
    it('removes the connection and the row is gone afterwards', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'to-remove' }))
        .expect(201);
      await harness.http().delete('/api/v1/servers/to-remove').set(auth()).expect(204);
      await harness.http().get('/api/v1/servers/to-remove').set('Cookie', cookie).expect(404);
    });

    it('is 404 for an unknown server', async () => {
      await harness.http().delete('/api/v1/servers/never-existed').set(auth()).expect(404);
    });
  });

  describe('POST /servers/test', () => {
    it('tests unsaved details and stores nothing', async () => {
      const before = await harness.http().get('/api/v1/servers').set('Cookie', cookie).expect(200);

      const response = await harness
        .http()
        .post('/api/v1/servers/test')
        .set(auth())
        .send(serverBody({ name: 'never-saved' }))
        .expect(201);

      expect(response.body).toMatchObject({
        checks: expect.any(Array),
        capabilities: expect.any(Object),
        version: null,
      });

      const after = await harness.http().get('/api/v1/servers').set('Cookie', cookie).expect(200);
      expect(after.body.total).toBe(before.body.total);
    });

    it('returns the nine documented checks in order, with the later ones skipped', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/test')
        .set(auth())
        .send(serverBody({ name: 'check-order' }))
        .expect(201);

      const ids = response.body.checks.map((c: { id: string }) => c.id);
      expect(ids).toEqual([
        'dns',
        'tcp',
        'tls',
        'auth',
        'listBuckets',
        'admin',
        'versioning',
        'objectLock',
        'replication',
      ]);

      const byId = new Map(
        response.body.checks.map((c: { id: string; status: string; detail: string | null }) => [
          c.id,
          c,
        ]),
      );
      // 127.0.0.1 resolves; port 9 does not accept, so tcp fails and the rest
      // are reported skipped rather than repeating the same timeout nine times.
      expect(byId.get('dns')).toMatchObject({ status: 'ok' });
      expect(byId.get('tcp')).toMatchObject({ status: 'fail' });
      for (const id of ['tls', 'auth', 'listBuckets', 'admin', 'versioning']) {
        expect(byId.get(id), id).toMatchObject({ status: 'skipped' });
      }
    });

    it('fails the dns check for a hostname that does not resolve', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/test')
        .set(auth())
        .send(serverBody({ name: 'bad-dns', endpoint: 'http://no-such-host.invalid:9000' }))
        .expect(201);

      const dns = response.body.checks.find((c: { id: string }) => c.id === 'dns');
      expect(dns.status).toBe('fail');
      expect(response.body.checks.every((c: { status: string }) => c.status !== 'ok')).toBe(true);
    });

    it('every check carries a duration', async () => {
      const response = await harness
        .http()
        .post('/api/v1/servers/test')
        .set(auth())
        .send(serverBody({ name: 'durations' }))
        .expect(201);

      for (const check of response.body.checks) {
        expect(typeof check.durationMs, check.id).toBe('number');
        expect(check.durationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('maintenance, metrics, nodes and events', () => {
    beforeAll(async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'ops-one' }))
        .expect(201);
    });

    it('turns maintenance on and off, and records an event each way', async () => {
      const on = await harness
        .http()
        .put('/api/v1/servers/ops-one/maintenance')
        .set(auth())
        .send({ enabled: true })
        .expect(200);
      expect(on.body).toMatchObject({ maintenance: true, status: 'maintenance' });

      const off = await harness
        .http()
        .put('/api/v1/servers/ops-one/maintenance')
        .set(auth())
        .send({ enabled: false })
        .expect(200);
      expect(off.body.maintenance).toBe(false);
      expect(off.body.status).not.toBe('maintenance');

      const events = await harness
        .http()
        .get('/api/v1/servers/ops-one/events')
        .set('Cookie', cookie)
        .expect(200);
      expect(events.body.items.length).toBeGreaterThanOrEqual(2);
      // Newest first.
      expect(events.body.items[0].detail).toContain('disabled');
    });

    it('rejects a maintenance body that is not { enabled: boolean }', async () => {
      await harness
        .http()
        .put('/api/v1/servers/ops-one/maintenance')
        .set(auth())
        .send({ enabled: 'yes' })
        .expect(400);
    });

    it('returns empty metric series and zero uptime for a server never reached', async () => {
      const response = await harness
        .http()
        .get('/api/v1/servers/ops-one/metrics?range=24h')
        .set('Cookie', cookie)
        .expect(200);

      // `traffic: null` rather than `[]`: this server has never been sampled, and
      // an empty series would draw as a flat line at zero requests per second.
      expect(response.body).toEqual({ capacity: [], latency: [], uptime: 0, traffic: null });
    });

    it('accepts every documented range and rejects anything else', async () => {
      for (const range of ['24h', '7d', '30d']) {
        await harness
          .http()
          .get(`/api/v1/servers/ops-one/metrics?range=${range}`)
          .set('Cookie', cookie)
          .expect(200);
      }
      await harness
        .http()
        .get('/api/v1/servers/ops-one/metrics?range=1y')
        .set('Cookie', cookie)
        .expect(400);
    });

    it('answers NOT_SUPPORTED for nodes on a provider without the capability', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'no-nodes', provider: 'r2' }))
        .expect(201);

      const response = await harness
        .http()
        .get('/api/v1/servers/no-nodes/nodes')
        .set('Cookie', cookie)
        .expect(409);
      expect(response.body.code).toBe('NOT_SUPPORTED');
    });

    it('caps the events limit rather than accepting any number', async () => {
      await harness
        .http()
        .get('/api/v1/servers/ops-one/events?limit=99999')
        .set('Cookie', cookie)
        .expect(400);
    });
  });

  describe('POST /servers/check-all', () => {
    it('is accepted and does not block on the servers', async () => {
      await harness.http().post('/api/v1/servers/check-all').set(auth()).expect(202);
    });

    it('is not shadowed by the :id route', async () => {
      // A GET of a server literally named check-all would be a 404; the POST
      // above must still reach the check-all handler.
      await harness.http().get('/api/v1/servers/check-all').set('Cookie', cookie).expect(404);
    });
  });

  describe('the activity trail', () => {
    it('records a created server, with the secret redacted', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'audited' }))
        .expect(201);

      const activity = await harness
        .http()
        .get('/api/v1/activity?category=servers&pageSize=50')
        .set('Cookie', cookie)
        .expect(200);

      const created = activity.body.items.find(
        (event: { action: string; target: string | null }) =>
          event.action === 'server.create' && event.target === null,
      );
      expect(created).toBeDefined();
      expect(created.result).toBe('success');
      expect(created.actor).toEqual({ type: 'admin', name: 'test-admin' });

      const serialized = JSON.stringify(activity.body);
      expect(serialized).not.toContain('wJalrXUtnFEMI');
      expect(serialized).toContain('[redacted]');
    });

    it('records a failed request as a warning with the contract code', async () => {
      await harness
        .http()
        .post('/api/v1/servers')
        .set(auth())
        .send(serverBody({ name: 'Bad Slug!' }))
        .expect(400);

      const activity = await harness
        .http()
        .get('/api/v1/activity?result=warning&pageSize=50')
        .set('Cookie', cookie)
        .expect(200);

      const failed = activity.body.items.find(
        (event: { details: { errorCode?: string } }) => event.details.errorCode === 'VALIDATION',
      );
      expect(failed).toBeDefined();
      expect(failed.title).toMatch(/^Failed/);
    });
  });
});
