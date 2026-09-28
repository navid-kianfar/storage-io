import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  JOB_CONCURRENCY_MAX,
  JOB_CONCURRENCY_MIN,
  type Job,
  type JobLogLevel,
  type JobProgress,
  type JobStatus,
  type JobType,
} from '@storage-io/contracts';
import { AppConfigService } from '../../config/app-config.service';
import { ActivityService } from '../../activity/activity.service';
import { EventBusService } from '../../events/event-bus.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { ServerRepository } from '../../servers/server.repository';
import { StorageContextService, type StorageContext } from '../storage/storage-context.service';
import { sanitizeProviderMessage } from '../../common/errors/provider-error.mapper';
import type { JobRow } from '../../db/schema';
import { JobsRepository } from './jobs.repository';
import { JobSourceService, type JobPage } from './job-source.service';
import { JobEstimatorService } from './job-estimator.service';
import {
  BATCHED_DELETE_TYPES,
  DELETE_BATCH_SIZE,
  JobActionsService,
  type JobExecution,
} from './job-actions.service';
import type { JobCandidate } from './job-filters';

/**
 * The engine: it takes `queued` rows and does the work.
 *
 * ## The shape of a run
 *
 * One page at a time. A page is listed, its objects are processed through a pool,
 * and only when the whole page is done are the counters and the page's
 * continuation token written to the row. That is what makes resume exact: a crash
 * costs at most one page, replayed, and every action here is idempotent enough to
 * survive a replay (a copy overwrites, a delete of an absent key succeeds, a tag
 * merge is the same merge). Persisting per object would need a second record of
 * which keys in the page had finished — a checkpoint format nobody needs.
 *
 * ## Pacing and control
 *
 * `options.concurrency` is read from the row on every page, so a PATCH takes
 * effect on the next page rather than at the next run. Raising it takes effect as
 * soon as a worker finishes; lowering it drains the in-flight work first, because
 * cancelling a copy halfway is worse than letting it land.
 *
 * Pause, resume and cancel are flags, checked between objects and between pages.
 * A paused job keeps its checkpoint, so resuming is the same code path as
 * resuming after a restart.
 *
 * ## Offline servers
 *
 * A queued job whose source or target is offline is left queued with `waitingFor`
 * set, and the tick tries again — so it starts by itself when the health checker
 * sees the server come back. A server that goes offline *during* a run puts the
 * job back to `queued` with the same `waitingFor` rather than failing it: the work
 * is half done and finishing it later is what the operator wants.
 *
 * ## What it is not
 *
 * Not a distributed queue. storage-io is one process by design (see
 * docs/ARCHITECTURE.md), so the claim on a row is a status change and nothing
 * else; a second process would need a lease column and this file would be wrong.
 */

/** How often the engine looks for work. */
const TICK_INTERVAL_MS = 2_000;
/** Jobs run at once. Each has its own object pool, so this multiplies. */
const MAX_PARALLEL_JOBS = 2;
/**
 * Queued rows examined per pass. It is larger than `MAX_PARALLEL_JOBS` on purpose:
 * a job at the head of the queue whose server is offline cannot start, and reading
 * only as many rows as there are slots would let two such jobs block every other
 * job in the installation until their server came back.
 */
const QUEUE_SCAN_LIMIT = 50;
/** `job.progress` on the SSE stream, at most this often per job. */
const PROGRESS_EVENT_INTERVAL_MS = 1_000;
/** The window the throughput and ETA figures are averaged over. */
const RATE_WINDOW_MS = 15_000;
/** Log lines buffered before they are written, so a page is one insert. */
const LOG_FLUSH_SIZE = 50;
/** Per-object failures logged in full before the log only counts them. */
const MAX_LOGGED_FAILURES = 200;

type Control = 'pause' | 'cancel';

interface RateSample {
  readonly at: number;
  readonly processed: number;
  readonly bytes: number;
}

/** Everything a run holds in memory. Nothing here survives a restart. */
interface RunState {
  progress: JobProgress;
  concurrency: number;
  loggedFailures: number;
  readonly samples: RateSample[];
  lastEventAt: number;
  readonly pending: { level: JobLogLevel; message: string; key: string | null; at: string }[];
}

@Injectable()
export class JobEngineService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(JobEngineService.name);
  private readonly controls = new Map<string, Control>();
  private readonly runs = new Map<string, RunState>();
  private stopped = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly repository: JobsRepository,
    private readonly servers: ServerRepository,
    private readonly storage: StorageContextService,
    private readonly source: JobSourceService,
    private readonly actions: JobActionsService,
    private readonly estimator: JobEstimatorService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly bus: EventBusService,
  ) {}

  /**
   * Anything the database still calls `running` is a job this process died inside.
   * It goes back to `queued` with its checkpoint intact, and the first tick picks
   * it up where it stopped.
   */
  onApplicationBootstrap(): void {
    const interrupted = this.repository.interruptedRuns();
    for (const row of interrupted) {
      this.repository.update(row.id, {
        status: 'queued',
        waitingFor: 'resuming after a restart',
      });
      this.repository.appendLogs(row.id, [
        {
          at: new Date().toISOString(),
          level: 'warn',
          message:
            'storage-io restarted while this job was running; it resumes from its checkpoint.',
          key: null,
        },
      ]);
    }
    if (interrupted.length > 0) {
      this.log.log({ jobs: interrupted.length }, 'Requeued interrupted job runs');
    }
    if (!this.config.jobEngineEnabled) {
      this.log.log('Job engine disabled by JOB_ENGINE_ENABLED');
    }
  }

  onApplicationShutdown(): void {
    this.stopped = true;
  }

  /* ------------------------------ the loop -------------------------- */

  @Interval(TICK_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.stopped || !this.config.jobEngineEnabled) return;
    await this.drain();
  }

  /**
   * One pass over the queue, without the `JOB_ENGINE_ENABLED` guard.
   *
   * Separated from `tick` so a test can drive a run deterministically: the suites
   * run with the engine off, because a background interval that claimed a row in
   * the middle of an assertion about that row would make every jobs test flaky.
   *
   * It awaits each run it starts, so a caller that awaits it knows the work is
   * done — which is the other half of what makes a test deterministic.
   */
  async drain(): Promise<void> {
    if (this.runs.size >= MAX_PARALLEL_JOBS) return;

    for (const row of this.repository.queued(QUEUE_SCAN_LIMIT)) {
      if (this.stopped) return;
      if (this.runs.size >= MAX_PARALLEL_JOBS) return;
      if (this.runs.has(row.id)) continue;
      // A job that cannot start — its server is offline — has `waitingFor` written
      // and is skipped, and the pass moves on to one that can.
      await this.start(row);
    }
  }

  /** True while the engine is working on this job. */
  isRunning(jobId: string): boolean {
    return this.runs.has(jobId);
  }

  /** The live counters, for a GET that arrives mid-page. */
  liveProgress(jobId: string): JobProgress | null {
    return this.runs.get(jobId)?.progress ?? null;
  }

  /** Applied on the next page; see the note on pacing above. */
  setConcurrency(jobId: string, concurrency: number): void {
    const state = this.runs.get(jobId);
    if (state === undefined) return;
    state.concurrency = clampConcurrency(concurrency);
  }

  requestPause(jobId: string): void {
    this.controls.set(jobId, 'pause');
  }

  requestCancel(jobId: string): void {
    this.controls.set(jobId, 'cancel');
  }

  /** A job that was never started needs its flag cleared before it is requeued. */
  clearControl(jobId: string): void {
    this.controls.delete(jobId);
  }

  /* -------------------------------- a run --------------------------- */

  private async start(row: JobRow): Promise<void> {
    const resolved = this.resolveContexts(row);
    if (resolved === null) return;

    this.runs.set(row.id, {
      progress: this.repository.toContract(row).progress,
      concurrency: clampConcurrency(this.repository.toContract(row).options.concurrency),
      loggedFailures: 0,
      samples: [],
      lastEventAt: 0,
      pending: [],
    });

    try {
      await this.run(row, resolved);
    } catch (error) {
      // Reaching here means the failure was not per-object: the listing broke, or
      // the source bucket is gone. The job fails, with a message an operator can
      // act on and the detail in the log.
      const message = sanitizeProviderMessage(
        error instanceof Error ? error.message : String(error),
      );
      this.appendLog(row.id, 'error', `The job stopped: ${message}`, null);
      this.finish(row.id, 'failed', message);
      this.log.error({ jobId: row.id, err: message }, 'Job run failed');
    } finally {
      this.flushLogs(row.id);
      this.runs.delete(row.id);
      this.controls.delete(row.id);
    }
  }

  private async run(row: JobRow, contexts: ResolvedContexts): Promise<void> {
    const job = this.repository.toContract(row);
    const state = this.runs.get(row.id);
    if (state === undefined) return;

    const startedAt = row.startedAt ?? new Date().toISOString();
    this.transition(row.id, 'running', row.status as JobStatus, { startedAt, waitingFor: null });
    this.appendLog(
      row.id,
      'info',
      job.options.dryRun
        ? `Dry run: ${job.type} on ${job.source.serverName}/${job.source.bucket} — nothing will be changed.`
        : `Started ${job.type} on ${job.source.serverName}/${job.source.bucket}.`,
      null,
    );

    const includeVersions = versionsNeededFor(job);
    const plan = planSegments(
      this.repository.storedKeys(row),
      this.repository.storedPrefixes(row),
      job.source.filters.prefix,
    );

    if (state.progress.total === null) {
      state.progress = {
        ...state.progress,
        total: await this.planTotal(contexts.source, job, plan, includeVersions),
      };
    }

    const execution: JobExecution = {
      type: job.type,
      source: contexts.source,
      sourceBucket: job.source.bucket,
      target: contexts.target,
      targetBucket: job.target?.bucket ?? null,
      targetPrefix: job.target?.prefix ?? '',
      params: job.params,
      options: job.options,
    };

    let checkpoint = parseCheckpoint(row.checkpoint);
    while (checkpoint.segment < plan.length) {
      const control = this.controls.get(row.id);
      if (control !== undefined) {
        this.handleControl(row.id, control, checkpoint);
        return;
      }
      if (this.stopped) {
        // Shutdown: the row stays `running` and `onApplicationBootstrap` requeues
        // it. Writing `paused` here would need an operator to resume by hand after
        // a restart they did not ask about.
        this.persist(row.id, checkpoint, state.progress);
        return;
      }
      if (this.sourceWentOffline(row, checkpoint, state.progress)) return;

      const segment = plan[checkpoint.segment] as JobSegment;
      const page = await this.listPage(contexts.source, job, segment, checkpoint, includeVersions);
      const done = await this.processPage(row.id, execution, page, job, checkpoint.cursor);

      if (checkpoint.cursor + done < page.items.length) {
        // A page only ends early because a pause, a cancel or a shutdown said so.
        // The checkpoint therefore stays *on this page* and records how far into
        // it the run got: advancing to `nextToken` here is what used to drop the
        // rest of the page on the floor and make a resume skip those objects.
        checkpoint = { ...checkpoint, cursor: checkpoint.cursor + done };
        this.emitProgress(row.id, state, true);
        const interrupted = this.controls.get(row.id);
        if (interrupted !== undefined) {
          this.handleControl(row.id, interrupted, checkpoint);
          return;
        }
        this.persist(row.id, checkpoint, state.progress);
        return;
      }

      checkpoint =
        page.nextToken === null
          ? { segment: checkpoint.segment + 1, token: null, cursor: 0 }
          : { segment: checkpoint.segment, token: page.nextToken, cursor: 0 };
      this.persist(row.id, checkpoint, state.progress);
      this.emitProgress(row.id, state, true);
    }

    const outcome = outcomeFor(state.progress);
    this.finish(row.id, outcome, null);
    this.reportCompletion(job, outcome, state.progress);
  }

  /**
   * One page, from `skip` onwards, and how many of those entries it got through.
   *
   * The answer is a *count from the start of the slice*, not a set of keys, and
   * that only works because the pool dispatches in order and `runWithPool` waits
   * for everything it dispatched before it resolves: the entries it reports are
   * therefore a contiguous run from the front, which is the one shape a single
   * number can describe.
   */
  private async processPage(
    jobId: string,
    execution: JobExecution,
    page: JobPage,
    job: Job,
    skip: number,
  ): Promise<number> {
    const state = this.runs.get(jobId);
    if (state === undefined) return 0;

    const items = skip === 0 ? page.items : page.items.slice(skip);
    if (items.length === 0) return 0;

    if (job.options.dryRun) {
      // A dry run reports what the filters matched, which is the question it is
      // asked. It deliberately does not probe the destination for conflicts: that
      // is a HEAD per object, and an operator sizing a job is not waiting for it.
      state.progress = {
        ...state.progress,
        processed: state.progress.processed + items.length,
        bytes: state.progress.bytes + items.reduce((total, item) => total + item.size, 0),
      };
      this.recordRate(state);
      this.emitProgress(jobId, state, false);
      return items.length;
    }

    if (BATCHED_DELETE_TYPES.includes(execution.type)) {
      return this.processDeletes(jobId, execution, items);
    }

    return runWithPool(
      items,
      () => state.concurrency,
      async (candidate) => {
        await this.applyOne(jobId, execution, candidate);
      },
      () => this.controls.has(jobId) || this.stopped,
    );
  }

  /** Entries deleted, counted from the start of `items` — see `processPage`. */
  private async processDeletes(
    jobId: string,
    execution: JobExecution,
    items: readonly JobCandidate[],
  ): Promise<number> {
    const state = this.runs.get(jobId);
    if (state === undefined) return 0;

    for (let offset = 0; offset < items.length; offset += DELETE_BATCH_SIZE) {
      if (this.controls.has(jobId) || this.stopped) return offset;
      const batch = items.slice(offset, offset + DELETE_BATCH_SIZE);
      const result = await this.actions.deleteBatch(execution, batch);

      const deletedBytes = batch
        .filter((candidate) => !result.failures.some((failure) => failure.key === candidate.key))
        .reduce((total, candidate) => total + candidate.size, 0);

      state.progress = {
        ...state.progress,
        processed: state.progress.processed + result.deleted,
        failed: state.progress.failed + result.failures.length,
        bytes: state.progress.bytes + deletedBytes,
      };

      for (const failure of result.failures) {
        this.appendFailure(jobId, failure.key, failure.message);
      }
      this.recordRate(state);
      this.emitProgress(jobId, state, false);
    }
    return items.length;
  }

  private async applyOne(
    jobId: string,
    execution: JobExecution,
    candidate: JobCandidate,
  ): Promise<void> {
    const state = this.runs.get(jobId);
    if (state === undefined) return;

    try {
      const outcome = await this.actions.applyOne(execution, candidate);
      state.progress =
        outcome === 'skipped'
          ? { ...state.progress, skipped: state.progress.skipped + 1 }
          : {
              ...state.progress,
              processed: state.progress.processed + 1,
              bytes: state.progress.bytes + candidate.size,
            };
    } catch (error) {
      // A per-object failure is data, not an exception: "nine of ten copied" is
      // the normal outcome when one object is under a retention lock.
      state.progress = { ...state.progress, failed: state.progress.failed + 1 };
      this.appendFailure(
        jobId,
        candidate.key,
        sanitizeProviderMessage(error instanceof Error ? error.message : String(error)),
      );
    }

    this.recordRate(state);
    this.emitProgress(jobId, state, false);
  }

  /* --------------------------- the source --------------------------- */

  /**
   * One page of whichever segment the checkpoint is on.
   *
   * A prefix segment overrides `filters.prefix` with its own, because that field
   * is the *listing* prefix and each selected folder is its own listing. Every
   * other filter — glob, size, dates, tags — still applies to all of them.
   */
  private listPage(
    source: StorageContext,
    job: Job,
    segment: JobSegment,
    checkpoint: JobCheckpoint,
    includeVersions: boolean,
  ): Promise<JobPage> | JobPage {
    if (segment.kind === 'keys') {
      const offset = checkpoint.token === null ? 0 : Number(checkpoint.token);
      return this.source.keyPage(segment.keys, offset);
    }
    return this.source.page({
      client: source.client,
      bucket: job.source.bucket,
      filters: { ...job.source.filters, prefix: segment.prefix },
      includeVersions,
      startToken: checkpoint.token,
    });
  }

  /**
   * The job's `progress.total`, summed over the plan.
   *
   * One segment whose listing did not finish inside its budget makes the whole
   * total `null` rather than a sum that is missing a folder: a progress bar
   * against a number known to be too small reads as a job that overshoots 100%.
   */
  private async planTotal(
    source: StorageContext,
    job: Job,
    plan: readonly JobSegment[],
    includeVersions: boolean,
  ): Promise<number | null> {
    let total = 0;
    for (const segment of plan) {
      if (segment.kind === 'keys') {
        total += segment.keys.length;
        continue;
      }
      const part = await this.estimator.totalFor(
        source,
        job.source.bucket,
        { ...job.source.filters, prefix: segment.prefix },
        includeVersions,
      );
      if (part === null) return null;
      total += part;
    }
    return total;
  }

  /* ----------------------------- control ---------------------------- */

  private handleControl(jobId: string, control: Control, checkpoint: JobCheckpoint): void {
    const state = this.runs.get(jobId);
    const progress = state?.progress;
    this.controls.delete(jobId);

    if (control === 'pause') {
      this.persist(jobId, checkpoint, progress);
      this.transition(jobId, 'paused', 'running', {});
      this.appendLog(jobId, 'info', 'Paused. Resuming continues from this point.', null);
      return;
    }

    this.persist(jobId, checkpoint, progress);
    this.transition(jobId, 'cancelled', 'running', { finishedAt: new Date().toISOString() });
    this.appendLog(jobId, 'warn', 'Cancelled by the operator.', null);
  }

  /**
   * True when the source or target went offline mid-run. The job goes back to
   * `queued` with `waitingFor`, so the tick restarts it once the health checker
   * sees the server again.
   */
  private sourceWentOffline(
    row: JobRow,
    checkpoint: JobCheckpoint,
    progress: JobProgress | undefined,
  ): boolean {
    const offline = this.offlineServerName(row);
    if (offline === null) return false;

    this.persist(row.id, checkpoint, progress);
    this.repository.update(row.id, { status: 'queued', waitingFor: `${offline} offline` });
    this.bus.publish('job.status', {
      jobId: row.id,
      status: 'queued',
      previousStatus: 'running',
      at: new Date().toISOString(),
    });
    this.appendLog(row.id, 'warn', `${offline} went offline; waiting to continue.`, null);
    return true;
  }

  /* ------------------------------ plumbing -------------------------- */

  /**
   * `null` when a server the job needs is offline or missing — the row is left
   * `queued` with `waitingFor`, which is exactly what the contract field is for.
   */
  private resolveContexts(row: JobRow): ResolvedContexts | null {
    const offline = this.offlineServerName(row);
    if (offline !== null) {
      const waitingFor = `${offline} offline`;
      if (row.waitingFor !== waitingFor) this.repository.update(row.id, { waitingFor });
      return null;
    }

    try {
      const source = this.storage.forServer(row.sourceServerId);
      const target =
        row.targetServerId === null
          ? null
          : row.targetServerId === row.sourceServerId
            ? source
            : this.storage.forServer(row.targetServerId);
      return { source, target };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendLog(row.id, 'error', message, null);
      this.flushLogs(row.id);
      this.finish(row.id, 'failed', message);
      return null;
    }
  }

  /** The first server the job needs that is not reachable, or null. */
  private offlineServerName(row: JobRow): string | null {
    const ids = [row.sourceServerId, ...(row.targetServerId === null ? [] : [row.targetServerId])];
    for (const id of ids) {
      const server = this.servers.findByIdOrName(id);
      if (server === null) return id;
      if (server.status === 'offline' || server.maintenance) return server.name;
    }
    return null;
  }

  private persist(
    jobId: string,
    checkpoint: JobCheckpoint,
    progress: JobProgress | undefined,
  ): void {
    this.repository.update(jobId, {
      checkpoint: serializeCheckpoint(checkpoint),
      ...(progress === undefined ? {} : { progress: { ...progress } }),
    });
    this.flushLogs(jobId);
  }

  private transition(
    jobId: string,
    status: JobStatus,
    previousStatus: JobStatus,
    patch: { startedAt?: string; finishedAt?: string; waitingFor?: string | null },
  ): void {
    this.repository.update(jobId, { status, ...patch });
    this.bus.publish('job.status', {
      jobId,
      status,
      previousStatus,
      at: new Date().toISOString(),
    });
  }

  /**
   * `detail` goes to the job log, never to `waitingFor`: the contract's
   * `waitingFor` answers "why has this queued job not started", and a finished job
   * is not waiting for anything. A failure's reason belongs in the log, where it
   * sits beside the per-object errors that explain it.
   */
  private finish(jobId: string, status: JobStatus, detail: string | null): void {
    const state = this.runs.get(jobId);
    const finishedAt = new Date().toISOString();
    if (detail !== null) this.appendLog(jobId, 'error', detail, null);
    this.repository.update(jobId, {
      status,
      finishedAt,
      // A terminal job has no resume point and is not waiting for a server.
      checkpoint: null,
      waitingFor: null,
      ...(state === undefined
        ? {}
        : { progress: { ...state.progress, objectsPerSec: 0, bytesPerSec: 0, etaSeconds: null } }),
    });
    this.bus.publish('job.status', {
      jobId,
      status,
      previousStatus: 'running',
      at: finishedAt,
    });
    this.flushLogs(jobId);
  }

  /**
   * The activity row and, on a failure, the notification. Both are the record an
   * operator finds later, which is why the counts are in the title rather than
   * only in the job.
   */
  private reportCompletion(job: Job, status: JobStatus, progress: JobProgress): void {
    const summary = `${progress.processed} processed, ${progress.skipped} skipped, ${progress.failed} failed`;
    const failed = status === 'failed' || status === 'completed_with_errors';

    this.activity.record({
      category: 'jobs',
      action: `job.${status}`,
      title: `${job.name}: ${summary}`,
      actor: { type: 'system', name: 'job-engine' },
      result: failed ? 'warning' : 'success',
      target: `${job.source.bucket}`,
      serverId: job.source.serverId,
      serverName: job.source.serverName,
      details: {
        jobId: job.id,
        type: job.type,
        dryRun: job.options.dryRun,
        processed: progress.processed,
        skipped: progress.skipped,
        failed: progress.failed,
        bytes: progress.bytes,
      },
    });

    this.appendLog(job.id, failed ? 'warn' : 'info', `Finished: ${summary}.`, null);
    this.flushLogs(job.id);

    if (!failed) return;
    this.notifications.raise({
      level: status === 'failed' ? 'error' : 'warning',
      title: `${job.name} finished with errors`,
      detail: summary,
      href: `/jobs/${job.id}`,
      ruleKey: 'job.failed',
      // One notification per job, not per retry of the same schedule.
      fingerprint: `job.failed:${job.id}`,
    });
  }

  /* -------------------------------- rates --------------------------- */

  private recordRate(state: RunState): void {
    const now = Date.now();
    state.samples.push({
      at: now,
      processed: state.progress.processed,
      bytes: state.progress.bytes,
    });
    while (state.samples.length > 1 && now - (state.samples[0]?.at ?? now) > RATE_WINDOW_MS) {
      state.samples.shift();
    }

    const oldest = state.samples[0];
    if (oldest === undefined || now === oldest.at) return;

    const elapsedSec = (now - oldest.at) / 1000;
    const objectsPerSec = (state.progress.processed - oldest.processed) / elapsedSec;
    const bytesPerSec = (state.progress.bytes - oldest.bytes) / elapsedSec;
    const remaining =
      state.progress.total === null
        ? null
        : Math.max(0, state.progress.total - state.progress.processed);

    state.progress = {
      ...state.progress,
      objectsPerSec: Math.max(0, objectsPerSec),
      bytesPerSec: Math.max(0, bytesPerSec),
      etaSeconds:
        remaining === null || objectsPerSec <= 0 ? null : Math.round(remaining / objectsPerSec),
    };
  }

  /** Throttled to roughly one event per second per job; `force` ignores the throttle. */
  private emitProgress(jobId: string, state: RunState, force: boolean): void {
    const now = Date.now();
    if (!force && now - state.lastEventAt < PROGRESS_EVENT_INTERVAL_MS) return;
    state.lastEventAt = now;
    this.bus.publish('job.progress', {
      jobId,
      progress: { ...state.progress },
      at: new Date().toISOString(),
    });
  }

  /* --------------------------------- logs --------------------------- */

  private appendLog(jobId: string, level: JobLogLevel, message: string, key: string | null): void {
    const state = this.runs.get(jobId);
    const entry = { at: new Date().toISOString(), level, message, key };
    if (state === undefined) {
      this.repository.appendLogs(jobId, [entry]);
      return;
    }
    state.pending.push(entry);
    if (state.pending.length >= LOG_FLUSH_SIZE) this.flushLogs(jobId);
  }

  /**
   * A job that fails on every one of a million objects must not write a million
   * log rows. The first `MAX_LOGGED_FAILURES` are recorded in full; after that the
   * count in `progress.failed` is the record, and one line says so.
   */
  private appendFailure(jobId: string, key: string, message: string): void {
    const state = this.runs.get(jobId);
    if (state === undefined) return;

    if (state.loggedFailures < MAX_LOGGED_FAILURES) {
      state.loggedFailures += 1;
      this.appendLog(jobId, 'error', message, key);
      return;
    }
    if (state.loggedFailures === MAX_LOGGED_FAILURES) {
      state.loggedFailures += 1;
      this.appendLog(
        jobId,
        'warn',
        `More than ${MAX_LOGGED_FAILURES} objects failed; further failures are counted but not listed.`,
        null,
      );
    }
  }

  private flushLogs(jobId: string): void {
    const state = this.runs.get(jobId);
    if (state === undefined || state.pending.length === 0) return;
    const entries = state.pending.splice(0, state.pending.length);
    this.repository.appendLogs(jobId, entries);
  }
}

/* ------------------------------ helpers --------------------------- */

interface ResolvedContexts {
  readonly source: StorageContext;
  readonly target: StorageContext | null;
}

/* ---------------------------- the plan ----------------------------- */

/**
 * One stretch of work: either the explicit keys an operator picked, or one
 * selected prefix to list.
 */
export type JobSegment =
  | { readonly kind: 'keys'; readonly keys: readonly string[] }
  | { readonly kind: 'prefix'; readonly prefix: string };

/**
 * The segments a run walks, in order, with the overlaps removed.
 *
 * The union has to be exact in both directions — every selected object worked on,
 * none of them twice — and the cheap place to make it exact is here, on the
 * *selection*, not later on the listed keys:
 *
 * - A prefix contained in another prefix (`p1/sub/` under `p1/`) is dropped,
 *   because listing `p1/` already returns everything under it.
 * - An explicit key that falls under a surviving prefix is dropped for the same
 *   reason.
 *
 * What is left cannot overlap: two prefixes where neither contains the other list
 * disjoint key sets, and the remaining keys are under none of them. So the run
 * needs no set of keys it has already seen — which matters, because that set
 * would have to survive a pause and a restart to be worth anything.
 *
 * With nothing selected the plan is the single filter-defined listing, which is
 * what `POST /jobs` creates and what every job did before selections carried more
 * than one prefix.
 */
export function planSegments(
  explicitKeys: readonly string[] | null,
  explicitPrefixes: readonly string[],
  filterPrefix: string,
): readonly JobSegment[] {
  const prefixes = distinct(explicitPrefixes).filter(
    (prefix, _index, all) => !all.some((other) => other !== prefix && prefix.startsWith(other)),
  );
  const keys = distinct(explicitKeys ?? []).filter(
    (key) => !prefixes.some((prefix) => key.startsWith(prefix)),
  );

  const segments: JobSegment[] = [];
  if (keys.length > 0) segments.push({ kind: 'keys', keys });
  for (const prefix of prefixes) segments.push({ kind: 'prefix', prefix });

  if (segments.length > 0) return segments;
  // Nothing was selected, or every selected key was swallowed by a prefix that
  // itself turned out to be empty: fall back to the filter's own listing.
  return [{ kind: 'prefix', prefix: filterPrefix }];
}

const distinct = (values: readonly string[]): readonly string[] => [...new Set(values)];

/* -------------------------- the checkpoint -------------------------- */

/**
 * Where a run stopped, precisely enough to start again without redoing or
 * skipping anything.
 *
 * `token` is the token the **current** page was listed with, not the next one.
 * That is the whole fix: storing `nextToken` after a pause that happened in the
 * middle of a page threw away the rest of that page, and the resume started at
 * the page after it.
 */
export interface JobCheckpoint {
  /** Index into the plan `planSegments` produced. */
  readonly segment: number;
  /** The continuation token (or key offset) the current page was listed with. */
  readonly token: string | null;
  /** Entries of the current page already processed, counted from its start. */
  readonly cursor: number;
}

export const CHECKPOINT_START: JobCheckpoint = { segment: 0, token: null, cursor: 0 };

export const serializeCheckpoint = (checkpoint: JobCheckpoint): string =>
  JSON.stringify(checkpoint);

/**
 * A checkpoint written before this format existed is a bare continuation token,
 * which is exactly `{ segment: 0, token: <it>, cursor: 0 }` — the first segment,
 * at the start of that page. So an upgrade resumes an in-flight job correctly
 * instead of restarting it.
 */
export function parseCheckpoint(raw: string | null): JobCheckpoint {
  if (raw === null || raw.length === 0) return CHECKPOINT_START;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isCheckpoint(parsed)) {
      return { segment: parsed.segment, token: parsed.token, cursor: parsed.cursor };
    }
  } catch {
    // Not JSON at all, so it is a token from the old format.
  }
  return { segment: 0, token: raw, cursor: 0 };
}

function isCheckpoint(value: unknown): value is JobCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['segment'] === 'number' &&
    typeof candidate['cursor'] === 'number' &&
    (candidate['token'] === null || typeof candidate['token'] === 'string')
  );
}

export const clampConcurrency = (value: number): number =>
  Math.min(JOB_CONCURRENCY_MAX, Math.max(JOB_CONCURRENCY_MIN, Math.trunc(value)));

/**
 * Which job types have to walk versions and delete markers.
 *
 * `empty-bucket` must: deleting only the current versions of a versioned bucket
 * leaves it full and `DeleteBucket` still fails. `restore-versions` must, because
 * a delete marker is the only thing it acts on. Everything else follows
 * `params.includeVersions`.
 */
export function versionsNeededFor(job: Job): boolean {
  const alwaysVersioned: readonly JobType[] = ['empty-bucket', 'restore-versions'];
  if (alwaysVersioned.includes(job.type)) return true;
  return job.params.includeVersions === true;
}

/**
 * `completed` only when nothing failed. A run where everything failed is
 * `failed`; one where some did is `completed_with_errors`, which is a different
 * thing an operator reads differently.
 */
export function outcomeFor(progress: JobProgress): JobStatus {
  if (progress.failed === 0) return 'completed';
  if (progress.processed === 0) return 'failed';
  return 'completed_with_errors';
}

/**
 * Runs `worker` over `items` with a live limit.
 *
 * The limit is read on every scheduling decision, so raising it takes effect as
 * soon as the next worker finishes. Lowering it does not interrupt work already in
 * flight: abandoning a copy halfway to honour a slider is worse than finishing it.
 *
 * `shouldStop` is checked before each item, so a pause or cancel takes effect
 * within one object rather than one page.
 *
 * It resolves with **how many items it started**, which — because it starts them
 * in order and does not resolve until every started one has settled — is also how
 * far into `items` the work is complete. That number is the within-page cursor a
 * paused job writes to its checkpoint.
 */
export function runWithPool<T>(
  items: readonly T[],
  limitOf: () => number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let cursor = 0;
    let active = 0;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(cursor);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const pump = (): void => {
      if (settled) return;
      const stop = shouldStop();
      while (!stop && active < Math.max(1, limitOf()) && cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        if (item === undefined) continue;
        active += 1;
        worker(item).then(
          () => {
            active -= 1;
            pump();
          },
          (error: unknown) => {
            active -= 1;
            fail(error);
          },
        );
      }
      if (active === 0 && (stop || cursor >= items.length)) finish();
    };

    pump();
  });
}
