import { z } from 'zod';
import {
  capabilityMapSchema,
  checkResultSchema,
  isoDateTime,
  itemsOf,
  listOf,
  providerSchema,
  serverStatusSchema,
} from './common.js';

export const HEALTH_INTERVAL_MIN_SEC = 15;
export const HEALTH_INTERVAL_MAX_SEC = 3600;
export const HEALTH_INTERVAL_DEFAULT_SEC = 30;

/** Slug: the server name doubles as the URL segment in `/servers/:id`. */
export const SERVER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const serverNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    SERVER_NAME_PATTERN,
    'lowercase letters, digits and dashes; must start and end alphanumeric',
  );

export const serverOptionsSchema = z.object({
  pathStyle: z.boolean(),
  tlsVerify: z.boolean(),
  caPem: z.string().nullable(),
  adminEndpoint: z.string().nullable(),
  iamEndpoint: z.string().nullable(),
  healthIntervalSec: z.number().int().min(HEALTH_INTERVAL_MIN_SEC).max(HEALTH_INTERVAL_MAX_SEC),
});
export type ServerOptions = z.infer<typeof serverOptionsSchema>;

export const SERVER_OPTION_DEFAULTS: ServerOptions = {
  pathStyle: true,
  tlsVerify: true,
  caPem: null,
  adminEndpoint: null,
  iamEndpoint: null,
  healthIntervalSec: HEALTH_INTERVAL_DEFAULT_SEC,
};

/** What a client may send: every option optional, plus the write-only admin token. */
export const serverOptionsInputSchema = serverOptionsSchema.partial().extend({
  /** Write-only (Garage admin API). Never returned. */
  adminToken: z.string().max(4096).optional(),
});
export type ServerOptionsInput = z.infer<typeof serverOptionsInputSchema>;

export const serverCapacitySchema = z.object({
  usedBytes: z.number().min(0).nullable(),
  /** `null` = unknown or unbounded. */
  totalBytes: z.number().min(0).nullable(),
  /** True when `totalBytes` is an operator-set budget rather than real capacity. */
  budget: z.boolean(),
});
export type ServerCapacity = z.infer<typeof serverCapacitySchema>;

export const serverCountsSchema = z.object({
  buckets: z.number().int().min(0),
  users: z.number().int().min(0).nullable(),
  objects: z.number().int().min(0).nullable(),
});
export type ServerCounts = z.infer<typeof serverCountsSchema>;

export const serverSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: providerSchema,
  endpoint: z.string(),
  region: z.string(),
  status: serverStatusSchema,
  statusDetail: z.string().nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  lastCheckedAt: isoDateTime.nullable(),
  lastSeenAt: isoDateTime.nullable(),
  version: z.string().nullable(),
  /** 0..1 over the last 24 hours. */
  uptime24h: z.number().min(0).max(1).nullable(),
  capacity: serverCapacitySchema,
  counts: serverCountsSchema,
  capabilities: capabilityMapSchema,
  options: serverOptionsSchema,
  accessKeyId: z.string(),
  /** `"••••last4"` — the secret itself never leaves the API. */
  secretMasked: z.string(),
  maintenance: z.boolean(),
  tls: z.boolean(),
  createdAt: isoDateTime,
});
export type Server = z.infer<typeof serverSchema>;

export const serverListSchema = listOf(serverSchema);
export type ServerList = z.infer<typeof serverListSchema>;

export const listServersQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: serverStatusSchema.optional(),
  provider: providerSchema.optional(),
});
export type ListServersQuery = z.infer<typeof listServersQuerySchema>;

export const createServerRequestSchema = z.object({
  name: serverNameSchema,
  provider: providerSchema,
  endpoint: z.url({ protocol: /^https?$/ }),
  region: z.string().min(1).max(64),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(1024),
  options: serverOptionsInputSchema.default({}),
});
export type CreateServerRequest = z.infer<typeof createServerRequestSchema>;

/** PATCH: every field optional; omitting `secretAccessKey` keeps the stored one. */
export const updateServerRequestSchema = createServerRequestSchema.partial();
export type UpdateServerRequest = z.infer<typeof updateServerRequestSchema>;

export const testServerResponseSchema = z.object({
  checks: z.array(checkResultSchema),
  capabilities: capabilityMapSchema,
  version: z.string().nullable(),
  bucketCount: z.number().int().min(0).nullable(),
});
export type TestServerResponse = z.infer<typeof testServerResponseSchema>;

export const setMaintenanceRequestSchema = z.object({ enabled: z.boolean() });
export type SetMaintenanceRequest = z.infer<typeof setMaintenanceRequestSchema>;

/* ----------------------------- metrics ---------------------------- */

export const METRIC_RANGES = ['24h', '7d', '30d'] as const;
export const metricRangeSchema = z.enum(METRIC_RANGES);
export type MetricRange = z.infer<typeof metricRangeSchema>;

export const serverMetricsQuerySchema = z.object({
  range: metricRangeSchema.default('24h'),
});
export type ServerMetricsQuery = z.infer<typeof serverMetricsQuerySchema>;

export const capacityPointSchema = z.object({
  t: isoDateTime,
  usedBytes: z.number().min(0),
  totalBytes: z.number().min(0).nullable(),
});
export type CapacityPoint = z.infer<typeof capacityPointSchema>;

export const latencyPointSchema = z.object({ t: isoDateTime, ms: z.number().min(0) });
export type LatencyPoint = z.infer<typeof latencyPointSchema>;

export const serverMetricsSchema = z.object({
  capacity: z.array(capacityPointSchema),
  latency: z.array(latencyPointSchema),
  uptime: z.number().min(0).max(1),
});
export type ServerMetrics = z.infer<typeof serverMetricsSchema>;

/* ------------------------------ nodes ----------------------------- */

export const NODE_STATES = ['online', 'offline', 'degraded'] as const;
export const nodeStateSchema = z.enum(NODE_STATES);
export type NodeState = z.infer<typeof nodeStateSchema>;

export const serverNodeSchema = z.object({
  name: z.string(),
  endpoint: z.string(),
  state: nodeStateSchema,
  drivesOnline: z.number().int().min(0),
  drivesTotal: z.number().int().min(0),
  uptimeSec: z.number().int().min(0).nullable(),
  cpu: z.number().nullable(),
  mem: z.number().nullable(),
  usedBytes: z.number().min(0).nullable(),
  totalBytes: z.number().min(0).nullable(),
});
export type ServerNode = z.infer<typeof serverNodeSchema>;

export const serverNodeListSchema = itemsOf(serverNodeSchema);
export type ServerNodeList = z.infer<typeof serverNodeListSchema>;

/* ------------------------- health events -------------------------- */

export const HEALTH_EVENT_KINDS = ['up', 'down', 'degraded', 'latency', 'check'] as const;
export const healthEventKindSchema = z.enum(HEALTH_EVENT_KINDS);
export type HealthEventKind = z.infer<typeof healthEventKindSchema>;

export const serverHealthEventSchema = z.object({
  at: isoDateTime,
  kind: healthEventKindSchema,
  detail: z.string().nullable(),
});
export type ServerHealthEvent = z.infer<typeof serverHealthEventSchema>;

export const serverHealthEventListSchema = itemsOf(serverHealthEventSchema);
export type ServerHealthEventList = z.infer<typeof serverHealthEventListSchema>;

export const serverEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type ServerEventsQuery = z.infer<typeof serverEventsQuerySchema>;

/* ----------------------- credential rotation ---------------------- */

/**
 * `auto` asks the IAM driver for a fresh admin key, verifies it, swaps the
 * stored credentials and then disables the old one. `manual` takes a key the
 * operator created elsewhere.
 */
export const rotateServerCredentialsRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }),
  z.object({
    mode: z.literal('manual'),
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(1024),
  }),
]);
export type RotateServerCredentialsRequest = z.infer<typeof rotateServerCredentialsRequestSchema>;

export const rotateServerCredentialsResponseSchema = z.object({
  server: serverSchema,
  rotatedAt: isoDateTime,
});
export type RotateServerCredentialsResponse = z.infer<typeof rotateServerCredentialsResponseSchema>;

/* ------------------------------ drives ---------------------------- */

export const DRIVE_STATES = ['ok', 'offline', 'healing', 'unformatted', 'unknown'] as const;
export const driveStateSchema = z.enum(DRIVE_STATES);
export type DriveState = z.infer<typeof driveStateSchema>;

export const serverDriveSchema = z.object({
  path: z.string(),
  state: driveStateSchema,
  usedBytes: z.number().min(0).nullable(),
  totalBytes: z.number().min(0).nullable(),
  model: z.string().nullable(),
  healing: z.boolean(),
});
export type ServerDrive = z.infer<typeof serverDriveSchema>;

export const serverDriveListSchema = itemsOf(serverDriveSchema);
export type ServerDriveList = z.infer<typeof serverDriveListSchema>;
