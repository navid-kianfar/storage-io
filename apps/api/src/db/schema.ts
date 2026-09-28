import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * The whole application schema. Two rules hold everywhere:
 *
 * - **Timestamps are ISO-8601 TEXT.** The contract hands ISO strings to clients,
 *   and ISO strings sort lexicographically in SQLite, so ordering and range
 *   filters work without a conversion layer.
 * - **Structured values are JSON TEXT** with a `$type` so the compiler knows the
 *   shape. SQLite has no JSON column type; the alternative is a table per nested
 *   object, which buys nothing for values only ever read whole.
 *
 * A change here is a migration: `pnpm --filter @storage-io/api db:generate`, then
 * commit the generated SQL. src/db/migrate.ts applies the folder at boot, so the
 * fresh-create path and the upgrade path are the same code.
 */

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    /** SHA-256 of the opaque token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at'),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_uq').on(table.tokenHash),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** First characters of the token, shown in the UI to tell tokens apart. */
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    expiresAt: text('expires_at'),
  },
  (table) => [uniqueIndex('api_tokens_token_hash_uq').on(table.tokenHash)],
);

/* ------------------------------------------------------------------ *
 * Servers
 * ------------------------------------------------------------------ */

/** `Record<Capability, CapabilityState>` as stored. */
export type StoredCapabilities = Record<string, string>;

export const servers = sqliteTable(
  'servers',
  {
    id: text('id').primaryKey(),
    /** Slug; doubles as the URL segment in `/servers/:id`. */
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    endpoint: text('endpoint').notNull(),
    region: text('region').notNull(),

    accessKeyId: text('access_key_id').notNull(),
    /** AES-256-GCM, key derived from APP_SECRET by HKDF. See CryptoService. */
    secretEncrypted: text('secret_encrypted').notNull(),
    /** Garage's admin bearer token, same encryption. */
    adminTokenEncrypted: text('admin_token_encrypted'),

    pathStyle: integer('path_style', { mode: 'boolean' }).notNull().default(true),
    tlsVerify: integer('tls_verify', { mode: 'boolean' }).notNull().default(true),
    caPem: text('ca_pem'),
    adminEndpoint: text('admin_endpoint'),
    iamEndpoint: text('iam_endpoint'),
    healthIntervalSec: integer('health_interval_sec').notNull().default(30),

    maintenance: integer('maintenance', { mode: 'boolean' }).notNull().default(false),
    status: text('status').notNull().default('unknown'),
    statusDetail: text('status_detail'),
    latencyMs: integer('latency_ms'),
    lastCheckedAt: text('last_checked_at'),
    lastSeenAt: text('last_seen_at'),
    version: text('version'),
    capabilities: text('capabilities', { mode: 'json' })
      .$type<StoredCapabilities>()
      .notNull()
      .default({}),

    capacityUsedBytes: integer('capacity_used_bytes'),
    capacityTotalBytes: integer('capacity_total_bytes'),
    /** True when `capacityTotalBytes` is an operator budget, not real capacity. */
    capacityBudget: integer('capacity_budget', { mode: 'boolean' }).notNull().default(false),

    bucketCount: integer('bucket_count').notNull().default(0),
    userCount: integer('user_count'),
    objectCount: integer('object_count'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('servers_name_uq').on(table.name),
    index('servers_status_idx').on(table.status),
    index('servers_provider_idx').on(table.provider),
  ],
);

/** The most recent connection-test result set, one row per check. */
export const serverChecks = sqliteTable(
  'server_checks',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    checkId: text('check_id').notNull(),
    label: text('label').notNull(),
    status: text('status').notNull(),
    detail: text('detail'),
    durationMs: integer('duration_ms').notNull(),
    at: text('at').notNull(),
  },
  (table) => [index('server_checks_server_at_idx').on(table.serverId, table.at)],
);

/** Status transitions and latency warnings, for `GET /servers/:id/events`. */
export const healthEvents = sqliteTable(
  'health_events',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    detail: text('detail'),
    at: text('at').notNull(),
  },
  (table) => [index('health_events_server_at_idx').on(table.serverId, table.at)],
);

/** Hourly capacity snapshots, behind the capacity chart. */
export const metricsCapacity = sqliteTable(
  'metrics_capacity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    at: text('at').notNull(),
    usedBytes: integer('used_bytes').notNull(),
    totalBytes: integer('total_bytes'),
  },
  (table) => [index('metrics_capacity_server_at_idx').on(table.serverId, table.at)],
);

/** One row per health check: the latency series and the uptime ratio. */
export const metricsLatency = sqliteTable(
  'metrics_latency',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    at: text('at').notNull(),
    ms: integer('ms').notNull(),
    /** False for a failed check — this is what uptime is computed from. */
    reachable: integer('reachable', { mode: 'boolean' }).notNull(),
  },
  (table) => [index('metrics_latency_server_at_idx').on(table.serverId, table.at)],
);

/**
 * Request and byte traffic, sampled with the health check from the provider's
 * metrics endpoint (MinIO's Prometheus cluster endpoint today).
 *
 * Both the **cumulative counters** and the **per-second rates** are stored. The
 * counters are what the provider reports; the rates are what the chart draws, and
 * they are derived from the previous row rather than from a value held in memory
 * — so a restart loses one sample instead of the whole series, and a counter that
 * went backwards (the server restarted) is recognisable and skipped.
 */
export const metricsTraffic = sqliteTable(
  'metrics_traffic',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    at: text('at').notNull(),
    requests: integer('requests').notNull(),
    errors: integer('errors').notNull(),
    rxBytes: integer('rx_bytes').notNull(),
    txBytes: integer('tx_bytes').notNull(),
    /** Null on the first sample after a restart or a counter reset. */
    requestsPerSec: real('requests_per_sec'),
    errorsPerSec: real('errors_per_sec'),
    rxBytesPerSec: real('rx_bytes_per_sec'),
    txBytesPerSec: real('tx_bytes_per_sec'),
  },
  (table) => [index('metrics_traffic_server_at_idx').on(table.serverId, table.at)],
);

/* ------------------------------------------------------------------ *
 * Inventory cache and app-level quotas
 * ------------------------------------------------------------------ */

/**
 * The last known bucket list per server, so aggregated lists are one local query
 * and an offline server still shows what it had.
 */
export const bucketCache = sqliteTable(
  'bucket_cache',
  {
    /**
     * The opaque id a URL carries. It is not the primary key — `(serverId, name)`
     * is, because that is what the refresher upserts on — but it is unique, and
     * it is assigned once, when the bucket is first seen, and never rewritten. A
     * bucket that disappears and comes back gets a new one, which is the honest
     * answer: it is not the same bucket.
     */
    id: text('id').notNull(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    region: text('region'),
    createdAt: text('created_at'),
    objects: integer('objects'),
    sizeBytes: integer('size_bytes'),
    statsAt: text('stats_at'),
    versioning: text('versioning').notNull().default('off'),
    objectLock: integer('object_lock', { mode: 'boolean' }).notNull().default(false),
    access: text('access').notNull().default('private'),
    owner: text('owner'),
    tags: text('tags', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
    defaultStorageClass: text('default_storage_class'),
    noncurrentVersions: integer('noncurrent_versions'),
    /** Newest `LastModified` the inventory saw — what `sort=written` orders by. */
    lastWriteAt: text('last_write_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.name] }),
    uniqueIndex('bucket_cache_id_uq').on(table.id),
    index('bucket_cache_size_idx').on(table.sizeBytes),
  ],
);

/**
 * The opaque ids of IAM entities — S3 users, groups, policies and access keys.
 *
 * None of them exists in a table of ours: the drivers read them live from each
 * storage server, and a name is unique only within one server and is not a safe
 * URL segment. So this table is a **registry, not a mirror**: it holds an id per
 * `(server, kind, name)` and nothing else about the entity. A row is written the
 * first time storage-io sees the entity and is never rewritten, so the id an
 * operator bookmarked keeps resolving.
 *
 * `lastSeenAt` is bookkeeping for a future sweep of rows whose entity is long
 * gone; nothing reads it today. A deleted entity's row stays, so recreating a
 * user with the same name reuses its id — except where the server itself was
 * deleted, which cascades.
 */
export const iamEntities = sqliteTable(
  'iam_entities',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** `user` | `group` | `policy` | `key`. */
    kind: text('kind').notNull(),
    /** The provider's own name for it; for a key, its access key id. */
    name: text('name').notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => [
    uniqueIndex('iam_entities_lookup_uq').on(table.serverId, table.kind, table.name),
    index('iam_entities_kind_idx').on(table.kind),
  ],
);

/**
 * One size sample per bucket per day, written by the inventory refresher and read
 * by the quota trend sparkline and the dashboard growth chart.
 *
 * Deliberately one row per day rather than per refresh: a trend needs seven
 * points, not seven hundred, and a `(serverId, bucket, day)` primary key makes
 * the write an idempotent upsert no matter how often the refresher runs.
 */
export const bucketSizeDaily = sqliteTable(
  'bucket_size_daily',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    bucket: text('bucket').notNull(),
    /** `YYYY-MM-DD`, UTC — sorts lexicographically, like every other timestamp. */
    day: text('day').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    objects: integer('objects'),
    at: text('at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.bucket, table.day] }),
    index('bucket_size_daily_day_idx').on(table.day),
  ],
);

/**
 * Quotas storage-io tracks itself. `native` says whether the provider also
 * enforces it; when it does not, the quota is alert-only.
 */
export const quotas = sqliteTable(
  'quotas',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    bucket: text('bucket').notNull(),
    limitBytes: integer('limit_bytes').notNull(),
    mode: text('mode').notNull(),
    threshold: integer('threshold_permille').notNull().default(800),
    native: integer('native', { mode: 'boolean' }).notNull().default(false),
    /** Set when the threshold alert last fired, so it does not repeat hourly. */
    alertedAt: text('alerted_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.serverId, table.bucket] })],
);

/**
 * What storage-io knows about an access key beyond what the provider reports:
 * an expiry on providers without one, and an in-flight rotation's grace period.
 */
export const keyMeta = sqliteTable(
  'key_meta',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    accessKeyId: text('access_key_id').notNull(),
    userName: text('user_name').notNull(),
    name: text('name'),
    createdAt: text('created_at'),
    expiresAt: text('expires_at'),
    lastUsedAt: text('last_used_at'),
    /** `active` | `disabled` | `expired`, as storage-io last set or observed it. */
    status: text('status').notNull().default('active'),
    restricted: integer('restricted', { mode: 'boolean' }).notNull().default(false),
    rotationReplacedBy: text('rotation_replaced_by'),
    rotationDisableAt: text('rotation_disable_at'),
    /** Set once the expiring-soon notification has been raised. */
    expiryNotifiedAt: text('expiry_notified_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.serverId, table.accessKeyId] }),
    index('key_meta_expires_at_idx').on(table.expiresAt),
    index('key_meta_rotation_idx').on(table.rotationDisableAt),
  ],
);

/**
 * A snapshot of a canned policy before each `PUT` made through storage-io, so a
 * bad edit is reversible even where the provider keeps no history.
 */
export const policyVersions = sqliteTable(
  'policy_versions',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    policyName: text('policy_name').notNull(),
    document: text('document', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    note: text('note'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('policy_versions_lookup_idx').on(table.serverId, table.policyName, table.createdAt),
  ],
);

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    /** Set on each run of a recurring job; null on the schedule itself. */
    parentId: text('parent_id'),
    name: text('name').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull(),

    sourceServerId: text('source_server_id').notNull(),
    sourceBucket: text('source_bucket').notNull(),
    filters: text('filters', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),

    targetServerId: text('target_server_id'),
    targetBucket: text('target_bucket'),
    targetPrefix: text('target_prefix'),

    params: text('params', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    options: text('options', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    schedule: text('schedule', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    progress: text('progress', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),

    /** Continuation token, so a job resumes where it stopped after a restart. */
    checkpoint: text('checkpoint'),
    nextRunAt: text('next_run_at'),
    waitingFor: text('waiting_for'),

    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (table) => [
    index('jobs_status_idx').on(table.status),
    index('jobs_parent_idx').on(table.parentId),
    index('jobs_next_run_idx').on(table.nextRunAt),
    index('jobs_created_idx').on(table.createdAt),
  ],
);

export const jobLogs = sqliteTable(
  'job_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    at: text('at').notNull(),
    level: text('level').notNull(),
    message: text('message').notNull(),
    key: text('key'),
  },
  (table) => [index('job_logs_job_idx').on(table.jobId, table.id)],
);

/* ------------------------------------------------------------------ *
 * Activity, notifications, settings
 * ------------------------------------------------------------------ */

export const activity = sqliteTable(
  'activity',
  {
    id: text('id').primaryKey(),
    at: text('at').notNull(),
    category: text('category').notNull(),
    action: text('action').notNull(),
    title: text('title').notNull(),
    actorType: text('actor_type').notNull(),
    actorName: text('actor_name').notNull(),
    target: text('target'),
    serverId: text('server_id'),
    serverName: text('server_name'),
    ip: text('ip'),
    result: text('result').notNull(),
    requestId: text('request_id'),
    details: text('details', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (table) => [
    index('activity_at_idx').on(table.at),
    index('activity_category_idx').on(table.category),
    index('activity_server_idx').on(table.serverId),
    index('activity_result_idx').on(table.result),
  ],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    at: text('at').notNull(),
    level: text('level').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    href: text('href'),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    /** Which `Settings.notifications.rules` key raised it, for channel routing. */
    ruleKey: text('rule_key'),
  },
  (table) => [index('notifications_read_at_idx').on(table.read, table.at)],
);

/**
 * One row per repeating alert, so the same problem does not mail an operator
 * every minute while it persists.
 *
 * `fingerprint` is the caller's own identity for the alert — rule key plus the
 * thing it is about, e.g. `server.offline:minio-lab` — and the window is a
 * property of the alert, not of the table, so a caller decides how often its own
 * kind of news is worth repeating. `suppressed` is what the next notification
 * that does get through reports, so nothing is silently dropped.
 */
export const notificationDedup = sqliteTable('notification_dedup', {
  fingerprint: text('fingerprint').primaryKey(),
  lastRaisedAt: text('last_raised_at').notNull(),
  suppressed: integer('suppressed').notNull().default(0),
});

/**
 * One row per top-level `Settings` section, so PATCHing one section is a single
 * upsert and an unknown future section cannot be lost by a whole-document write.
 */
export const settings = sqliteTable('settings', {
  section: text('section').primaryKey(),
  value: text('value', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  updatedAt: text('updated_at').notNull(),
});

/* ------------------------------------------------------------------ *
 * Inferred row types
 * ------------------------------------------------------------------ */

export type SessionRow = typeof sessions.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type ServerRow = typeof servers.$inferSelect;
export type NewServerRow = typeof servers.$inferInsert;
export type ServerCheckRow = typeof serverChecks.$inferSelect;
export type HealthEventRow = typeof healthEvents.$inferSelect;
export type MetricsCapacityRow = typeof metricsCapacity.$inferSelect;
export type MetricsLatencyRow = typeof metricsLatency.$inferSelect;
export type MetricsTrafficRow = typeof metricsTraffic.$inferSelect;
export type BucketCacheRow = typeof bucketCache.$inferSelect;
export type NewBucketCacheRow = typeof bucketCache.$inferInsert;
export type BucketSizeDailyRow = typeof bucketSizeDaily.$inferSelect;
export type IamEntityRow = typeof iamEntities.$inferSelect;
export type QuotaRowRecord = typeof quotas.$inferSelect;
export type KeyMetaRow = typeof keyMeta.$inferSelect;
export type PolicyVersionRow = typeof policyVersions.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type JobLogRow = typeof jobLogs.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
export type NewActivityRow = typeof activity.$inferInsert;
export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationDedupRow = typeof notificationDedup.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
