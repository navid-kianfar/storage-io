import {
  API_PREFIX,
  JOB_FILTER_DEFAULTS,
  JOB_PROGRESS_ZERO,
  type CreateJobRequest,
  type DuplicateJobRequest,
  type EstimateJobRequest,
  type EstimateJobResponse,
  type Job,
  type JobList,
  type JobLogEntry,
  type JobLogsResponse,
  type JobType,
  type JobView,
  type UpdateJobRequest,
} from '@storage-io/contracts';
import { HttpResponse, http } from 'msw';
import { mockServers } from './fixtures';

/**
 * Stateful mocks for `/jobs`, which apps/api has not implemented yet (the jobs
 * module is `jobs.port.ts` plus a queue service at the time of writing, and
 * `GET /api/v1/jobs` answers 404).
 *
 * Stateful because the page is a set of flows, not a screenshot: pausing a job has
 * to change what the next request says, creating one has to appear in the right
 * tab, and cancelling one has to move it to History. A running job also advances
 * its own progress on every read, so the meter, the throughput and the ETA are
 * live in `pnpm dev:mock` the way the SSE stream makes them live against the API.
 *
 * Delete this file once `/jobs` is real.
 */

const base = API_PREFIX;

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const TICK_OBJECTS = 140;
const TICK_BYTES = 6.4e8;
const LOG_TICK_LINES = 1;
const MAX_LOG_LINES = 400;
const ESTIMATE_AVG_OBJECT_BYTES = 4.4e6;
const ESTIMATE_OBJECTS = 412_900;

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

let sequence = 4200;
function nextJobId(): string {
  sequence += 1;
  return `bj-${String(sequence)}`;
}

const SERVER_A = mockServers[0];
const SERVER_B = mockServers[1];

function sourceOf(bucket: string, prefix: string): Job['source'] {
  return {
    serverId: SERVER_A?.id ?? 'minio-prod-01',
    serverName: SERVER_A?.name ?? 'minio-prod-01',
    bucket,
    filters: { ...JOB_FILTER_DEFAULTS, prefix },
    prefixes: [],
    keyCount: null,
  };
}

function targetOf(bucket: string, prefix: string): Job['target'] {
  return {
    serverId: SERVER_B?.id ?? 'seaweed-archive',
    serverName: SERVER_B?.name ?? 'seaweed-archive',
    bucket,
    prefix,
  };
}

/** The concept's three active jobs, two schedules and seven finished runs. */
function seedJobs(): Job[] {
  return [
    {
      id: 'bj-4192',
      name: 'Copy objects',
      type: 'copy',
      status: 'running',
      source: sourceOf('media-prod', 'raw/'),
      target: targetOf('media-cold', ''),
      params: {},
      options: { conflict: 'skip', concurrency: 8, dryRun: false },
      schedule: { kind: 'now' },
      progress: {
        total: 645_000,
        processed: 412_900,
        failed: 12,
        skipped: 140,
        bytes: 1.18e12,
        objectsPerSec: 382,
        bytesPerSec: 2.14e8,
        etaSeconds: 1080,
      },
      parentId: null,
      createdAt: isoAgo(82 * MINUTE_MS),
      startedAt: isoAgo(82 * MINUTE_MS),
      finishedAt: null,
      waitingFor: null,
    },
    {
      id: 'bj-4193',
      name: 'Delete noncurrent versions',
      type: 'delete',
      status: 'running',
      source: sourceOf('logs-2026', ''),
      target: null,
      params: { includeVersions: true },
      options: { conflict: 'skip', concurrency: 16, dryRun: false },
      schedule: { kind: 'now' },
      progress: {
        total: 8_600_000,
        processed: 1_900_000,
        failed: 0,
        skipped: 0,
        bytes: 0.21e12,
        objectsPerSec: 2140,
        bytesPerSec: 3.8e7,
        etaSeconds: 3120,
      },
      parentId: null,
      createdAt: isoAgo(15 * MINUTE_MS),
      startedAt: isoAgo(15 * MINUTE_MS),
      finishedAt: null,
      waitingFor: null,
    },
    {
      id: 'bj-4188',
      name: 'Apply tags',
      type: 'tag',
      status: 'paused',
      source: sourceOf('ml-datasets', ''),
      target: null,
      params: { tags: { project: 'vision' } },
      options: { conflict: 'skip', concurrency: 4, dryRun: false },
      schedule: { kind: 'now' },
      progress: {
        total: 2_300_000,
        processed: 1_104_000,
        failed: 3,
        skipped: 0,
        bytes: 0,
        objectsPerSec: 0,
        bytesPerSec: 0,
        etaSeconds: null,
      },
      parentId: null,
      createdAt: isoAgo(330 * MINUTE_MS),
      startedAt: isoAgo(330 * MINUTE_MS),
      finishedAt: null,
      waitingFor: 'ceph-lab offline',
    },

    {
      id: 'bj-sched-1',
      name: 'Expire tmp/ uploads',
      type: 'delete',
      status: 'scheduled',
      source: sourceOf('media-prod', 'tmp/'),
      target: null,
      params: {},
      options: { conflict: 'skip', concurrency: 8, dryRun: false },
      schedule: {
        kind: 'cron',
        cron: '0 3 * * *',
        timezone: 'Europe/Istanbul',
        enabled: true,
        nextRunAt: isoIn(7.5 * HOUR_MS),
      },
      progress: { ...JOB_PROGRESS_ZERO, processed: 84_200, bytes: 96e9 },
      parentId: null,
      createdAt: isoAgo(40 * DAY_MS),
      startedAt: isoAgo(16.5 * HOUR_MS),
      finishedAt: isoAgo(16.4 * HOUR_MS),
      waitingFor: null,
    },
    {
      id: 'bj-sched-2',
      name: 'Replicate backups-daily to aws-eu-backup',
      type: 'copy',
      status: 'scheduled',
      source: sourceOf('backups-daily', ''),
      target: targetOf('aws-eu-backup', ''),
      params: {},
      options: { conflict: 'overwrite', concurrency: 8, dryRun: false },
      schedule: {
        kind: 'cron',
        cron: '0 4 * * 0',
        timezone: 'Europe/Istanbul',
        enabled: true,
        nextRunAt: isoIn(52 * HOUR_MS),
      },
      progress: { ...JOB_PROGRESS_ZERO, processed: 12_400, failed: 8, bytes: 210e9 },
      parentId: null,
      createdAt: isoAgo(120 * DAY_MS),
      startedAt: isoAgo(116 * HOUR_MS),
      finishedAt: isoAgo(115.7 * HOUR_MS),
      waitingFor: null,
    },

    finished('bj-4180', 'Archive 2025 logs', 'copy', 'completed', 1_200_000, 0, 4.1e12, 1 * DAY_MS, 134),
    finished(
      'bj-4176',
      'Copy objects',
      'copy',
      'completed_with_errors',
      645_000,
      412,
      1.8e12,
      2 * DAY_MS,
      182,
    ),
    finished('bj-4171', 'Expire tmp/ uploads', 'delete', 'completed', 84_200, 0, 96e9, 2.1 * DAY_MS, 6),
    finished(
      'bj-4166',
      'Replicate backups-daily to aws-eu-backup',
      'copy',
      'failed',
      12_400,
      2_180,
      210e9,
      5 * DAY_MS,
      18,
    ),
    finished('bj-4160', 'Set retention', 'retention', 'cancelled', 3_100, 0, 40e9, 6 * DAY_MS, 2),
    finished(
      'bj-4155',
      'Restore previous versions',
      'restore-versions',
      'completed',
      512,
      0,
      8.4e9,
      7 * DAY_MS,
      1,
    ),
    finished(
      'bj-4150',
      'Change storage class',
      'storage-class',
      'completed',
      186_000,
      0,
      640e9,
      8 * DAY_MS,
      41,
    ),
  ];
}

function finished(
  id: string,
  name: string,
  type: JobType,
  status: Job['status'],
  processed: number,
  failed: number,
  bytes: number,
  finishedAgoMs: number,
  durationMinutes: number,
): Job {
  const finishedAt = isoAgo(finishedAgoMs);
  const startedAt = new Date(
    Date.parse(finishedAt) - durationMinutes * MINUTE_MS,
  ).toISOString();
  return {
    id,
    name,
    type,
    status,
    source: sourceOf('media-prod', ''),
    target: type === 'copy' || type === 'move' ? targetOf('media-cold', '') : null,
    params: {},
    options: { conflict: 'skip', concurrency: 8, dryRun: false },
    schedule: { kind: 'now' },
    progress: {
      ...JOB_PROGRESS_ZERO,
      total: processed + failed,
      processed,
      failed,
      bytes,
    },
    parentId: null,
    createdAt: startedAt,
    startedAt,
    finishedAt,
    waitingFor: null,
  };
}

let jobs = seedJobs();
const logs = new Map<string, JobLogEntry[]>();

function seedLog(job: Job): JobLogEntry[] {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const at = (offsetSeconds: number) => new Date(start + offsetSeconds * 1000).toISOString();
  return [
    {
      at: at(0),
      level: 'info',
      message: `job ${job.id} accepted · operation=${job.type} concurrency=${String(
        job.options.concurrency,
      )} dry-run=${String(job.options.dryRun)}`,
      key: null,
    },
    {
      at: at(0),
      level: 'info',
      message: `source  s3://${job.source.bucket}/${job.source.filters.prefix} (${job.source.serverName})`,
      key: null,
    },
    ...(job.target === null
      ? []
      : [
          {
            at: at(0),
            level: 'info' as const,
            message: `target  s3://${job.target.bucket}/${job.target.prefix} (${job.target.serverName})`,
            key: null,
          },
        ]),
    { at: at(1), level: 'info', message: 'listing objects…', key: null },
    {
      at: at(37),
      level: 'info',
      message: `matched ${String(job.progress.total ?? 0)} objects`,
      key: null,
    },
    {
      at: at(37),
      level: 'info',
      message: `${String(job.options.concurrency)} workers started · multipart part size 16 MB`,
      key: null,
    },
    ...(job.progress.failed > 0
      ? [
          {
            at: at(1012),
            level: 'warn' as const,
            message: 'retry 1/3 · connection reset by peer',
            key: 'raw/2026/03/IMG_8841.cr3',
          },
          {
            at: at(2320),
            level: 'error' as const,
            message: '403 AccessDenied on target',
            key: 'raw/2026/04/IMG_9002.cr3',
          },
          {
            at: at(2321),
            level: 'error' as const,
            message: '403 AccessDenied on target',
            key: 'raw/2026/04/IMG_9003.cr3',
          },
          {
            at: at(3554),
            level: 'error' as const,
            message: 'checksum mismatch, requeued',
            key: 'raw/2026/05/IMG_1177.cr3',
          },
        ]
      : []),
  ];
}

function logFor(job: Job): JobLogEntry[] {
  const existing = logs.get(job.id);
  if (existing !== undefined) return existing;
  const seeded = seedLog(job);
  logs.set(job.id, seeded);
  return seeded;
}

/**
 * Advance every running job a little, so the page is live without a fake SSE
 * stream. The real API pushes `job.progress`; this is the mock's stand-in and the
 * only place it invents movement.
 */
function tick(): void {
  jobs = jobs.map((job) => {
    if (job.status !== 'running') return job;
    const total = job.progress.total;
    const processed =
      total === null ? job.progress.processed + TICK_OBJECTS : Math.min(total, job.progress.processed + TICK_OBJECTS);
    const remaining = total === null ? null : Math.max(0, total - processed);
    const done = remaining === 0;

    const line = logFor(job);
    if (line.length < MAX_LOG_LINES) {
      for (let index = 0; index < LOG_TICK_LINES; index += 1) {
        line.push({
          at: new Date().toISOString(),
          level: 'info',
          message: `${String(processed)}${total === null ? '' : ` / ${String(total)}`} objects · ${String(
            job.progress.objectsPerSec,
          )} obj/s`,
          key: null,
        });
      }
    }

    return {
      ...job,
      status: done ? (job.progress.failed > 0 ? 'completed_with_errors' : 'completed') : 'running',
      finishedAt: done ? new Date().toISOString() : null,
      progress: {
        ...job.progress,
        processed,
        bytes: job.progress.bytes + TICK_BYTES,
        etaSeconds:
          remaining === null || job.progress.objectsPerSec === 0
            ? null
            : Math.round(remaining / job.progress.objectsPerSec),
      },
    };
  });
}

const ACTIVE_STATUSES: readonly Job['status'][] = ['running', 'paused', 'queued'];

function forView(view: JobView): readonly Job[] {
  if (view === 'active') return jobs.filter((job) => ACTIVE_STATUSES.includes(job.status));
  if (view === 'scheduled') return jobs.filter((job) => job.schedule.kind === 'cron');
  return jobs.filter(
    (job) =>
      job.schedule.kind !== 'cron' &&
      !ACTIVE_STATUSES.includes(job.status) &&
      job.status !== 'scheduled',
  );
}

function counts(): JobList['counts'] {
  return {
    active: forView('active').length,
    scheduled: forView('scheduled').length,
    history: forView('history').length,
  };
}

function find(jobId: string): Job | undefined {
  return jobs.find((job) => job.id === jobId);
}

function replace(next: Job): Job {
  jobs = jobs.map((job) => (job.id === next.id ? next : job));
  return next;
}

function notFound() {
  return HttpResponse.json(
    {
      type: 'about:blank',
      title: 'Not found',
      status: HTTP_NOT_FOUND,
      detail: 'No such job.',
      code: 'NOT_FOUND',
    },
    { status: HTTP_NOT_FOUND, headers: { 'content-type': 'application/problem+json' } },
  );
}

export const jobHandlers = [
  http.get(`${base}/jobs`, ({ request }) => {
    tick();
    const view = (new URL(request.url).searchParams.get('view') ?? 'active') as JobView;
    const items = forView(view);
    return HttpResponse.json({
      items: [...items],
      total: items.length,
      counts: counts(),
    } satisfies JobList);
  }),

  http.post(`${base}/jobs/estimate`, async ({ request }) => {
    const body = (await request.json()) as EstimateJobRequest;
    const hasFilters =
      body.source.filters.glob !== null ||
      body.source.filters.minSize !== null ||
      Object.keys(body.source.filters.tags).length > 0;
    const objects = hasFilters ? Math.round(ESTIMATE_OBJECTS / 3) : ESTIMATE_OBJECTS;
    return HttpResponse.json({
      objects,
      bytes: objects * ESTIMATE_AVG_OBJECT_BYTES,
      partial: objects > 400_000,
    } satisfies EstimateJobResponse);
  }),

  http.post(`${base}/jobs`, async ({ request }) => {
    const body = (await request.json()) as CreateJobRequest;
    const server = mockServers.find((entry) => entry.id === body.source.serverId);
    const targetServer =
      body.target === undefined
        ? undefined
        : mockServers.find((entry) => entry.id === body.target?.serverId);
    const recurring = body.schedule.kind === 'cron';
    const job: Job = {
      id: nextJobId(),
      name: body.name ?? body.type,
      type: body.type,
      status: recurring ? 'scheduled' : body.schedule.kind === 'at' ? 'queued' : 'running',
      source: {
        serverId: body.source.serverId,
        serverName: server?.name ?? body.source.serverId,
        bucket: body.source.bucket,
        filters: body.source.filters,
        prefixes: [],
        keyCount: null,
      },
      target:
        body.target === undefined
          ? null
          : {
              serverId: body.target.serverId,
              serverName: targetServer?.name ?? body.target.serverId,
              bucket: body.target.bucket,
              prefix: body.target.prefix ?? '',
            },
      params: body.params,
      options: body.options,
      schedule:
        body.schedule.kind === 'cron'
          ? {
              kind: 'cron',
              cron: body.schedule.cron,
              timezone: body.schedule.timezone,
              enabled: body.schedule.enabled ?? true,
              nextRunAt: isoIn(8 * HOUR_MS),
            }
          : body.schedule,
      progress: { ...JOB_PROGRESS_ZERO, total: ESTIMATE_OBJECTS, objectsPerSec: 310 },
      parentId: null,
      createdAt: new Date().toISOString(),
      startedAt: recurring ? null : new Date().toISOString(),
      finishedAt: null,
      waitingFor: null,
    };
    jobs = [job, ...jobs];
    return HttpResponse.json(job, { status: HTTP_CREATED });
  }),

  http.get(`${base}/jobs/:id/logs`, ({ params, request }) => {
    tick();
    const job = find(String(params.id));
    if (job === undefined) return notFound();
    const level = new URL(request.url).searchParams.get('level') ?? 'all';
    const all = logFor(job);
    const items = level === 'error' ? all.filter((entry) => entry.level === 'error') : all;
    return HttpResponse.json({ items: [...items], nextCursor: null } satisfies JobLogsResponse);
  }),

  http.get(`${base}/jobs/:id/runs`, ({ params }) => {
    const job = find(String(params.id));
    if (job === undefined) return notFound();
    const runs = forView('history')
      .filter((entry) => entry.name === job.name)
      .map((entry) => ({ ...entry, parentId: job.id }));
    return HttpResponse.json({ items: runs, total: runs.length });
  }),

  http.post(`${base}/jobs/:id/pause`, ({ params }) => {
    const job = find(String(params.id));
    if (job === undefined) return notFound();
    return HttpResponse.json(
      replace({
        ...job,
        status: 'paused',
        progress: { ...job.progress, objectsPerSec: 0, bytesPerSec: 0, etaSeconds: null },
      }),
    );
  }),

  http.post(`${base}/jobs/:id/resume`, ({ params }) => {
    const job = find(String(params.id));
    if (job === undefined) return notFound();
    return HttpResponse.json(
      replace({
        ...job,
        status: 'running',
        waitingFor: null,
        progress: { ...job.progress, objectsPerSec: 320, bytesPerSec: 1.8e8 },
      }),
    );
  }),

  http.post(`${base}/jobs/:id/cancel`, ({ params }) => {
    const job = find(String(params.id));
    if (job === undefined) return notFound();
    return HttpResponse.json(
      replace({ ...job, status: 'cancelled', finishedAt: new Date().toISOString() }),
    );
  }),

  http.post(`${base}/jobs/:id/run-now`, ({ params }) => {
    const job = find(String(params.id));
    if (job === undefined) return notFound();
    const run: Job = {
      ...job,
      id: nextJobId(),
      status: 'running',
      schedule: { kind: 'now' },
      parentId: job.id,
      progress: { ...JOB_PROGRESS_ZERO, total: ESTIMATE_OBJECTS, objectsPerSec: 290 },
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    jobs = [run, ...jobs];
    return HttpResponse.json(run);
  }),

  http.post(`${base}/jobs/:id/duplicate`, async ({ params, request }) => {
    const job = find(String(params.id));
    if (job === undefined) return notFound();
    const body = (await request.json().catch(() => ({}))) as DuplicateJobRequest;
    const asSchedule = body.asSchedule;
    const copy: Job = {
      ...job,
      id: nextJobId(),
      status: asSchedule === undefined ? 'running' : 'scheduled',
      schedule:
        asSchedule === undefined
          ? { kind: 'now' }
          : {
              kind: 'cron',
              cron: asSchedule.cron,
              timezone: asSchedule.timezone,
              enabled: true,
              nextRunAt: isoIn(8 * HOUR_MS),
            },
      progress: { ...JOB_PROGRESS_ZERO, total: job.progress.total, objectsPerSec: 300 },
      parentId: null,
      createdAt: new Date().toISOString(),
      startedAt: asSchedule === undefined ? new Date().toISOString() : null,
      finishedAt: null,
    };
    jobs = [copy, ...jobs];
    return HttpResponse.json(copy, { status: HTTP_CREATED });
  }),

  http.patch(`${base}/jobs/:id`, async ({ params, request }) => {
    const job = find(String(params.id));
    if (job === undefined) return notFound();
    const body = (await request.json()) as UpdateJobRequest;
    const schedule: Job['schedule'] =
      body.schedule !== undefined
        ? body.schedule.kind === 'cron'
          ? {
              kind: 'cron',
              cron: body.schedule.cron,
              timezone: body.schedule.timezone,
              enabled: body.schedule.enabled ?? true,
              nextRunAt: isoIn(8 * HOUR_MS),
            }
          : body.schedule
        : body.enabled !== undefined && job.schedule.kind === 'cron'
          ? { ...job.schedule, enabled: body.enabled }
          : job.schedule;
    return HttpResponse.json(
      replace({
        ...job,
        name: body.name ?? job.name,
        options:
          body.concurrency === undefined
            ? job.options
            : { ...job.options, concurrency: body.concurrency },
        schedule,
      }),
    );
  }),

  http.delete(`${base}/jobs/:id`, ({ params }) => {
    jobs = jobs.filter((job) => job.id !== String(params.id));
    logs.delete(String(params.id));
    return new HttpResponse(null, { status: HTTP_NO_CONTENT });
  }),

  http.get(`${base}/jobs/:id`, ({ params }) => {
    tick();
    const job = find(String(params.id));
    return job === undefined ? notFound() : HttpResponse.json(job);
  }),
];
