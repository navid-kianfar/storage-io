import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/** ISO-8601 timestamp, as every `at`/`createdAt` field in docs/API.md. */
export const isoDateTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'must be an ISO-8601 date-time string',
});

export const uuid = z.uuid();

/** An arbitrary JSON object (IAM policy documents, activity details, …). */
export const jsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof jsonObject>;

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 500;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** `{ items, total }` — the shape every list endpoint returns. */
export const listOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().min(0) });

/** `{ items }` without a total (sessions, tokens, versions, nodes, …). */
export const itemsOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

/* ------------------------------------------------------------------ *
 * Errors (RFC 7807)
 * ------------------------------------------------------------------ */

export const ERROR_CODES = [
  'AUTH_INVALID',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION',
  'CONFLICT',
  'PROVIDER_ERROR',
  'NOT_SUPPORTED',
  'SERVER_OFFLINE',
  'BUCKET_NOT_EMPTY',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const problemFieldErrorSchema = z.object({ path: z.string(), message: z.string() });
export type ProblemFieldError = z.infer<typeof problemFieldErrorSchema>;

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  code: errorCodeSchema,
  errors: z.array(problemFieldErrorSchema).optional(),
  requestId: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';

/* ------------------------------------------------------------------ *
 * Providers and capabilities
 * ------------------------------------------------------------------ */

export const PROVIDERS = [
  'minio',
  'seaweedfs',
  'aws',
  'ceph',
  'garage',
  'r2',
  'wasabi',
  'generic',
] as const;
export const providerSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof providerSchema>;

export const PROVIDER_LABELS: Readonly<Record<Provider, string>> = {
  minio: 'MinIO',
  seaweedfs: 'SeaweedFS',
  aws: 'AWS S3',
  ceph: 'Ceph RGW',
  garage: 'Garage',
  r2: 'Cloudflare R2',
  wasabi: 'Wasabi',
  generic: 'Generic S3',
};

/** Which IAM driver a provider uses — see docs/ARCHITECTURE.md. */
export const IAM_DRIVERS = [
  'minio-admin',
  'aws-iam',
  'ceph-admin',
  'garage-admin',
  'none',
] as const;
export const iamDriverSchema = z.enum(IAM_DRIVERS);
export type IamDriver = z.infer<typeof iamDriverSchema>;

export const PROVIDER_IAM_DRIVERS: Readonly<Record<Provider, IamDriver>> = {
  minio: 'minio-admin',
  seaweedfs: 'aws-iam',
  aws: 'aws-iam',
  ceph: 'ceph-admin',
  garage: 'garage-admin',
  r2: 'none',
  wasabi: 'aws-iam',
  generic: 'none',
};

export const SERVER_STATUSES = [
  'healthy',
  'degraded',
  'offline',
  'maintenance',
  'unknown',
] as const;
export const serverStatusSchema = z.enum(SERVER_STATUSES);
export type ServerStatus = z.infer<typeof serverStatusSchema>;

export const CAPABILITIES = [
  'objects',
  'versioning',
  'objectLock',
  'lifecycle',
  'cors',
  'bucketPolicy',
  'tagging',
  'replication',
  'notifications',
  'encryption',
  'storageClasses',
  'iamUsers',
  'iamGroups',
  'iamPolicies',
  'accessKeys',
  'accessKeyExpiry',
  'bucketQuota',
  'usageStats',
  'nodes',
] as const;
export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

export const CAPABILITY_STATES = ['supported', 'not_configured', 'not_supported'] as const;
export const capabilityStateSchema = z.enum(CAPABILITY_STATES);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

/**
 * Every capability is always present in the map, so the UI never has to guess
 * between "missing key" and "not supported".
 */
export const capabilityMapSchema = z.object(
  Object.fromEntries(CAPABILITIES.map((name) => [name, capabilityStateSchema])) as Record<
    Capability,
    typeof capabilityStateSchema
  >,
);
export type CapabilityMap = z.infer<typeof capabilityMapSchema>;

export const emptyCapabilityMap = (state: CapabilityState = 'not_supported'): CapabilityMap =>
  Object.fromEntries(CAPABILITIES.map((name) => [name, state])) as CapabilityMap;

/* ------------------------------------------------------------------ *
 * Check results (connection test / health check)
 * ------------------------------------------------------------------ */

export const CHECK_STATUSES = ['ok', 'warn', 'fail', 'skipped'] as const;
export const checkStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

/** The fixed list of connection checks, in the order they run. */
export const CHECK_IDS = [
  'dns',
  'tcp',
  'tls',
  'auth',
  'listBuckets',
  'admin',
  'versioning',
  'objectLock',
  'replication',
] as const;
export const checkIdSchema = z.enum(CHECK_IDS);
export type CheckId = z.infer<typeof checkIdSchema>;

export const checkResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: checkStatusSchema,
  detail: z.string().nullable(),
  durationMs: z.number().int().min(0),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

/* ------------------------------------------------------------------ *
 * Quotas (shared by buckets and the quotas module)
 * ------------------------------------------------------------------ */

export const QUOTA_MODES = ['hard', 'alert'] as const;
export const quotaModeSchema = z.enum(QUOTA_MODES);
export type QuotaMode = z.infer<typeof quotaModeSchema>;

export const quotaSchema = z.object({
  limitBytes: z.number().int().min(0),
  mode: quotaModeSchema,
  threshold: z.number().min(0).max(1),
  native: z.boolean(),
});
export type Quota = z.infer<typeof quotaSchema>;

export const QUOTA_THRESHOLD_DEFAULT = 0.8;

/* ------------------------------------------------------------------ *
 * Conflict handling (object copy/move and jobs)
 * ------------------------------------------------------------------ */

export const CONFLICT_STRATEGIES = ['skip', 'overwrite', 'rename'] as const;
export const conflictStrategySchema = z.enum(CONFLICT_STRATEGIES);
export type ConflictStrategy = z.infer<typeof conflictStrategySchema>;
