import { z } from 'zod';
import { conflictStrategySchema, isoDateTime, listOf } from './common.js';
import { objectLockModeSchema } from './buckets.js';

export const JOB_TYPES = [
  'copy',
  'move',
  'delete',
  'tag',
  'storage-class',
  'retention',
  'restore-versions',
  'empty-bucket',
] as const;
export const jobTypeSchema = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof jobTypeSchema>;

export const JOB_STATUSES = [
  'queued',
  'scheduled',
  'running',
  'paused',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Statuses that are not going to change again without an operator action. */
export const JOB_TERMINAL_STATUSES = [
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
] as const satisfies readonly JobStatus[];

export const JOB_CONCURRENCY_MIN = 1;
export const JOB_CONCURRENCY_MAX = 64;

export const jobFiltersSchema = z.object({
  prefix: z.string().max(1024),
  modifiedAfter: isoDateTime.nullable(),
  modifiedBefore: isoDateTime.nullable(),
  minSize: z.number().int().min(0).nullable(),
  maxSize: z.number().int().min(0).nullable(),
  glob: z.string().max(512).nullable(),
  tags: z.record(z.string(), z.string()),
});
export type JobFilters = z.infer<typeof jobFiltersSchema>;

export const JOB_FILTER_DEFAULTS: JobFilters = {
  prefix: '',
  modifiedAfter: null,
  modifiedBefore: null,
  minSize: null,
  maxSize: null,
  glob: null,
  tags: {},
};

export const jobSourceSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  bucket: z.string(),
  filters: jobFiltersSchema,
  /**
   * How many explicitly chosen object keys the job works on, for a job started
   * from a selection in the object browser rather than from a filter; `null` when
   * the job is defined by its filters.
   *
   * The keys themselves are deliberately **not** in the contract: a selection can
   * be thousands of keys, and putting them here would put that array in every page
   * of `GET /jobs`. The count is what a client renders ("137 selected objects"),
   * and the keys stay server-side.
   */
  keyCount: z.number().int().min(0).nullable(),
});
export type JobSource = z.infer<typeof jobSourceSchema>;

export const jobTargetSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  bucket: z.string(),
  prefix: z.string(),
});
export type JobTarget = z.infer<typeof jobTargetSchema>;

export const jobParamsSchema = z.object({
  tags: z.record(z.string(), z.string()).optional(),
  storageClass: z.string().optional(),
  retention: z.object({ mode: objectLockModeSchema, days: z.number().int().min(1) }).optional(),
  includeVersions: z.boolean().optional(),
});
export type JobParams = z.infer<typeof jobParamsSchema>;

export const jobOptionsSchema = z.object({
  conflict: conflictStrategySchema,
  concurrency: z.number().int().min(JOB_CONCURRENCY_MIN).max(JOB_CONCURRENCY_MAX),
  dryRun: z.boolean(),
});
export type JobOptions = z.infer<typeof jobOptionsSchema>;

export const jobScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('now') }),
  z.object({ kind: z.literal('at'), at: isoDateTime }),
  z.object({
    kind: z.literal('cron'),
    cron: z.string().min(1).max(120),
    timezone: z.string().min(1).max(64),
    enabled: z.boolean(),
    nextRunAt: isoDateTime.nullable(),
  }),
]);
export type JobSchedule = z.infer<typeof jobScheduleSchema>;

/** What a client may send: `nextRunAt` is computed by the engine. */
export const jobScheduleInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('now') }),
  z.object({ kind: z.literal('at'), at: isoDateTime }),
  z.object({
    kind: z.literal('cron'),
    cron: z.string().min(1).max(120),
    timezone: z.string().min(1).max(64),
    enabled: z.boolean().default(true),
  }),
]);
export type JobScheduleInput = z.infer<typeof jobScheduleInputSchema>;

export const jobProgressSchema = z.object({
  total: z.number().int().min(0).nullable(),
  processed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  bytes: z.number().min(0),
  objectsPerSec: z.number().min(0),
  bytesPerSec: z.number().min(0),
  etaSeconds: z.number().int().min(0).nullable(),
});
export type JobProgress = z.infer<typeof jobProgressSchema>;

export const JOB_PROGRESS_ZERO: JobProgress = {
  total: null,
  processed: 0,
  failed: 0,
  skipped: 0,
  bytes: 0,
  objectsPerSec: 0,
  bytesPerSec: 0,
  etaSeconds: null,
};

export const jobSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: jobTypeSchema,
  status: jobStatusSchema,
  source: jobSourceSchema,
  target: jobTargetSchema.nullable(),
  params: jobParamsSchema,
  options: jobOptionsSchema,
  schedule: jobScheduleSchema,
  progress: jobProgressSchema,
  createdAt: isoDateTime,
  startedAt: isoDateTime.nullable(),
  finishedAt: isoDateTime.nullable(),
  /** e.g. `"ceph-lab offline"` — why a queued job has not started. */
  waitingFor: z.string().nullable(),
  /** Set on each run of a recurring job; `null` on the schedule itself. */
  parentId: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export const JOB_VIEWS = ['active', 'scheduled', 'history'] as const;
export const jobViewSchema = z.enum(JOB_VIEWS);
export type JobView = z.infer<typeof jobViewSchema>;

export const listJobsQuerySchema = z.object({ view: jobViewSchema.default('active') });
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const jobListSchema = listOf(jobSchema).extend({
  counts: z.object({
    active: z.number().int().min(0),
    scheduled: z.number().int().min(0),
    history: z.number().int().min(0),
  }),
});
export type JobList = z.infer<typeof jobListSchema>;

export const createJobRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: jobTypeSchema,
  source: z.object({
    serverId: z.string().min(1),
    bucket: z.string().min(1),
    filters: jobFiltersSchema,
  }),
  target: z
    .object({
      serverId: z.string().min(1),
      bucket: z.string().min(1),
      prefix: z.string().max(1024).default(''),
    })
    .optional(),
  params: jobParamsSchema,
  options: jobOptionsSchema,
  schedule: jobScheduleInputSchema,
});
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;

/**
 * `concurrency` is applied live to a running job; `schedule` may only be edited
 * while the job is scheduled.
 */
export const updateJobRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().min(1).max(200).optional(),
    concurrency: z.number().int().min(JOB_CONCURRENCY_MIN).max(JOB_CONCURRENCY_MAX).optional(),
    schedule: jobScheduleInputSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });
export type UpdateJobRequest = z.infer<typeof updateJobRequestSchema>;

export const duplicateJobRequestSchema = z.object({
  /** Turn the copy into a recurring schedule instead of a one-off run. */
  asSchedule: z
    .object({ cron: z.string().min(1).max(120), timezone: z.string().min(1).max(64) })
    .optional(),
});
export type DuplicateJobRequest = z.infer<typeof duplicateJobRequestSchema>;

export const jobRunListSchema = listOf(jobSchema);
export type JobRunList = z.infer<typeof jobRunListSchema>;

export const estimateJobRequestSchema = z.object({
  source: z.object({
    serverId: z.string().min(1),
    bucket: z.string().min(1),
    filters: jobFiltersSchema,
  }),
});
export type EstimateJobRequest = z.infer<typeof estimateJobRequestSchema>;

export const estimateJobResponseSchema = z.object({
  objects: z.number().int().min(0),
  bytes: z.number().min(0),
  /** True when the time-boxed listing gave up before the end. */
  partial: z.boolean(),
});
export type EstimateJobResponse = z.infer<typeof estimateJobResponseSchema>;

/* ------------------------------- logs ----------------------------- */

export const JOB_LOG_LEVELS = ['info', 'warn', 'error'] as const;
export const jobLogLevelSchema = z.enum(JOB_LOG_LEVELS);
export type JobLogLevel = z.infer<typeof jobLogLevelSchema>;

export const jobLogEntrySchema = z.object({
  at: isoDateTime,
  level: jobLogLevelSchema,
  message: z.string(),
  key: z.string().nullable(),
});
export type JobLogEntry = z.infer<typeof jobLogEntrySchema>;

export const jobLogsQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  level: z.enum(['all', 'error']).default('all'),
});
export type JobLogsQuery = z.infer<typeof jobLogsQuerySchema>;

export const jobLogsResponseSchema = z.object({
  items: z.array(jobLogEntrySchema),
  nextCursor: z.string().nullable(),
});
export type JobLogsResponse = z.infer<typeof jobLogsResponseSchema>;
