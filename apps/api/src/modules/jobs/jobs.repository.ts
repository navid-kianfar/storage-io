import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import {
  JOB_FILTER_DEFAULTS,
  JOB_PROGRESS_ZERO,
  JOB_TERMINAL_STATUSES,
  type Job,
  type JobFilters,
  type JobLogEntry,
  type JobLogLevel,
  type JobOptions,
  type JobParams,
  type JobProgress,
  type JobSchedule,
  type JobStatus,
  type JobType,
  type JobView,
  type PaginationQuery,
} from '@storage-io/contracts';
import { DB } from '../../db/db.module';
import type { AppDatabase } from '../../db/migrate';
import { jobLogs, jobs, type JobRow } from '../../db/schema';
import { likeEscaped } from '../../common/sql/like';

/**
 * Every query over the jobs tables, and the row↔contract mapping.
 *
 * The statuses a view covers are fixed here rather than at each call site,
 * because "active" appearing in the list, the counts and the dashboard with three
 * different definitions is the bug this prevents.
 *
 * The stored row is wider than the contract's `Job` in two places, both
 * deliberate: `nextRunAt` is a column so the scheduler can ask the database which
 * schedules are due instead of loading them all, and `checkpoint` is a column so
 * resume is one read. Neither is in the contract — a client has `schedule.nextRunAt`
 * and does not need to know how a job remembers where it was.
 */

/** Which statuses each `?view=` covers. */
export const JOB_VIEW_STATUSES: Readonly<Record<JobView, readonly JobStatus[]>> = {
  active: ['queued', 'running', 'paused'],
  scheduled: ['scheduled'],
  history: JOB_TERMINAL_STATUSES,
};

/**
 * Fields stored inside the `params` JSON but outside the contract's `JobParams`.
 * Wave 2a set the convention with `_keys`; the two server names follow it so a
 * job that outlives its server connection still reads as the job it was, without
 * a column per name and without a join on every list page.
 */
export const STORED_KEYS_FIELD = '_keys';
/**
 * The prefixes an operator selected, alongside `_keys` and for the same reason:
 * a selection is not a filter, and `filters.prefix` can hold exactly one.
 */
export const STORED_PREFIXES_FIELD = '_prefixes';
export const STORED_SOURCE_NAME_FIELD = '_sourceServerName';
export const STORED_TARGET_NAME_FIELD = '_targetServerName';

export interface JobCounts {
  readonly active: number;
  readonly scheduled: number;
  readonly history: number;
}

export interface NewJobRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type: JobType;
  readonly status: JobStatus;
  readonly sourceServerId: string;
  readonly sourceBucket: string;
  readonly filters: JobFilters;
  readonly targetServerId: string | null;
  readonly targetBucket: string | null;
  readonly targetPrefix: string | null;
  readonly params: Record<string, unknown>;
  readonly options: JobOptions;
  readonly schedule: JobSchedule;
  readonly progress: JobProgress;
  readonly nextRunAt: string | null;
  readonly waitingFor: string | null;
  readonly createdAt: string;
}

@Injectable()
export class JobsRepository {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  /* ------------------------------ writing -------------------------- */

  insert(row: NewJobRow): JobRow {
    const [inserted] = this.db
      .insert(jobs)
      .values({
        id: row.id,
        parentId: row.parentId,
        name: row.name,
        type: row.type,
        status: row.status,
        sourceServerId: row.sourceServerId,
        sourceBucket: row.sourceBucket,
        filters: { ...row.filters },
        targetServerId: row.targetServerId,
        targetBucket: row.targetBucket,
        targetPrefix: row.targetPrefix,
        params: { ...row.params },
        options: { ...row.options },
        schedule: { ...row.schedule },
        progress: { ...row.progress },
        nextRunAt: row.nextRunAt,
        waitingFor: row.waitingFor,
        createdAt: row.createdAt,
      })
      .returning()
      .all();
    if (inserted === undefined) throw new Error('The job insert returned no row.');
    return inserted;
  }

  update(id: string, patch: Partial<typeof jobs.$inferInsert>): JobRow | null {
    const [updated] = this.db.update(jobs).set(patch).where(eq(jobs.id, id)).returning().all();
    return updated ?? null;
  }

  /** Cascades to `job_logs` through the schema's reference. */
  delete(id: string): boolean {
    return this.db.delete(jobs).where(eq(jobs.id, id)).run().changes > 0;
  }

  /* ------------------------------ reading -------------------------- */

  findById(id: string): JobRow | null {
    const [row] = this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1).all();
    return row ?? null;
  }

  /**
   * One page of a view. A recurring schedule's child runs are excluded from
   * `active` and `history` only when the caller asks for the parent's own runs —
   * they are ordinary jobs everywhere else, because an operator watching a copy
   * run wants to see it whether a cron started it or they did.
   */
  list(view: JobView, page: PaginationQuery): { rows: readonly JobRow[]; total: number } {
    const where = inArray(jobs.status, [...JOB_VIEW_STATUSES[view]]);
    const [totals] = this.db.select({ total: count() }).from(jobs).where(where).all();
    const rows = this.db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(...this.orderFor(view))
      .limit(page.pageSize)
      .offset((page.page - 1) * page.pageSize)
      .all();
    return { rows, total: totals?.total ?? 0 };
  }

  counts(): JobCounts {
    const rows = this.db
      .select({ status: jobs.status, total: count() })
      .from(jobs)
      .groupBy(jobs.status)
      .all();

    const byStatus = new Map(rows.map((row) => [row.status, row.total]));
    const sum = (statuses: readonly JobStatus[]): number =>
      statuses.reduce((total, status) => total + (byStatus.get(status) ?? 0), 0);

    return {
      active: sum(JOB_VIEW_STATUSES.active),
      scheduled: sum(JOB_VIEW_STATUSES.scheduled),
      history: sum(JOB_VIEW_STATUSES.history),
    };
  }

  /** The runs of a recurring job, newest first. */
  children(parentId: string, page: PaginationQuery): { rows: readonly JobRow[]; total: number } {
    const where = eq(jobs.parentId, parentId);
    const [totals] = this.db.select({ total: count() }).from(jobs).where(where).all();
    const rows = this.db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(page.pageSize)
      .offset((page.page - 1) * page.pageSize)
      .all();
    return { rows, total: totals?.total ?? 0 };
  }

  /**
   * Queued jobs in the order they were created, so the engine is first-in
   * first-out and an operator's job does not sit behind one enqueued later.
   */
  queued(limit: number): readonly JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.status, 'queued'))
      .orderBy(asc(jobs.createdAt), asc(jobs.id))
      .limit(limit)
      .all();
  }

  /** Schedules whose next run has arrived. */
  dueSchedules(nowIso: string): readonly JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'scheduled'), lte(jobs.nextRunAt, nowIso)))
      .orderBy(asc(jobs.nextRunAt))
      .all();
  }

  /**
   * Jobs the database still calls `running`. Nothing is running at boot, so every
   * one of these is a job the process died in the middle of; they go back to
   * `queued` with their checkpoint intact and the engine picks up where it stopped.
   */
  interruptedRuns(): readonly JobRow[] {
    return this.db.select().from(jobs).where(eq(jobs.status, 'running')).all();
  }

  /** The dashboard's "active jobs" card. */
  active(limit: number): readonly JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(inArray(jobs.status, [...JOB_VIEW_STATUSES.active]))
      .orderBy(desc(jobs.startedAt), desc(jobs.createdAt))
      .limit(limit)
      .all();
  }

  /** `GET /search`: name, bucket or type. */
  search(query: string, limit: number): readonly JobRow[] {
    const where = or(
      likeEscaped(jobs.name, query),
      likeEscaped(jobs.sourceBucket, query),
      likeEscaped(jobs.type, query),
    );
    return this.db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
      .all();
  }

  /* -------------------------------- logs --------------------------- */

  appendLogs(
    jobId: string,
    entries: readonly { level: JobLogLevel; message: string; key: string | null; at: string }[],
  ): void {
    if (entries.length === 0) return;
    this.db
      .insert(jobLogs)
      .values(entries.map((entry) => ({ jobId, ...entry })))
      .run();
  }

  /**
   * A page of log lines. The cursor is the autoincrement id of the last line
   * returned, not an offset: new lines arrive while an operator reads, and an
   * offset would show them a line twice.
   */
  logs(
    jobId: string,
    cursor: string | undefined,
    level: 'all' | 'error',
    pageSize: number,
  ): { entries: readonly JobLogEntry[]; nextCursor: string | null } {
    const conditions: SQL[] = [eq(jobLogs.jobId, jobId)];
    const after = cursor === undefined ? null : Number(cursor);
    if (after !== null && Number.isFinite(after)) conditions.push(gt(jobLogs.id, after));
    if (level === 'error') conditions.push(eq(jobLogs.level, 'error'));

    const rows = this.db
      .select()
      .from(jobLogs)
      .where(and(...conditions))
      .orderBy(asc(jobLogs.id))
      .limit(pageSize)
      .all();

    const last = rows[rows.length - 1];
    return {
      entries: rows.map((row) => ({
        at: row.at,
        level: row.level as JobLogLevel,
        message: row.message,
        key: row.key,
      })),
      nextCursor: rows.length < pageSize || last === undefined ? null : String(last.id),
    };
  }

  clearLogs(jobId: string): void {
    this.db.delete(jobLogs).where(eq(jobLogs.jobId, jobId)).run();
  }

  /* ----------------------------- retention ------------------------- */

  /**
   * Prunes finished one-off jobs and finished runs past the retention window, in
   * one set-based delete each. A schedule (`parentId is null` and still
   * `scheduled`) is never pruned: it is configuration, not history.
   *
   * `job_logs` goes with the row through the schema's cascade, so there is no
   * second delete to forget.
   */
  pruneFinishedOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const condition = and(
      inArray(jobs.status, [...JOB_TERMINAL_STATUSES]),
      lt(jobs.createdAt, cutoff),
    );
    return this.db.delete(jobs).where(condition).run().changes;
  }

  /** Orphaned log lines, for the case a row was removed outside the cascade. */
  countOrphanLogs(): number {
    const [row] = this.db
      .select({ total: count() })
      .from(jobLogs)
      .leftJoin(jobs, eq(jobs.id, jobLogs.jobId))
      .where(isNull(jobs.id))
      .all();
    return row?.total ?? 0;
  }

  /* ------------------------------ mapping -------------------------- */

  toContract(row: JobRow): Job {
    return {
      id: row.id,
      name: row.name,
      type: row.type as JobType,
      status: row.status as JobStatus,
      source: {
        serverId: row.sourceServerId,
        // Stamped at creation — see STORED_SOURCE_NAME_FIELD.
        serverName: stringField(row.params, STORED_SOURCE_NAME_FIELD) ?? row.sourceServerId,
        bucket: row.sourceBucket,
        filters: filtersOf(row.filters),
        prefixes: [...this.storedPrefixes(row)],
        keyCount: this.storedKeys(row)?.length ?? null,
      },
      target:
        row.targetServerId === null || row.targetBucket === null
          ? null
          : {
              serverId: row.targetServerId,
              serverName: stringField(row.params, STORED_TARGET_NAME_FIELD) ?? row.targetServerId,
              bucket: row.targetBucket,
              prefix: row.targetPrefix ?? '',
            },
      params: paramsOf(row.params),
      options: optionsOf(row.options),
      schedule: scheduleOf(row.schedule, row.nextRunAt),
      progress: progressOf(row.progress),
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      waitingFor: row.waitingFor,
      parentId: row.parentId,
    };
  }

  /** Explicit keys a mutation endpoint handed over, if any. */
  storedKeys(row: JobRow): readonly string[] | null {
    const raw = row.params[STORED_KEYS_FIELD];
    if (!Array.isArray(raw)) return null;
    const keys = raw.filter((entry): entry is string => typeof entry === 'string');
    return keys.length === 0 ? null : keys;
  }

  /** Explicit prefixes a mutation endpoint handed over; `[]` for a filter job. */
  storedPrefixes(row: JobRow): readonly string[] {
    const raw = row.params[STORED_PREFIXES_FIELD];
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is string => typeof entry === 'string');
  }

  private orderFor(view: JobView): readonly SQL[] {
    if (view === 'scheduled') return [asc(jobs.nextRunAt), asc(jobs.name)];
    if (view === 'history') return [desc(jobs.finishedAt), desc(jobs.createdAt)];
    return [desc(jobs.createdAt), desc(jobs.id)];
  }
}

/* ------------------------------ mapping --------------------------- */

const stringField = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * A stored JSON blob written by an older version may be missing a field, so every
 * one falls back to the contract's default rather than reaching a client as
 * `undefined` where the schema promises a value.
 */
export function filtersOf(stored: Record<string, unknown>): JobFilters {
  return {
    prefix: typeof stored['prefix'] === 'string' ? stored['prefix'] : JOB_FILTER_DEFAULTS.prefix,
    modifiedAfter: typeof stored['modifiedAfter'] === 'string' ? stored['modifiedAfter'] : null,
    modifiedBefore: typeof stored['modifiedBefore'] === 'string' ? stored['modifiedBefore'] : null,
    minSize: typeof stored['minSize'] === 'number' ? stored['minSize'] : null,
    maxSize: typeof stored['maxSize'] === 'number' ? stored['maxSize'] : null,
    glob: typeof stored['glob'] === 'string' ? stored['glob'] : null,
    tags: recordOfStrings(stored['tags']),
  };
}

export function paramsOf(stored: Record<string, unknown>): JobParams {
  const params: JobParams = {};
  const tags = stored['tags'];
  if (tags !== undefined) Object.assign(params, { tags: recordOfStrings(tags) });
  if (typeof stored['storageClass'] === 'string') {
    Object.assign(params, { storageClass: stored['storageClass'] });
  }
  const retention = stored['retention'];
  if (typeof retention === 'object' && retention !== null) {
    const shape = retention as { mode?: unknown; days?: unknown };
    if (
      (shape.mode === 'GOVERNANCE' || shape.mode === 'COMPLIANCE') &&
      typeof shape.days === 'number'
    ) {
      Object.assign(params, { retention: { mode: shape.mode, days: shape.days } });
    }
  }
  if (typeof stored['includeVersions'] === 'boolean') {
    Object.assign(params, { includeVersions: stored['includeVersions'] });
  }
  return params;
}

export function optionsOf(stored: Record<string, unknown>): JobOptions {
  const conflict = stored['conflict'];
  return {
    conflict:
      conflict === 'skip' || conflict === 'overwrite' || conflict === 'rename'
        ? conflict
        : 'overwrite',
    concurrency: typeof stored['concurrency'] === 'number' ? stored['concurrency'] : 4,
    dryRun: stored['dryRun'] === true,
  };
}

/**
 * `nextRunAt` comes from its own column, not from the stored blob: the scheduler
 * updates the column, and keeping a second copy inside the JSON is how the two
 * disagree.
 */
export function scheduleOf(stored: Record<string, unknown>, nextRunAt: string | null): JobSchedule {
  const kind = stored['kind'];
  if (kind === 'at' && typeof stored['at'] === 'string') return { kind: 'at', at: stored['at'] };
  if (kind === 'cron' && typeof stored['cron'] === 'string') {
    return {
      kind: 'cron',
      cron: stored['cron'],
      timezone: typeof stored['timezone'] === 'string' ? stored['timezone'] : 'UTC',
      enabled: stored['enabled'] !== false,
      nextRunAt,
    };
  }
  return { kind: 'now' };
}

export function progressOf(stored: Record<string, unknown>): JobProgress {
  const number = (key: string, fallback: number): number => {
    const value = stored[key];
    return typeof value === 'number' ? value : fallback;
  };

  return {
    total: typeof stored['total'] === 'number' ? stored['total'] : null,
    processed: number('processed', JOB_PROGRESS_ZERO.processed),
    failed: number('failed', JOB_PROGRESS_ZERO.failed),
    skipped: number('skipped', JOB_PROGRESS_ZERO.skipped),
    bytes: number('bytes', JOB_PROGRESS_ZERO.bytes),
    objectsPerSec: number('objectsPerSec', 0),
    bytesPerSec: number('bytesPerSec', 0),
    etaSeconds: typeof stored['etaSeconds'] === 'number' ? stored['etaSeconds'] : null,
  };
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}
