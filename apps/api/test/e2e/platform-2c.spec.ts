import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DASHBOARD_JOB_COUNT,
  JOB_FILTER_DEFAULTS,
  dashboardSchema,
  searchResponseSchema,
} from '@storage-io/contracts';
import { createTestApp, type TestHarness } from '../support/test-app';

/**
 * The three endpoints wave 2c added on top of what every other module owns —
 * `/dashboard`, `/search` and the configuration archive — plus activity syslog
 * forwarding.
 *
 * None of them needs a storage server: the dashboard reads local tables by design,
 * search's live half degrades to nothing when no server answers, and the archive is
 * pure crypto. That is the point of each of them and it is what these assertions
 * are about.
 */

const UNREACHABLE = 'http://127.0.0.1:9';
const SERVER = 'platform-lab';
const PASSPHRASE = 'export-passphrase-1234';

describe('dashboard, search, config backup and syslog (e2e)', () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();

    await harness
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
  });

  afterAll(async () => {
    await harness.close();
  });

  const auth = () => ({ Cookie: cookie, Origin: harness.origin });

  /* ------------------------------ dashboard -------------------------- */

  describe('GET /dashboard', () => {
    it('answers the whole page in one request, matching the contract', async () => {
      const response = await harness
        .http()
        .get('/api/v1/dashboard')
        .set('Cookie', cookie)
        .expect(200);

      // Parsed against the contract rather than spot-checked: the dashboard is the
      // one endpoint where a missing key is a blank card rather than an error.
      const parsed = dashboardSchema.safeParse(response.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    });

    it('counts the servers by status and reports no capacity when none is known', async () => {
      const response = await harness
        .http()
        .get('/api/v1/dashboard')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.totals.servers.total).toBeGreaterThanOrEqual(1);
      // The one server is unreachable, so nothing reported a capacity — `null`,
      // which the card shows as "unknown", not as zero.
      expect(response.body.totals.capacityBytes).toBeNull();
      // And there are no size samples yet, so there is nothing to compare against.
      expect(response.body.totals.objectsDeltaToday).toBeNull();
      expect(response.body.growth).toEqual([]);
    });

    it('lists the unreachable server as an incident with a `since`', async () => {
      const response = await harness
        .http()
        .get('/api/v1/dashboard')
        .set('Cookie', cookie)
        .expect(200);
      const incident = (response.body.incidents as { serverName: string; since: string }[]).find(
        (entry) => entry.serverName === SERVER,
      );
      expect(incident).toBeDefined();
      expect(Date.parse(incident?.since ?? '')).not.toBeNaN();
    });

    it('shows at most three active jobs', async () => {
      for (let index = 0; index < DASHBOARD_JOB_COUNT + 2; index += 1) {
        await harness
          .http()
          .post('/api/v1/jobs')
          .set(auth())
          .send({
            name: `dash job ${index}`,
            type: 'delete',
            source: { serverId: SERVER, bucket: 'photos', filters: { ...JOB_FILTER_DEFAULTS } },
            params: {},
            options: { conflict: 'overwrite', concurrency: 4, dryRun: false },
            schedule: { kind: 'now' },
          })
          .expect(201);
      }

      const response = await harness
        .http()
        .get('/api/v1/dashboard')
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body.jobs.length).toBe(DASHBOARD_JOB_COUNT);
    });

    it('requires authentication', async () => {
      await harness.http().get('/api/v1/dashboard').expect(401);
    });
  });

  /* -------------------------------- search --------------------------- */

  describe('GET /search', () => {
    it('finds a server by name', async () => {
      const response = await harness
        .http()
        .get(`/api/v1/search?q=${SERVER}`)
        .set('Cookie', cookie)
        .expect(200);

      expect(searchResponseSchema.safeParse(response.body).success).toBe(true);
      const server = (response.body.items as { type: string; label: string; href: string }[]).find(
        (item) => item.type === 'server',
      );
      expect(server).toMatchObject({ label: SERVER, href: `/servers/${SERVER}` });
    });

    it('finds a job by name and links to it', async () => {
      const job = await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send({
          name: 'findable-copy-job',
          type: 'delete',
          source: { serverId: SERVER, bucket: 'photos', filters: { ...JOB_FILTER_DEFAULTS } },
          params: {},
          options: { conflict: 'overwrite', concurrency: 4, dryRun: false },
          schedule: { kind: 'now' },
        })
        .expect(201);

      const response = await harness
        .http()
        .get('/api/v1/search?q=findable-copy')
        .set('Cookie', cookie)
        .expect(200);

      const found = (response.body.items as { type: string; id: string }[]).find(
        (item) => item.type === 'job',
      );
      expect(found?.id).toBe(job.body.id);
    });

    it('answers quickly even though every live source is unreachable', async () => {
      // The IAM half fans out to servers that will not answer; the budget is what
      // keeps a keystroke from taking as long as the slowest of them.
      const started = Date.now();
      await harness.http().get('/api/v1/search?q=lab').set('Cookie', cookie).expect(200);
      expect(Date.now() - started).toBeLessThan(5_000);
    }, 15_000);

    it('honours the limit and rejects an empty or oversized query', async () => {
      const limited = await harness
        .http()
        .get(`/api/v1/search?q=${SERVER}&limit=1`)
        .set('Cookie', cookie)
        .expect(200);
      expect(limited.body.items.length).toBeLessThanOrEqual(1);

      await harness.http().get('/api/v1/search?q=').set('Cookie', cookie).expect(400);
      await harness.http().get('/api/v1/search?q=x&limit=500').set('Cookie', cookie).expect(400);
    });

    it('requires authentication', async () => {
      await harness.http().get('/api/v1/search?q=x').expect(401);
    });
  });

  /* --------------------------- config backup ------------------------- */

  describe('POST /settings/export and /settings/import', () => {
    it('exports an encrypted archive that imports back', async () => {
      await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ health: { latencyWarnMs: 1234 } })
        .expect(200);

      const exported = await harness
        .http()
        .post('/api/v1/settings/export')
        .set(auth())
        .send({ passphrase: PASSPHRASE })
        .expect(200);

      expect(exported.headers['content-type']).toContain('application/octet-stream');
      expect(exported.headers['content-disposition']).toContain('.sioconf');
      // An archive of every credential the installation holds must not be cached.
      expect(exported.headers['cache-control']).toBe('no-store');

      const archive = exported.body as Buffer;
      expect(Buffer.isBuffer(archive)).toBe(true);
      // Nothing recognisable in the clear.
      expect(archive.toString('latin1')).not.toContain(SERVER);

      // Change the setting, then restore and see it come back.
      await harness
        .http()
        .patch('/api/v1/settings')
        .set(auth())
        .send({ health: { latencyWarnMs: 999 } })
        .expect(200);

      const imported = await harness
        .http()
        .post('/api/v1/settings/import')
        .set(auth())
        .field('passphrase', PASSPHRASE)
        .attach('file', archive, 'storage-io.sioconf')
        .expect(200);

      expect(imported.body).toEqual({ servers: 1, settings: true });

      const settings = await harness
        .http()
        .get('/api/v1/settings')
        .set('Cookie', cookie)
        .expect(200);
      expect(settings.body.health.latencyWarnMs).toBe(1234);
    });

    it('updates an existing server by name rather than duplicating it', async () => {
      const before = await harness.http().get('/api/v1/servers').set('Cookie', cookie).expect(200);

      const exported = await harness
        .http()
        .post('/api/v1/settings/export')
        .set(auth())
        .send({ passphrase: PASSPHRASE })
        .expect(200);

      await harness
        .http()
        .post('/api/v1/settings/import')
        .set(auth())
        .field('passphrase', PASSPHRASE)
        .attach('file', exported.body as Buffer, 'again.sioconf')
        .expect(200);

      const after = await harness.http().get('/api/v1/servers').set('Cookie', cookie).expect(200);
      expect(after.body.total).toBe(before.body.total);
      // Same id, so its buckets, quotas, metrics and job history survive the import.
      expect(after.body.items[0].id).toBe(before.body.items[0].id);
    });

    it('refuses a wrong passphrase with a 400, not a 500', async () => {
      const exported = await harness
        .http()
        .post('/api/v1/settings/export')
        .set(auth())
        .send({ passphrase: PASSPHRASE })
        .expect(200);

      const response = await harness
        .http()
        .post('/api/v1/settings/import')
        .set(auth())
        .field('passphrase', 'the-wrong-passphrase')
        .attach('file', exported.body as Buffer, 'again.sioconf')
        .expect(400);

      expect(response.body.code).toBe('VALIDATION');
      expect(response.body.detail).toMatch(/passphrase/i);
    });

    it('refuses a file that is not an archive', async () => {
      const response = await harness
        .http()
        .post('/api/v1/settings/import')
        .set(auth())
        .field('passphrase', PASSPHRASE)
        .attach('file', Buffer.from('this is not an archive at all'), 'notes.txt')
        .expect(400);
      expect(response.body.detail).toContain('not a storage-io configuration archive');
    });

    it('refuses an import with no file, and a passphrase that is too short', async () => {
      await harness
        .http()
        .post('/api/v1/settings/import')
        .set(auth())
        .field('passphrase', PASSPHRASE)
        .expect(400);

      await harness
        .http()
        .post('/api/v1/settings/export')
        .set(auth())
        .send({ passphrase: 'short' })
        .expect(400);
    });

    it('requires authentication', async () => {
      await harness
        .http()
        .post('/api/v1/settings/export')
        .send({ passphrase: PASSPHRASE })
        .expect(401);
    });
  });

  /* --------------------------- syslog forwarding ---------------------- */

  describe('activity syslog forwarding', () => {
    it('forwards an activity row to the configured collector', async () => {
      const socket: UdpSocket = createSocket('udp4');
      socket.bind(0, '127.0.0.1');
      await once(socket, 'listening');
      const port = socket.address().port;

      try {
        await harness
          .http()
          .patch('/api/v1/settings')
          .set(auth())
          .send({
            activity: {
              syslog: { enabled: true, host: '127.0.0.1', port, protocol: 'udp', format: 'json' },
            },
          })
          .expect(200);

        const arrived = once(socket, 'message') as Promise<[Buffer]>;

        // Any mutating request produces an activity row; this one is cheap.
        await harness
          .http()
          .patch('/api/v1/settings')
          .set(auth())
          .send({ health: { latencyWarnMs: 777 } })
          .expect(200);

        const [message] = await arrived;
        const parsed = JSON.parse(message.toString('utf8')) as Record<string, unknown>;
        expect(parsed).toMatchObject({
          app: 'storage-io',
          category: 'system',
          action: 'settings.update',
          result: 'success',
        });
      } finally {
        socket.close();
        await harness
          .http()
          .patch('/api/v1/settings')
          .set(auth())
          .send({ activity: { syslog: { enabled: false, host: '' } } })
          .expect(200);
      }
    }, 15_000);
  });
});
