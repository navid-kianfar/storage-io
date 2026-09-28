import { z } from 'zod';
import { isoDateTime, providerSchema, serverStatusSchema } from './common.js';
import { bucketSchema } from './buckets.js';
import { activityEventSchema } from './activity.js';
import { accessKeySchema } from './iam.js';
import { jobSchema } from './jobs.js';

export const DASHBOARD_GROWTH_DAYS = 30;
export const DASHBOARD_ACTIVITY_COUNT = 6;
export const DASHBOARD_JOB_COUNT = 3;
export const DASHBOARD_LARGEST_BUCKET_COUNT = 5;
export const DASHBOARD_EXPIRING_KEY_DAYS = 30;

export const dashboardTotalsSchema = z.object({
  /**
   * The sum of every **bucket's** size, from the inventory cache.
   *
   * Deliberately not called `usedBytes`, because `byServer[].usedBytes` is a
   * different measurement and the two do not have to agree: that one is what the
   * storage server reports as its own used capacity, which includes replication,
   * erasure-coding overhead, versions and anything on the server that storage-io
   * did not put there. This one is what the operator's data adds up to.
   */
  bucketsBytes: z.number().min(0),
  capacityBytes: z.number().min(0).nullable(),
  objects: z.number().int().min(0),
  buckets: z.number().int().min(0),
  /** The change in `bucketsBytes` over the last seven daily samples. */
  bucketsDelta7dBytes: z.number(),
  objectsDeltaToday: z.number().int().nullable(),
  /** S3 users across every server whose driver reports them, from the cache. */
  users: z.number().int().min(0),
  accessKeys: z.number().int().min(0),
  servers: z.object({
    total: z.number().int().min(0),
    healthy: z.number().int().min(0),
    degraded: z.number().int().min(0),
    offline: z.number().int().min(0),
  }),
  nearQuotaBuckets: z.number().int().min(0),
});
export type DashboardTotals = z.infer<typeof dashboardTotalsSchema>;

export const dashboardSchema = z.object({
  totals: dashboardTotalsSchema,
  /** Daily totals of `bucketsBytes`, from the same samples. */
  growth: z.array(z.object({ t: isoDateTime, bucketsBytes: z.number().min(0) })),
  byServer: z.array(
    z.object({
      serverId: z.string(),
      name: z.string(),
      provider: providerSchema,
      /** What the server reports as used capacity — see `totals.bucketsBytes`. */
      usedBytes: z.number().min(0),
      totalBytes: z.number().min(0).nullable(),
    }),
  ),
  jobs: z.array(jobSchema),
  activity: z.array(activityEventSchema),
  expiringKeys: z.array(accessKeySchema),
  largestBuckets: z.array(bucketSchema),
  incidents: z.array(
    z.object({
      serverId: z.string(),
      serverName: z.string(),
      status: serverStatusSchema,
      detail: z.string().nullable(),
      since: isoDateTime,
    }),
  ),
});
export type Dashboard = z.infer<typeof dashboardSchema>;
