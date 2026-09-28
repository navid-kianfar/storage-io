import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_FILTER_DEFAULTS, type Job } from '@storage-io/contracts';
import { JobEngineService } from '../../src/modules/jobs/job-engine.service';
import { JobSchedulerService } from '../../src/modules/jobs/job-scheduler.service';
import { JobsRepository } from '../../src/modules/jobs/jobs.repository';
import { createTestApp, type TestHarness } from '../support/test-app';

/**
 * The `/jobs` surface and the state machine behind it, without a storage server.
 *
 * The endpoint here is a closed port, which is the right fixture for most of this:
 * what is being proved is the contract, the transitions and the scheduler's
 * arithmetic, and a job whose server is unreachable exercises `waitingFor` — the
 * one piece of the engine that is *about* a server being down.
 *
 * The real work — copying a few hundred objects between MinIO and SeaweedFS,
 * pausing it, resuming it and surviving a restart — is in
 * `test/it/jobs.it.spec.ts`, behind `S3_IT=1`.
 *
 * `JOB_ENGINE_ENABLED` is false in the harness, so the engine is driven by calling
 * `tick()` directly. A background interval would claim a row in the middle of the
 * assertion that it was queued.
 */

const UNREACHABLE = 'http://127.0.0.1:9';
const SERVER = 'jobs-lab';

const jobBody = (overrides: Record<string, unknown> = {}) => ({
  type: 'delete',
  source: { serverId: SERVER, bucket: 'photos', filters: { ...JOB_FILTER_DEFAULTS } },
  params: {},
  options: { conflict: 'overwrite', concurrency: 4, dryRun: false },
  schedule: { kind: 'now' },
  ...overrides,
});

describe('jobs (e2e)', () => {
  let harness: TestHarness;
  let cookie: string;
  let engine: JobEngineService;
  let scheduler: JobSchedulerService;
  let repository: JobsRepository;

  beforeAll(async () => {
    harness = await createTestApp({ LOGIN_RATE_LIMIT: '1000' });
    cookie = await harness.login();
    engine = harness.app.get(JobEngineService);
    scheduler = harness.app.get(JobSchedulerService);
    repository = harness.app.get(JobsRepository);

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

  const create = async (overrides: Record<string, unknown> = {}): Promise<Job> => {
    const response = await harness
      .http()
      .post('/api/v1/jobs')
      .set(auth())
      .send(jobBody(overrides))
      .expect(201);
    return response.body as Job;
  };

  /* ------------------------------- creating ------------------------- */

  describe('POST /jobs', () => {
    it('creates a queued job with a derived name and zeroed progress', async () => {
      const job = await create({
        source: { serverId: SERVER, bucket: 'photos', filters: { ...JOB_FILTER_DEFAULTS } },
      });

      expect(job).toMatchObject({
        id: expect.any(String),
        type: 'delete',
        status: 'queued',
        parentId: null,
        waitingFor: null,
        schedule: { kind: 'now' },
        progress: { total: null, processed: 0, failed: 0, skipped: 0, bytes: 0 },
      });
      // The name is derived from the type and bucket when none was sent.
      expect(job.name).toContain('photos');
      // `keyCount` is null for a filter-defined job; the selection case is the
      // object browser's, and the keys themselves stay server-side.
      expect(job.source).toMatchObject({ serverName: SERVER, keyCount: null });
    });

    it('stamps the server name so the job still reads right later', async () => {
      const job = await create({ name: 'named job' });
      expect(job.source['serverName']).toBe(SERVER);
      expect(job.name).toBe('named job');
    });

    it('rejects a copy job with no target', async () => {
      const response = await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send(jobBody({ type: 'copy' }))
        .expect(400);
      expect(response.body.code).toBe('VALIDATION');
      expect(response.body.detail).toContain('target');
    });

    it('accepts a copy job with a target and records both server names', async () => {
      const job = await create({
        type: 'copy',
        target: { serverId: SERVER, bucket: 'archive', prefix: 'moved/' },
      });
      expect(job.target).toEqual({
        serverId: expect.any(String),
        serverName: SERVER,
        bucket: 'archive',
        prefix: 'moved/',
      });
    });

    it('drops a target on a type that has no use for one', async () => {
      const job = await create({ target: { serverId: SERVER, bucket: 'archive', prefix: '' } });
      expect(job.target).toBeNull();
    });

    it('404s on a source server that does not exist', async () => {
      const response = await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send(
          jobBody({
            source: { serverId: 'nope', bucket: 'x', filters: { ...JOB_FILTER_DEFAULTS } },
          }),
        )
        .expect(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('rejects a concurrency outside the contract bounds', async () => {
      await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send(jobBody({ options: { conflict: 'overwrite', concurrency: 100, dryRun: false } }))
        .expect(400);
    });

    it('rejects an unknown job type', async () => {
      await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send(jobBody({ type: 'incinerate' }))
        .expect(400);
    });
  });

  /* ------------------------------ scheduling ------------------------ */

  describe('schedules', () => {
    it('creates a cron job as scheduled, with a computed next run', async () => {
      const job = await create({
        name: 'nightly',
        schedule: { kind: 'cron', cron: '0 3 * * *', timezone: 'UTC', enabled: true },
      });

      expect(job.status).toBe('scheduled');
      expect(job.schedule).toMatchObject({ kind: 'cron', cron: '0 3 * * *', enabled: true });
      expect(Date.parse(nextRunOf(job))).toBeGreaterThan(Date.now());
    });

    it('rejects a six-field cron with a sentence, not a stack trace', async () => {
      const response = await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send(
          jobBody({
            schedule: { kind: 'cron', cron: '0 0 3 * * *', timezone: 'UTC', enabled: true },
          }),
        )
        .expect(400);
      expect(response.body.detail).toContain('5 fields');
    });

    it('rejects an unknown timezone', async () => {
      await harness
        .http()
        .post('/api/v1/jobs')
        .set(auth())
        .send(
          jobBody({
            schedule: { kind: 'cron', cron: '0 3 * * *', timezone: 'Mars/Olympus', enabled: true },
          }),
        )
        .expect(400);
    });

    it('creates an `at` job as scheduled, and the scheduler queues it when due', async () => {
      const at = new Date(Date.now() - 1000).toISOString();
      const job = await create({ schedule: { kind: 'at', at } });
      expect(job.status).toBe('scheduled');

      scheduler.fireDue();

      const after = await harness
        .http()
        .get(`/api/v1/jobs/${job.id}`)
        .set('Cookie', cookie)
        .expect(200);
      // An `at` schedule *is* the run: it becomes queued rather than spawning a child.
      expect(after.body.status).toBe('queued');
      expect(after.body.parentId).toBeNull();
    });

    it('spawns a child run for a due cron job and leaves the schedule scheduled', async () => {
      const job = await create({
        name: 'hourly copy',
        schedule: { kind: 'cron', cron: '*/5 * * * *', timezone: 'UTC', enabled: true },
      });
      const id = job.id;
      // Backdate the next run so the scheduler sees it as due.
      repository.update(id, { nextRunAt: new Date(Date.now() - 60_000).toISOString() });

      expect(scheduler.fireDue()).toBeGreaterThan(0);

      const parent = await harness
        .http()
        .get(`/api/v1/jobs/${id}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(parent.body.status).toBe('scheduled');
      expect(Date.parse(parent.body.schedule.nextRunAt as string)).toBeGreaterThan(Date.now());

      const runs = await harness
        .http()
        .get(`/api/v1/jobs/${id}/runs`)
        .set('Cookie', cookie)
        .expect(200);
      expect(runs.body.total).toBe(1);
      expect(runs.body.items[0]).toMatchObject({
        parentId: id,
        status: 'queued',
        name: 'hourly copy',
        // The run is not itself a schedule.
        schedule: { kind: 'now' },
      });
    });

    it('skips a run while the previous one is still in flight', async () => {
      const job = await create({
        name: 'busy schedule',
        schedule: { kind: 'cron', cron: '*/5 * * * *', timezone: 'UTC', enabled: true },
      });
      const id = job.id;

      repository.update(id, { nextRunAt: new Date(Date.now() - 60_000).toISOString() });
      scheduler.fireDue();
      repository.update(id, { nextRunAt: new Date(Date.now() - 60_000).toISOString() });
      scheduler.fireDue();

      const runs = await harness
        .http()
        .get(`/api/v1/jobs/${id}/runs`)
        .set('Cookie', cookie)
        .expect(200);
      // Two runs of the same copy over the same bucket would fight over the keys.
      expect(runs.body.total).toBe(1);
    });

    it('returns an empty run list for a job that is not a schedule', async () => {
      const job = await create();
      const runs = await harness
        .http()
        .get(`/api/v1/jobs/${job.id}/runs`)
        .set('Cookie', cookie)
        .expect(200);
      expect(runs.body).toEqual({ items: [], total: 0 });
    });
  });

  /* ------------------------------- listing -------------------------- */

  describe('GET /jobs', () => {
    it('defaults to the active view and always reports all three counts', async () => {
      const response = await harness.http().get('/api/v1/jobs').set('Cookie', cookie).expect(200);

      expect(response.body.counts).toEqual({
        active: expect.any(Number),
        scheduled: expect.any(Number),
        history: expect.any(Number),
      });
      for (const job of response.body.items as { status: string }[]) {
        expect(['queued', 'running', 'paused']).toContain(job.status);
      }
    });

    it('filters to scheduled jobs on ?view=scheduled', async () => {
      const response = await harness
        .http()
        .get('/api/v1/jobs?view=scheduled')
        .set('Cookie', cookie)
        .expect(200);
      for (const job of response.body.items as { status: string }[]) {
        expect(job.status).toBe('scheduled');
      }
    });

    it('rejects a view that is not one of the three', async () => {
      await harness.http().get('/api/v1/jobs?view=everything').set('Cookie', cookie).expect(400);
    });

    it('pages', async () => {
      const response = await harness
        .http()
        .get('/api/v1/jobs?view=active&page=1&pageSize=1')
        .set('Cookie', cookie)
        .expect(200);
      expect(response.body.items.length).toBeLessThanOrEqual(1);
      expect(response.body.total).toBeGreaterThan(0);
    });
  });

  /* ------------------------------- control -------------------------- */

  describe('control', () => {
    it('pauses a queued job so the engine will not claim it', async () => {
      const job = await create();
      const id = job.id;

      const paused = await harness.http().post(`/api/v1/jobs/${id}/pause`).set(auth()).expect(200);
      expect(paused.body.status).toBe('paused');

      await engine.drain();
      const after = await harness
        .http()
        .get(`/api/v1/jobs/${id}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(after.body.status).toBe('paused');
    });

    it('resumes a paused job back to queued', async () => {
      const job = await create();
      const id = job.id;
      await harness.http().post(`/api/v1/jobs/${id}/pause`).set(auth()).expect(200);

      const resumed = await harness
        .http()
        .post(`/api/v1/jobs/${id}/resume`)
        .set(auth())
        .expect(200);
      expect(resumed.body.status).toBe('queued');
    });

    it('refuses to resume a job that is not paused', async () => {
      const job = await create();
      const response = await harness
        .http()
        .post(`/api/v1/jobs/${job.id}/resume`)
        .set(auth())
        .expect(409);
      expect(response.body.code).toBe('CONFLICT');
    });

    it('cancels a queued job and stamps finishedAt', async () => {
      const job = await create();
      const cancelled = await harness
        .http()
        .post(`/api/v1/jobs/${job.id}/cancel`)
        .set(auth())
        .expect(200);

      expect(cancelled.body.status).toBe('cancelled');
      expect(cancelled.body.finishedAt).toEqual(expect.any(String));
    });

    it('refuses to cancel a job that has already finished', async () => {
      const job = await create();
      const id = job.id;
      await harness.http().post(`/api/v1/jobs/${id}/cancel`).set(auth()).expect(200);

      const again = await harness.http().post(`/api/v1/jobs/${id}/cancel`).set(auth()).expect(409);
      expect(again.body.detail).toContain('cancelled');
    });

    it('run-now puts a finished job back to queued with its counters cleared', async () => {
      const job = await create();
      const id = job.id;
      await harness.http().post(`/api/v1/jobs/${id}/cancel`).set(auth()).expect(200);
      repository.update(id, { progress: { processed: 42, failed: 1, skipped: 0, bytes: 99 } });

      const again = await harness.http().post(`/api/v1/jobs/${id}/run-now`).set(auth()).expect(200);
      expect(again.body).toMatchObject({
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        progress: { processed: 0, failed: 0, bytes: 0 },
      });
    });

    it('run-now on a schedule creates a child run and leaves nextRunAt alone', async () => {
      const job = await create({
        schedule: { kind: 'cron', cron: '0 4 * * *', timezone: 'UTC', enabled: true },
      });
      const id = job.id;
      const before = nextRunOf(job);

      const run = await harness.http().post(`/api/v1/jobs/${id}/run-now`).set(auth()).expect(200);
      expect(run.body).toMatchObject({ parentId: id, status: 'queued' });

      const parent = await harness
        .http()
        .get(`/api/v1/jobs/${id}`)
        .set('Cookie', cookie)
        .expect(200);
      // Testing a schedule must not push it back.
      expect(parent.body.schedule.nextRunAt).toBe(before);
    });
  });

  /* ------------------------------- editing -------------------------- */

  describe('PATCH /jobs/:id', () => {
    it('renames a job', async () => {
      const job = await create();
      const response = await harness
        .http()
        .patch(`/api/v1/jobs/${job.id}`)
        .set(auth())
        .send({ name: 'renamed' })
        .expect(200);
      expect(response.body.name).toBe('renamed');
    });

    it('changes concurrency within the contract bounds', async () => {
      const job = await create();
      const response = await harness
        .http()
        .patch(`/api/v1/jobs/${job.id}`)
        .set(auth())
        .send({ concurrency: 16 })
        .expect(200);
      expect(response.body.options.concurrency).toBe(16);
    });

    it('rejects a concurrency outside them', async () => {
      const job = await create();
      await harness
        .http()
        .patch(`/api/v1/jobs/${job.id}`)
        .set(auth())
        .send({ concurrency: 0 })
        .expect(400);
    });

    it('rejects an empty body', async () => {
      const job = await create();
      await harness.http().patch(`/api/v1/jobs/${job.id}`).set(auth()).send({}).expect(400);
    });

    it('disables a cron schedule, which clears its next run and keeps the expression', async () => {
      const job = await create({
        schedule: { kind: 'cron', cron: '0 5 * * *', timezone: 'UTC', enabled: true },
      });
      const id = job.id;

      const disabled = await harness
        .http()
        .patch(`/api/v1/jobs/${id}`)
        .set(auth())
        .send({ enabled: false })
        .expect(200);
      expect(disabled.body.schedule).toMatchObject({
        kind: 'cron',
        cron: '0 5 * * *',
        enabled: false,
        nextRunAt: null,
      });

      const enabled = await harness
        .http()
        .patch(`/api/v1/jobs/${id}`)
        .set(auth())
        .send({ enabled: true })
        .expect(200);
      expect(enabled.body.schedule.enabled).toBe(true);
      expect(Date.parse(enabled.body.schedule.nextRunAt as string)).toBeGreaterThan(Date.now());
    });

    it('refuses to enable a job that is not a recurring one', async () => {
      const job = await create();
      const response = await harness
        .http()
        .patch(`/api/v1/jobs/${job.id}`)
        .set(auth())
        .send({ enabled: false })
        .expect(409);
      expect(response.body.detail).toContain('recurring');
    });

    it('refuses a schedule edit on a job that is not scheduled', async () => {
      const job = await create();
      const response = await harness
        .http()
        .patch(`/api/v1/jobs/${job.id}`)
        .set(auth())
        .send({ schedule: { kind: 'cron', cron: '0 6 * * *', timezone: 'UTC', enabled: true } })
        .expect(409);
      expect(response.body.detail).toContain('Duplicate');
    });

    it('replaces the schedule of a scheduled job', async () => {
      const job = await create({
        schedule: { kind: 'cron', cron: '0 5 * * *', timezone: 'UTC', enabled: true },
      });
      const response = await harness
        .http()
        .patch(`/api/v1/jobs/${job.id}`)
        .set(auth())
        .send({
          schedule: { kind: 'cron', cron: '30 6 * * 1', timezone: 'Europe/Berlin', enabled: true },
        })
        .expect(200);
      expect(response.body.schedule).toMatchObject({
        cron: '30 6 * * 1',
        timezone: 'Europe/Berlin',
      });
    });
  });

  /* ----------------------------- duplicating ------------------------ */

  describe('POST /jobs/:id/duplicate', () => {
    it('copies the job as a fresh queued run with nothing carried over', async () => {
      const job = await create({
        name: 'original',
        options: { conflict: 'skip', concurrency: 9, dryRun: true },
      });
      const id = job.id;
      repository.update(id, { progress: { processed: 5 }, checkpoint: 'somewhere' });

      const copy = await harness
        .http()
        .post(`/api/v1/jobs/${id}/duplicate`)
        .set(auth())
        .send({})
        .expect(201);

      expect(copy.body).toMatchObject({
        status: 'queued',
        parentId: null,
        name: 'original (copy)',
        options: { conflict: 'skip', concurrency: 9, dryRun: true },
        progress: { processed: 0 },
      });
      expect(copy.body.id).not.toBe(id);
    });

    it('turns a one-off job into a recurring schedule', async () => {
      const job = await create({ name: 'weekly cleanup' });
      const copy = await harness
        .http()
        .post(`/api/v1/jobs/${job.id}/duplicate`)
        .set(auth())
        .send({ asSchedule: { cron: '0 2 * * 0', timezone: 'UTC' } })
        .expect(201);

      expect(copy.body).toMatchObject({
        status: 'scheduled',
        name: 'weekly cleanup (schedule)',
        schedule: { kind: 'cron', cron: '0 2 * * 0', enabled: true },
      });
      expect(copy.body.schedule.nextRunAt).toEqual(expect.any(String));
    });

    it('rejects an invalid cron in asSchedule', async () => {
      const job = await create();
      await harness
        .http()
        .post(`/api/v1/jobs/${job.id}/duplicate`)
        .set(auth())
        .send({ asSchedule: { cron: 'whenever', timezone: 'UTC' } })
        .expect(400);
    });
  });

  /* ------------------------------- deleting ------------------------- */

  describe('DELETE /jobs/:id', () => {
    it('deletes a job and its logs', async () => {
      const job = await create();
      const id = job.id;
      repository.appendLogs(id, [
        { at: new Date().toISOString(), level: 'info', message: 'hello', key: null },
      ]);

      await harness.http().delete(`/api/v1/jobs/${id}`).set(auth()).expect(204);
      await harness.http().get(`/api/v1/jobs/${id}`).set('Cookie', cookie).expect(404);
    });

    it('refuses to delete a running job, naming cancel', async () => {
      const job = await create();
      const id = job.id;
      repository.update(id, { status: 'running' });

      const response = await harness.http().delete(`/api/v1/jobs/${id}`).set(auth()).expect(409);
      expect(response.body.detail).toContain('Cancel');

      repository.update(id, { status: 'cancelled' });
    });
  });

  /* -------------------------------- logs ---------------------------- */

  describe('GET /jobs/:id/logs', () => {
    it('pages by an opaque cursor and can filter to errors', async () => {
      const job = await create();
      const id = job.id;
      const at = new Date().toISOString();
      repository.appendLogs(id, [
        { at, level: 'info', message: 'started', key: null },
        { at, level: 'error', message: 'a.txt is locked', key: 'a.txt' },
        { at, level: 'info', message: 'finished', key: null },
      ]);

      const all = await harness
        .http()
        .get(`/api/v1/jobs/${id}/logs`)
        .set('Cookie', cookie)
        .expect(200);
      expect(all.body.items).toHaveLength(3);
      expect(all.body.items[1]).toMatchObject({ level: 'error', key: 'a.txt' });
      // The whole set fitted in one page, so there is nothing to continue from.
      expect(all.body.nextCursor).toBeNull();

      const errorsOnly = await harness
        .http()
        .get(`/api/v1/jobs/${id}/logs?level=error`)
        .set('Cookie', cookie)
        .expect(200);
      expect(errorsOnly.body.items).toHaveLength(1);
    });

    it('rejects a level outside the contract', async () => {
      const job = await create();
      await harness
        .http()
        .get(`/api/v1/jobs/${job.id}/logs?level=chatty`)
        .set('Cookie', cookie)
        .expect(400);
    });

    it('404s for a job that does not exist', async () => {
      await harness.http().get('/api/v1/jobs/no-such-job/logs').set('Cookie', cookie).expect(404);
    });
  });

  /* ------------------------------- estimate -------------------------- */

  describe('POST /jobs/estimate', () => {
    it('routes to the estimator rather than matching /jobs/:id', async () => {
      // A literal segment after `/jobs` has to beat `:id`, or this would be read as
      // "the job called estimate".
      const response = await harness
        .http()
        .post('/api/v1/jobs/estimate')
        .set(auth())
        .send({
          source: { serverId: SERVER, bucket: 'photos', filters: { ...JOB_FILTER_DEFAULTS } },
        });

      // The server is unreachable, so the listing fails — but as a mapped provider
      // error from the estimator, which is proof the route reached it rather than
      // being read as "the job called estimate".
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('SERVER_OFFLINE');
    }, 20_000);

    it('404s on a server that does not exist', async () => {
      await harness
        .http()
        .post('/api/v1/jobs/estimate')
        .set(auth())
        .send({ source: { serverId: 'nope', bucket: 'x', filters: { ...JOB_FILTER_DEFAULTS } } })
        .expect(404);
    });
  });

  /* ----------------------------- offline source ---------------------- */

  describe('a queued job whose server is unreachable', () => {
    it('is left queued with waitingFor naming the server', async () => {
      const job = await create({ name: 'waits for the server' });
      const id = job.id;

      await engine.drain();

      const after = await harness
        .http()
        .get(`/api/v1/jobs/${id}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(after.body.status).toBe('queued');
      expect(after.body.waitingFor).toBe(`${SERVER} offline`);
    });
  });

  /* ---------------------------------- auth --------------------------- */

  it('requires authentication on every route', async () => {
    await harness.http().get('/api/v1/jobs').expect(401);
    await harness.http().post('/api/v1/jobs').send(jobBody()).expect(401);
    await harness.http().get('/api/v1/jobs/whatever').expect(401);
  });
});

/** `schedule.nextRunAt` exists only on the cron arm of the union. */
function nextRunOf(job: Job): string {
  if (job.schedule.kind !== 'cron' || job.schedule.nextRunAt === null) {
    throw new Error(`Expected a cron schedule with a next run, got ${job.schedule.kind}.`);
  }
  return job.schedule.nextRunAt;
}
