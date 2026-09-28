import type { Job, JobOptions, JobParams, JobType } from '@storage-io/contracts';

/**
 * The seam between the endpoints that *start* long work and the engine that
 * *runs* it.
 *
 * Buckets and objects hand work over here — emptying a bucket, deleting a
 * prefix, copying a large set — and never wait for it. The engine (backend wave
 * 2c) owns the `/jobs` endpoints, the scheduler, progress reporting and the
 * `job.progress`/`job.status` events; it replaces the provider bound to
 * `JOBS_PORT` without any caller changing.
 *
 * Only `enqueue` is declared, because that is the whole of what a mutation
 * endpoint needs: a row in the jobs table, in `queued`, and the `Job` to hand
 * back in the response.
 */
export const JOBS_PORT = Symbol('JOBS_PORT');

export interface EnqueueJobInput {
  readonly type: JobType;
  /** Shown in the jobs list; a default is derived from the type when omitted. */
  readonly name?: string;
  readonly source: {
    readonly serverId: string;
    readonly bucket: string;
    /** Narrows what the job touches. `JOB_FILTER_DEFAULTS` means "everything". */
    readonly prefix?: string;
  };
  readonly target?: {
    readonly serverId: string;
    readonly bucket: string;
    readonly prefix: string;
  };
  readonly params?: JobParams;
  /** Defaults to `{ conflict: 'overwrite', concurrency: 4, dryRun: false }`. */
  readonly options?: Partial<JobOptions>;
  /** Explicit object keys, for a job started from a selection in the browser. */
  readonly keys?: readonly string[];
}

export interface JobsPort {
  /**
   * Records the work and returns immediately. Never runs it inline: a caller
   * that needs the result synchronously must not be using a job.
   */
  enqueue(input: EnqueueJobInput): Job;
}
