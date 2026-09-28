import { Injectable, Logger } from '@nestjs/common';
import {
  JOB_FILTER_DEFAULTS,
  JOB_PROGRESS_ZERO,
  JOB_TERMINAL_STATUSES,
  type CreateJobRequest,
  type DuplicateJobRequest,
  type EstimateJobRequest,
  type EstimateJobResponse,
  type Job,
  type JobFilters,
  type JobList,
  type JobLogsQuery,
  type JobLogsResponse,
  type JobOptions,
  type JobParams,
  type JobRunList,
  type JobSchedule,
  type JobScheduleInput,
  type JobStatus,
  type JobType,
  type ListJobsQuery,
  type PaginationQuery,
  type UpdateJobRequest,
} from '@storage-io/contracts';
import { CryptoService } from '../../crypto/crypto.service';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.exception';
import { ServerRepository } from '../../servers/server.repository';
import { StorageContextService } from '../storage/storage-context.service';
import type { JobRow, ServerRow } from '../../db/schema';
import type { EnqueueJobInput, JobsPort } from './jobs.port';
import {
  JobsRepository,
  STORED_KEYS_FIELD,
  STORED_PREFIXES_FIELD,
  STORED_SOURCE_NAME_FIELD,
  STORED_TARGET_NAME_FIELD,
} from './jobs.repository';
import { JobEngineService, clampConcurrency, versionsNeededFor } from './job-engine.service';
import { JobEstimatorService } from './job-estimator.service';
import { assertCron, nextRunAfter } from './cron';

/**
 * The business layer for `/jobs`, and the implementation of `JOBS_PORT`.
 *
 * It owns the rules a client can observe; the engine owns doing the work and the
 * scheduler owns when. Splitting them that way is what lets an e2e test drive a
 * run deterministically: the endpoints answer without the engine running at all.
 *
 * ## The state machine, in one place
 *
 * ```
 * created  ──schedule.now───────────────▶ queued ──▶ running ──▶ completed
 *          ──schedule.at / .cron──▶ scheduled            │       completed_with_errors
 *                                      │ (due)           │       failed
 *                                      └────────────────▶│
 *   queued/running ──pause──▶ paused ──resume──▶ queued  │
 *   any non-terminal ──cancel──▶ cancelled                │
 * ```
 *
 * A cron schedule stays `scheduled` forever and produces a child run per fire; an
 * `at` schedule becomes the run itself, because there is only ever one. That is why
 * `GET /jobs/:id/runs` is interesting for a cron job and returns the empty list for
 * everything else.
 */

/** Types that move bytes and therefore need somewhere to put them. */
const TARGET_REQUIRED_TYPES: readonly JobType[] = ['copy', 'move'];

/** What a job with no explicit options gets. */
const DEFAULT_JOB_CONCURRENCY = 4;
const DEFAULT_JOB_OPTIONS: JobOptions = {
  conflict: 'overwrite',
  concurrency: DEFAULT_JOB_CONCURRENCY,
  dryRun: false,
};

const LOG_PAGE_SIZE = 200;

const JOB_TYPE_LABELS: Readonly<Record<JobType, string>> = {
  copy: 'Copy objects',
  move: 'Move objects',
  delete: 'Delete objects',
  tag: 'Tag objects',
  'storage-class': 'Change storage class',
  retention: 'Set retention',
  'restore-versions': 'Restore versions',
  'empty-bucket': 'Empty bucket',
};

@Injectable()
export class JobsService implements JobsPort {
  private readonly log = new Logger(JobsService.name);

  constructor(
    private readonly repository: JobsRepository,
    private readonly servers: ServerRepository,
    private readonly storage: StorageContextService,
    private readonly crypto: CryptoService,
    private readonly engine: JobEngineService,
    private readonly estimator: JobEstimatorService,
  ) {}

  /* ------------------------------ the port -------------------------- */

  /**
   * `JOBS_PORT.enqueue` — what the buckets and objects endpoints call when a
   * request names more work than it can finish. Unchanged in shape from wave 2a's
   * enqueue-only implementation, so no caller had to be touched; the difference is
   * that the row is now picked up.
   */
  enqueue(input: EnqueueJobInput): Job {
    const source = this.requireServer(input.source.serverId);
    const target = input.target === undefined ? null : this.requireServer(input.target.serverId);

    // A selection's prefixes live in `_prefixes`, not in `filters.prefix`: the
    // filter has room for one and the engine needs all of them. `filters` stays
    // at its defaults here, which is what "no filter, work the selection" means.
    const prefixes = (input.source.prefixes ?? []).filter((prefix) => prefix.length > 0);
    const filters: JobFilters = { ...JOB_FILTER_DEFAULTS };
    const options: JobOptions = { ...DEFAULT_JOB_OPTIONS, ...input.options };
    const params: JobParams = input.params ?? {};

    const storedParams: Record<string, unknown> = {
      ...params,
      [STORED_SOURCE_NAME_FIELD]: source.name,
      ...(target === null ? {} : { [STORED_TARGET_NAME_FIELD]: target.name }),
      ...(input.keys === undefined || input.keys.length === 0
        ? {}
        : { [STORED_KEYS_FIELD]: [...input.keys] }),
      ...(prefixes.length === 0 ? {} : { [STORED_PREFIXES_FIELD]: [...prefixes] }),
    };

    const row = this.repository.insert({
      id: this.crypto.newId(),
      parentId: null,
      name: input.name ?? defaultNameFor(input.type, input.source.bucket),
      type: input.type,
      status: 'queued',
      sourceServerId: source.id,
      sourceBucket: input.source.bucket,
      filters,
      targetServerId: target?.id ?? null,
      targetBucket: input.target?.bucket ?? null,
      targetPrefix: input.target?.prefix ?? null,
      params: storedParams,
      options,
      schedule: { kind: 'now' },
      progress: { ...JOB_PROGRESS_ZERO },
      nextRunAt: null,
      waitingFor: null,
      createdAt: new Date().toISOString(),
    });

    this.log.log({ jobId: row.id, type: row.type, bucket: row.sourceBucket }, 'Job queued');
    return this.repository.toContract(row);
  }

  /* ------------------------------- reading -------------------------- */

  list(query: ListJobsQuery, page: PaginationQuery): JobList {
    const { rows, total } = this.repository.list(query.view, page);
    return {
      items: rows.map((row) => this.withLiveProgress(row)),
      total,
      counts: this.repository.counts(),
    };
  }

  findOne(id: string): Job {
    return this.withLiveProgress(this.requireRow(id));
  }

  runs(id: string, page: PaginationQuery): JobRunList {
    const parent = this.requireRow(id);
    const { rows, total } = this.repository.children(parent.id, page);
    return { items: rows.map((row) => this.withLiveProgress(row)), total };
  }

  logs(id: string, query: JobLogsQuery): JobLogsResponse {
    const row = this.requireRow(id);
    const page = this.repository.logs(row.id, query.cursor, query.level, LOG_PAGE_SIZE);
    return { items: [...page.entries], nextCursor: page.nextCursor };
  }

  /* ------------------------------ estimating ------------------------ */

  async estimate(request: EstimateJobRequest): Promise<EstimateJobResponse> {
    const context = this.storage.forServer(request.source.serverId);
    return this.estimator.estimate(context, request.source.bucket, request.source.filters, false);
  }

  /* ------------------------------- writing -------------------------- */

  create(request: CreateJobRequest): Job {
    const source = this.requireServer(request.source.serverId);
    const target = this.resolveTarget(request);

    const schedule = this.buildSchedule(request.schedule);
    const options: JobOptions = {
      ...request.options,
      concurrency: clampConcurrency(request.options.concurrency),
    };

    // An explicit selection from the object browser travels in the same two
    // stored fields `JOBS_PORT.enqueue` writes, so the engine has one way to read
    // a selection whichever endpoint created the job. Empty entries are dropped
    // rather than stored: a `""` prefix is every object in the bucket, which is
    // not what ticking nothing means.
    const keys = (request.source.keys ?? []).filter((key) => key.length > 0);
    const prefixes = (request.source.prefixes ?? []).filter((prefix) => prefix.length > 0);

    const storedParams: Record<string, unknown> = {
      ...request.params,
      [STORED_SOURCE_NAME_FIELD]: source.name,
      ...(target === null ? {} : { [STORED_TARGET_NAME_FIELD]: target.row.name }),
      ...(keys.length === 0 ? {} : { [STORED_KEYS_FIELD]: [...keys] }),
      ...(prefixes.length === 0 ? {} : { [STORED_PREFIXES_FIELD]: [...prefixes] }),
    };

    const row = this.repository.insert({
      id: this.crypto.newId(),
      parentId: null,
      name: request.name ?? defaultNameFor(request.type, request.source.bucket),
      type: request.type,
      status: schedule.status,
      sourceServerId: source.id,
      sourceBucket: request.source.bucket,
      filters: request.source.filters,
      targetServerId: target?.row.id ?? null,
      targetBucket: target?.bucket ?? null,
      targetPrefix: target?.prefix ?? null,
      params: storedParams,
      options,
      schedule: schedule.schedule,
      progress: { ...JOB_PROGRESS_ZERO },
      nextRunAt: schedule.nextRunAt,
      waitingFor: null,
      createdAt: new Date().toISOString(),
    });

    return this.repository.toContract(row);
  }

  /**
   * `enabled` and `schedule` only make sense on a schedule; `concurrency` reaches
   * a running job on its next page. Nothing else about a job is editable, because
   * changing the filters of a job that is half done would make its counters lie.
   */
  update(id: string, request: UpdateJobRequest): Job {
    const row = this.requireRow(id);
    const job = this.repository.toContract(row);
    const patch: Parameters<JobsRepository['update']>[1] = {};

    if (request.name !== undefined) patch.name = request.name;

    if (request.concurrency !== undefined) {
      const concurrency = clampConcurrency(request.concurrency);
      patch.options = { ...job.options, concurrency };
      this.engine.setConcurrency(row.id, concurrency);
    }

    if (request.schedule !== undefined) {
      if (row.status !== 'scheduled') {
        throw new ConflictError(
          'A schedule can only be changed while the job is scheduled. Duplicate it as a schedule instead.',
        );
      }
      const next = this.buildSchedule(request.schedule);
      patch.schedule = { ...next.schedule };
      patch.nextRunAt = next.nextRunAt;
      patch.status = next.status;
    }

    if (request.enabled !== undefined) {
      const schedule = patch.schedule === undefined ? job.schedule : scheduleFrom(patch.schedule);
      if (schedule.kind !== 'cron') {
        throw new ConflictError('Only a recurring (cron) job can be enabled or disabled.');
      }
      const enabled = request.enabled;
      patch.schedule = { ...schedule, enabled };
      // A disabled schedule keeps its expression and loses only its next run, so
      // enabling it again does not need the operator to retype the cron.
      patch.nextRunAt = enabled ? nextRunAfter(schedule.cron, schedule.timezone) : null;
    }

    const updated = this.repository.update(row.id, patch);
    if (updated === null) throw new NotFoundError('No such job.');
    return this.repository.toContract(updated);
  }

  /**
   * A running job is not deleted out from under the engine: it is cancelled first,
   * which is one extra click and the difference between a clean stop and a run
   * writing to a row that is gone.
   */
  delete(id: string): void {
    const row = this.requireRow(id);
    if (row.status === 'running' || this.engine.isRunning(row.id)) {
      throw new ConflictError('Cancel this job before deleting it.');
    }
    this.repository.delete(row.id);
  }

  /* ------------------------------- control -------------------------- */

  pause(id: string): Job {
    const row = this.requireRow(id);
    if (row.status === 'paused') return this.repository.toContract(row);

    if (row.status === 'running') {
      // The engine writes `paused` itself once it has persisted the checkpoint;
      // doing it here would claim a resume point that does not exist yet.
      this.engine.requestPause(row.id);
      return this.repository.toContract(row);
    }

    if (row.status !== 'queued') {
      throw new ConflictError(`A ${row.status} job cannot be paused.`);
    }
    return this.forceStatus(row, 'paused', { waitingFor: null });
  }

  resume(id: string): Job {
    const row = this.requireRow(id);
    if (row.status !== 'paused') {
      throw new ConflictError(`A ${row.status} job cannot be resumed.`);
    }
    this.engine.clearControl(row.id);
    return this.forceStatus(row, 'queued', { waitingFor: null });
  }

  cancel(id: string): Job {
    const row = this.requireRow(id);
    if (isTerminal(row.status as JobStatus)) {
      throw new ConflictError(`This job is already ${row.status}.`);
    }

    if (row.status === 'running') {
      this.engine.requestCancel(row.id);
      return this.repository.toContract(row);
    }
    return this.forceStatus(row, 'cancelled', {
      finishedAt: new Date().toISOString(),
      waitingFor: null,
    });
  }

  /**
   * "Run it now."
   *
   * On a **schedule** that means a child run, identical to the one the cron would
   * have produced — the schedule itself keeps its next run, so testing a schedule
   * does not push it back.
   *
   * On a **finished job** it means this row again: counters and checkpoint reset,
   * logs cleared, back to `queued`. Keeping the old log alongside a new run would
   * make the log a mix of two runs with no way to tell them apart.
   */
  runNow(id: string): Job {
    const row = this.requireRow(id);

    if (row.status === 'scheduled') return this.spawnRun(row);
    if (row.status === 'paused') return this.resume(id);
    if (row.status === 'queued') return this.repository.toContract(row);
    if (row.status === 'running') throw new ConflictError('This job is already running.');

    this.repository.clearLogs(row.id);
    this.engine.clearControl(row.id);
    const updated = this.repository.update(row.id, {
      status: 'queued',
      progress: { ...JOB_PROGRESS_ZERO },
      checkpoint: null,
      startedAt: null,
      finishedAt: null,
      waitingFor: null,
    });
    if (updated === null) throw new NotFoundError('No such job.');
    return this.repository.toContract(updated);
  }

  /**
   * A copy of the job, either as a fresh one-off run or — with `asSchedule` — as a
   * recurring schedule built from the same source, filters, params and options.
   * Nothing is carried over from the original run: no progress, no checkpoint, no
   * log, no parent.
   */
  duplicate(id: string, request: DuplicateJobRequest): Job {
    const row = this.requireRow(id);
    const job = this.repository.toContract(row);

    const asSchedule = request.asSchedule;
    if (asSchedule !== undefined) assertCron(asSchedule.cron, asSchedule.timezone);

    const schedule: JobSchedule =
      asSchedule === undefined
        ? { kind: 'now' }
        : {
            kind: 'cron',
            cron: asSchedule.cron,
            timezone: asSchedule.timezone,
            enabled: true,
            nextRunAt: null,
          };

    const created = this.repository.insert({
      id: this.crypto.newId(),
      parentId: null,
      name: asSchedule === undefined ? `${job.name} (copy)` : `${job.name} (schedule)`,
      type: job.type,
      status: asSchedule === undefined ? 'queued' : 'scheduled',
      sourceServerId: row.sourceServerId,
      sourceBucket: row.sourceBucket,
      filters: job.source.filters,
      targetServerId: row.targetServerId,
      targetBucket: row.targetBucket,
      targetPrefix: row.targetPrefix,
      params: { ...row.params },
      options: job.options,
      schedule,
      progress: { ...JOB_PROGRESS_ZERO },
      nextRunAt:
        asSchedule === undefined ? null : nextRunAfter(asSchedule.cron, asSchedule.timezone),
      waitingFor: null,
      createdAt: new Date().toISOString(),
    });

    return this.repository.toContract(created);
  }

  /**
   * One run of a recurring schedule. Called by `run-now` and by the scheduler, so
   * a manual run and a cron-fired one are the same row shape — which is what makes
   * `GET /jobs/:id/runs` a complete history rather than only the automatic ones.
   */
  spawnRun(parent: JobRow): Job {
    const job = this.repository.toContract(parent);
    const created = this.repository.insert({
      id: this.crypto.newId(),
      parentId: parent.id,
      name: job.name,
      type: job.type,
      status: 'queued',
      sourceServerId: parent.sourceServerId,
      sourceBucket: parent.sourceBucket,
      filters: job.source.filters,
      targetServerId: parent.targetServerId,
      targetBucket: parent.targetBucket,
      targetPrefix: parent.targetPrefix,
      params: { ...parent.params },
      options: job.options,
      // The run is not itself a schedule: it runs once, now.
      schedule: { kind: 'now' },
      progress: { ...JOB_PROGRESS_ZERO },
      nextRunAt: null,
      waitingFor: null,
      createdAt: new Date().toISOString(),
    });
    return this.repository.toContract(created);
  }

  /* ------------------------------ internals ------------------------- */

  /**
   * The stored progress is written once per page, so a job mid-page would report
   * counters a few hundred objects behind. The engine's in-memory figures are the
   * live ones, and this is where the two are reconciled — one place, so the list,
   * the detail and the dashboard cannot disagree.
   */
  private withLiveProgress(row: JobRow): Job {
    const job = this.repository.toContract(row);
    const live = this.engine.liveProgress(row.id);
    return live === null ? job : { ...job, progress: live };
  }

  private forceStatus(
    row: JobRow,
    status: JobStatus,
    patch: { finishedAt?: string; waitingFor?: string | null },
  ): Job {
    const updated = this.repository.update(row.id, { status, ...patch });
    if (updated === null) throw new NotFoundError('No such job.');
    return this.repository.toContract(updated);
  }

  private resolveTarget(request: CreateJobRequest): ResolvedTarget | null {
    const wanted = request.target;
    if (TARGET_REQUIRED_TYPES.includes(request.type)) {
      if (wanted === undefined) {
        throw new ValidationError(`A ${request.type} job needs a target server and bucket.`);
      }
      const row = this.requireServer(wanted.serverId);
      return { row, bucket: wanted.bucket, prefix: wanted.prefix };
    }
    // A target on a delete or tag job is meaningless; dropping it is kinder than a
    // 400 on a field the wizard may send for every type.
    return null;
  }

  private buildSchedule(input: JobScheduleInput): BuiltSchedule {
    switch (input.kind) {
      case 'now':
        return { schedule: { kind: 'now' }, status: 'queued', nextRunAt: null };
      case 'at': {
        const at = Date.parse(input.at);
        if (Number.isNaN(at)) throw new ValidationError('`at` must be an ISO-8601 date-time.');
        return { schedule: { kind: 'at', at: input.at }, status: 'scheduled', nextRunAt: input.at };
      }
      case 'cron': {
        assertCron(input.cron, input.timezone);
        const nextRunAt = input.enabled ? nextRunAfter(input.cron, input.timezone) : null;
        return {
          schedule: {
            kind: 'cron',
            cron: input.cron,
            timezone: input.timezone,
            enabled: input.enabled,
            nextRunAt,
          },
          status: 'scheduled',
          nextRunAt,
        };
      }
    }
  }

  private requireRow(id: string): JobRow {
    const row = this.repository.findById(id);
    if (row === null) throw new NotFoundError(`No job with id "${id}".`);
    return row;
  }

  private requireServer(idOrName: string): ServerRow {
    const row = this.servers.findByIdOrName(idOrName);
    if (row === null) throw new NotFoundError(`No server named "${idOrName}".`);
    return row;
  }
}

/* ------------------------------ helpers --------------------------- */

interface ResolvedTarget {
  readonly row: ServerRow;
  readonly bucket: string;
  readonly prefix: string;
}

interface BuiltSchedule {
  readonly schedule: JobSchedule;
  readonly status: JobStatus;
  readonly nextRunAt: string | null;
}

const isTerminal = (status: JobStatus): boolean =>
  (JOB_TERMINAL_STATUSES as readonly JobStatus[]).includes(status);

const defaultNameFor = (type: JobType, bucket: string): string =>
  `${JOB_TYPE_LABELS[type]} · ${bucket}`;

/** Narrows a stored schedule blob back to the union, for the `enabled` path. */
function scheduleFrom(stored: JobSchedule | Record<string, unknown>): JobSchedule {
  const kind = (stored as { kind?: unknown }).kind;
  if (kind === 'cron' || kind === 'at' || kind === 'now') return stored as JobSchedule;
  return { kind: 'now' };
}

export { versionsNeededFor };
