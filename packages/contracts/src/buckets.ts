import { z } from 'zod';
import { isoDateTime, listOf, providerSchema, quotaModeSchema, quotaSchema } from './common.js';
import { isValidBucketName } from './helpers/bucket-name.js';

export const BUCKET_VERSIONING_STATES = ['enabled', 'suspended', 'off'] as const;
export const bucketVersioningSchema = z.enum(BUCKET_VERSIONING_STATES);
export type BucketVersioning = z.infer<typeof bucketVersioningSchema>;

export const BUCKET_ACCESS_LEVELS = ['private', 'public-read', 'custom'] as const;
export const bucketAccessSchema = z.enum(BUCKET_ACCESS_LEVELS);
export type BucketAccess = z.infer<typeof bucketAccessSchema>;

/** What a client may set — `custom` is derived from the policy, never requested. */
export const bucketAccessSettableSchema = z.enum(['private', 'public-read']);
export type BucketAccessSettable = z.infer<typeof bucketAccessSettableSchema>;

/** S3 bucket naming rules; see `isValidBucketName` for the reasoned version. */
export const bucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .refine((name) => isValidBucketName(name).valid, {
    message: 'not a valid S3 bucket name',
  });

export const bucketSchema = z.object({
  /**
   * storage-io's own opaque id for this bucket, stable per `(serverId, name)`
   * and assigned the first time the bucket is seen. It is what a URL carries —
   * a bucket name is not unique across servers and is not a safe path segment.
   * A bucket deleted and created again may get a new id.
   */
  id: z.string(),
  serverId: z.string(),
  serverName: z.string(),
  provider: providerSchema,
  name: z.string(),
  region: z.string().nullable(),
  createdAt: isoDateTime.nullable(),
  objects: z.number().int().min(0).nullable(),
  sizeBytes: z.number().min(0).nullable(),
  statsAt: isoDateTime.nullable(),
  versioning: bucketVersioningSchema,
  objectLock: z.boolean(),
  access: bucketAccessSchema,
  quota: quotaSchema.nullable(),
  /** True when the server is offline and these numbers come from the cache. */
  unavailable: z.boolean(),
});
export type Bucket = z.infer<typeof bucketSchema>;

export const bucketDetailSchema = bucketSchema.extend({
  owner: z.string().nullable(),
  tags: z.record(z.string(), z.string()),
  defaultStorageClass: z.string().nullable(),
  noncurrentVersions: z.number().int().min(0).nullable(),
});
export type BucketDetail = z.infer<typeof bucketDetailSchema>;

export const BUCKET_SORTS = ['size', 'name', 'quota', 'written'] as const;
export const bucketSortSchema = z.enum(BUCKET_SORTS);
export type BucketSort = z.infer<typeof bucketSortSchema>;

export const listBucketsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  serverId: z.string().optional(),
  access: bucketAccessSchema.optional(),
  sort: bucketSortSchema.default('size'),
});
export type ListBucketsQuery = z.infer<typeof listBucketsQuerySchema>;

export const bucketSummarySchema = z.object({
  buckets: z.number().int().min(0),
  sizeBytes: z.number().min(0),
  objects: z.number().int().min(0),
  withQuota: z.number().int().min(0),
  nearQuota: z.number().int().min(0),
  public: z.number().int().min(0),
});
export type BucketSummary = z.infer<typeof bucketSummarySchema>;

export const bucketListSchema = listOf(bucketSchema).extend({ summary: bucketSummarySchema });
export type BucketList = z.infer<typeof bucketListSchema>;

/** Column order for `GET /buckets/export.csv`; the API writes cells in this order. */
export const BUCKET_CSV_COLUMNS = [
  'server',
  'provider',
  'bucket',
  'region',
  'createdAt',
  'objects',
  'sizeBytes',
  'statsAt',
  'versioning',
  'objectLock',
  'access',
  'quotaLimitBytes',
  'quotaMode',
  'quotaNative',
  'unavailable',
  // Appended rather than placed first: every existing column keeps its position,
  // so a spreadsheet or script built against the previous export still reads.
  'id',
] as const;

export const createBucketRequestSchema = z.object({
  name: bucketNameSchema,
  region: z.string().min(1).max(64).optional(),
  versioning: z.boolean(),
  objectLock: z.boolean(),
  quota: z.object({ limitBytes: z.number().int().min(1), mode: quotaModeSchema }).nullable(),
  access: bucketAccessSettableSchema,
});
export type CreateBucketRequest = z.infer<typeof createBucketRequestSchema>;

export const deleteBucketQuerySchema = z.object({ force: z.stringbool().default(false) });
export type DeleteBucketQuery = z.infer<typeof deleteBucketQuerySchema>;

export const emptyBucketRequestSchema = z.object({ includeVersions: z.boolean() });
export type EmptyBucketRequest = z.infer<typeof emptyBucketRequestSchema>;

/* --------------------------- sub-resources ------------------------ */

export const bucketAccessBodySchema = z.object({ access: bucketAccessSettableSchema });
export type BucketAccessBody = z.infer<typeof bucketAccessBodySchema>;

export const bucketAccessResponseSchema = z.object({
  access: bucketAccessSchema,
  policy: z.record(z.string(), z.unknown()).nullable(),
});
export type BucketAccessResponse = z.infer<typeof bucketAccessResponseSchema>;

export const bucketPolicyBodySchema = z.object({
  policy: z.record(z.string(), z.unknown()).nullable(),
});
export type BucketPolicyBody = z.infer<typeof bucketPolicyBodySchema>;

export const bucketVersioningBodySchema = z.object({
  status: z.enum(['enabled', 'suspended']),
});
export type BucketVersioningBody = z.infer<typeof bucketVersioningBodySchema>;

export const OBJECT_LOCK_MODES = ['GOVERNANCE', 'COMPLIANCE'] as const;
export const objectLockModeSchema = z.enum(OBJECT_LOCK_MODES);
export type ObjectLockMode = z.infer<typeof objectLockModeSchema>;

export const bucketObjectLockBodySchema = z.object({
  mode: objectLockModeSchema.nullable(),
  days: z.number().int().min(1).nullable(),
  years: z.number().int().min(1).nullable(),
});
export type BucketObjectLockBody = z.infer<typeof bucketObjectLockBodySchema>;

export const bucketObjectLockResponseSchema = bucketObjectLockBodySchema.extend({
  enabled: z.boolean(),
});
export type BucketObjectLockResponse = z.infer<typeof bucketObjectLockResponseSchema>;

export const lifecycleRuleSchema = z.object({
  id: z.string().min(1).max(255),
  enabled: z.boolean(),
  prefix: z.string(),
  tags: z.record(z.string(), z.string()),
  expireDays: z.number().int().min(1).nullable(),
  noncurrentExpireDays: z.number().int().min(1).nullable(),
  abortMultipartDays: z.number().int().min(1).nullable(),
  transition: z.object({ days: z.number().int().min(0), storageClass: z.string() }).nullable(),
  expiredDeleteMarkers: z.boolean(),
});
export type LifecycleRule = z.infer<typeof lifecycleRuleSchema>;

export const bucketLifecycleBodySchema = z.object({ rules: z.array(lifecycleRuleSchema) });
export type BucketLifecycleBody = z.infer<typeof bucketLifecycleBodySchema>;

export const corsRuleSchema = z.object({
  allowedOrigins: z.array(z.string()),
  allowedMethods: z.array(z.string()),
  allowedHeaders: z.array(z.string()),
  exposeHeaders: z.array(z.string()),
  maxAgeSeconds: z.number().int().min(0).nullable(),
});
export type CorsRule = z.infer<typeof corsRuleSchema>;

export const bucketCorsBodySchema = z.object({ rules: z.array(corsRuleSchema) });
export type BucketCorsBody = z.infer<typeof bucketCorsBodySchema>;

export const bucketTagsBodySchema = z.object({ tags: z.record(z.string(), z.string()) });
export type BucketTagsBody = z.infer<typeof bucketTagsBodySchema>;

export const replicationRuleSchema = z.object({
  id: z.string().min(1).max(255),
  enabled: z.boolean(),
  prefix: z.string(),
  destination: z.object({ bucketArn: z.string(), storageClass: z.string().nullable() }),
  deleteMarkers: z.boolean(),
  priority: z.number().int().min(0),
});
export type ReplicationRule = z.infer<typeof replicationRuleSchema>;

export const bucketReplicationBodySchema = z.object({ rules: z.array(replicationRuleSchema) });
export type BucketReplicationBody = z.infer<typeof bucketReplicationBodySchema>;

export const bucketReplicationResponseSchema = bucketReplicationBodySchema.extend({
  status: z.string().nullable(),
});
export type BucketReplicationResponse = z.infer<typeof bucketReplicationResponseSchema>;

export const NOTIFICATION_TARGET_KINDS = ['queue', 'topic', 'lambda'] as const;
export const notificationTargetKindSchema = z.enum(NOTIFICATION_TARGET_KINDS);
export type NotificationTargetKind = z.infer<typeof notificationTargetKindSchema>;

export const notificationTargetSchema = z.object({
  id: z.string(),
  arn: z.string(),
  kind: notificationTargetKindSchema,
  events: z.array(z.string()),
  prefix: z.string(),
  suffix: z.string(),
});
export type NotificationTarget = z.infer<typeof notificationTargetSchema>;

export const bucketNotificationsBodySchema = z.object({
  targets: z.array(notificationTargetSchema),
});
export type BucketNotificationsBody = z.infer<typeof bucketNotificationsBodySchema>;

export const bucketQuotaBodySchema = z.object({
  limitBytes: z.number().int().min(1).nullable(),
  mode: quotaModeSchema,
  threshold: z.number().min(0).max(1),
});
export type BucketQuotaBody = z.infer<typeof bucketQuotaBodySchema>;

export const bucketQuotaResponseSchema = z.object({
  quota: quotaSchema.nullable(),
  usage: z.object({ sizeBytes: z.number().min(0), objects: z.number().int().min(0) }),
});
export type BucketQuotaResponse = z.infer<typeof bucketQuotaResponseSchema>;

/* ---------------------------- bulk actions ------------------------ */

export const BUCKET_BULK_ACTIONS = ['quota', 'lifecycle-rule', 'tags', 'access', 'delete'] as const;
export const bucketBulkActionSchema = z.enum(BUCKET_BULK_ACTIONS);
export type BucketBulkAction = z.infer<typeof bucketBulkActionSchema>;

export const bucketRefSchema = z.object({
  serverId: z.string().min(1),
  bucket: z.string().min(1),
});
export type BucketRef = z.infer<typeof bucketRefSchema>;

export const BUCKET_BULK_MAX = 500;

const bulkTargets = { buckets: z.array(bucketRefSchema).min(1).max(BUCKET_BULK_MAX) };

/**
 * `force` empties each bucket before removing it, the way `DELETE …?force=true`
 * does for one bucket. Without it a bucket that still holds objects comes back as
 * a per-bucket `BUCKET_NOT_EMPTY` result and the others are still deleted.
 */
export const bucketBulkDeleteBodySchema = z.object({ force: z.boolean() });
export type BucketBulkDeleteBody = z.infer<typeof bucketBulkDeleteBodySchema>;

/**
 * One request applies one action to many buckets. `payload` is discriminated by
 * `action`, so a client cannot send a lifecycle rule down the quota path.
 */
export const bucketBulkRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...bulkTargets, action: z.literal('quota'), payload: bucketQuotaBodySchema }),
  z.object({ ...bulkTargets, action: z.literal('lifecycle-rule'), payload: lifecycleRuleSchema }),
  z.object({ ...bulkTargets, action: z.literal('tags'), payload: bucketTagsBodySchema }),
  z.object({ ...bulkTargets, action: z.literal('access'), payload: bucketAccessBodySchema }),
  z.object({ ...bulkTargets, action: z.literal('delete'), payload: bucketBulkDeleteBodySchema }),
]);
export type BucketBulkRequest = z.infer<typeof bucketBulkRequestSchema>;

export const bucketBulkResultSchema = bucketRefSchema.extend({
  /**
   * The bucket's opaque id, resolved before the action ran — so a row for a
   * bucket that was just deleted still carries the id the caller navigated by.
   * `null` when the installation has never cached this bucket.
   */
  id: z.string().nullable(),
  ok: z.boolean(),
  message: z.string().nullable(),
});
export type BucketBulkResult = z.infer<typeof bucketBulkResultSchema>;

export const bucketBulkResponseSchema = z.object({ results: z.array(bucketBulkResultSchema) });
export type BucketBulkResponse = z.infer<typeof bucketBulkResponseSchema>;

/* --------------------- event notification status ------------------ */

export const NOTIFICATION_TARGET_STATES = ['online', 'offline', 'unknown'] as const;
export const notificationTargetStateSchema = z.enum(NOTIFICATION_TARGET_STATES);
export type NotificationTargetState = z.infer<typeof notificationTargetStateSchema>;

export const notificationTargetStatusSchema = z.object({
  targetId: z.string(),
  arn: z.string(),
  state: notificationTargetStateSchema,
  detail: z.string().nullable(),
});
export type NotificationTargetStatus = z.infer<typeof notificationTargetStatusSchema>;

export const notificationTargetStatusListSchema = z.object({
  items: z.array(notificationTargetStatusSchema),
});
export type NotificationTargetStatusList = z.infer<typeof notificationTargetStatusListSchema>;
