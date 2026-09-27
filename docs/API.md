# storage-io API contract (v1)

This document is the source of truth for `packages/contracts` (zod schemas). Change it there first, then in both apps.

- Base path: `/api/v1`. JSON everywhere except the streaming object endpoints.
- Auth: session cookie `sio_session`, or `Authorization: Bearer sio_…`. Every route requires auth unless marked **public**.
- Errors: `application/problem+json` `{ type, title, status, detail, code, errors?: [{ path, message }] }`. Stable `code` values include `AUTH_INVALID`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, `PROVIDER_ERROR`, `NOT_SUPPORTED`, `SERVER_OFFLINE`, `BUCKET_NOT_EMPTY` and `RATE_LIMITED`.
- Timestamps are ISO-8601 strings. Sizes are bytes (number). IDs are UUIDs unless stated.
- Lists return `{ items: T[], total: number }` with `page` (1-based) and `pageSize` (default 50, max 500).

## Shared types

```ts
type Provider = 'minio' | 'seaweedfs' | 'aws' | 'ceph' | 'garage' | 'r2' | 'wasabi' | 'generic'
type ServerStatus = 'healthy' | 'degraded' | 'offline' | 'maintenance' | 'unknown'
type Capability = 'objects' | 'versioning' | 'objectLock' | 'lifecycle' | 'cors' | 'bucketPolicy' | 'tagging'
  | 'replication' | 'notifications' | 'encryption' | 'storageClasses' | 'iamUsers' | 'iamGroups' | 'iamPolicies'
  | 'accessKeys' | 'accessKeyExpiry' | 'bucketQuota' | 'usageStats' | 'nodes'
type CapabilityState = 'supported' | 'not_configured' | 'not_supported'

interface Server {
  id: string; name: string /* slug, unique */; provider: Provider; endpoint: string; region: string
  status: ServerStatus; statusDetail: string | null; latencyMs: number | null; lastCheckedAt: string | null; lastSeenAt: string | null
  version: string | null; uptime24h: number | null /* 0..1 */
  capacity: { usedBytes: number | null; totalBytes: number | null /* null = unknown/unbounded */; budget: boolean }
  counts: { buckets: number; users: number | null; objects: number | null }
  capabilities: Record<Capability, CapabilityState>
  options: ServerOptions; accessKeyId: string; secretMasked: string /* "••••last4" */
  maintenance: boolean; tls: boolean; createdAt: string
}
interface ServerOptions { pathStyle: boolean; tlsVerify: boolean; caPem: string | null; adminEndpoint: string | null
  iamEndpoint: string | null; adminToken?: string /* write-only (garage) */; healthIntervalSec: number /* 15..3600 */ }

interface Bucket {
  serverId: string; serverName: string; provider: Provider; name: string; region: string | null; createdAt: string | null
  objects: number | null; sizeBytes: number | null; statsAt: string | null
  versioning: 'enabled' | 'suspended' | 'off'; objectLock: boolean
  access: 'private' | 'public-read' | 'custom'
  quota: Quota | null; unavailable: boolean /* server offline, cached data */
}
interface Quota { limitBytes: number; mode: 'hard' | 'alert'; threshold: number /* 0..1, alert level */; native: boolean }
interface CheckResult { id: string; label: string; status: 'ok' | 'warn' | 'fail' | 'skipped'; detail: string | null; durationMs: number }
```

## Auth

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/auth/login` **public** | `{ username, password, remember: boolean }` | `{ user: Me }` and sets the cookie. 401 `AUTH_INVALID`; 429 when rate-limited |
| POST | `/auth/logout` | — | 204 |
| GET | `/auth/me` | — | `Me = { username, displayName, email: string \| null }` |
| PATCH | `/auth/me` | `{ displayName?, email? }` | `Me` |
| GET | `/auth/sessions` | — | `{ items: [{ id, userAgent, ip, createdAt, lastSeenAt, expiresAt, current }] }` |
| DELETE | `/auth/sessions/:id` · `/auth/sessions?others=true` | — | 204 |
| GET | `/auth/tokens` | — | `{ items: [{ id, name, prefix, createdAt, lastUsedAt, expiresAt }] }` |
| POST | `/auth/tokens` | `{ name, expiresInDays: number \| null }` | `{ token /* shown once */, item }` |
| DELETE | `/auth/tokens/:id` | — | 204 |
| GET | `/health` **public** | — | `{ status: 'ok', version, uptimeSec }` |

## Servers

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/servers` | `?q&status&provider` | `{ items: Server[], total }` |
| POST | `/servers` | `CreateServer = { name, provider, endpoint, region, accessKeyId, secretAccessKey, options: Partial<ServerOptions> }` | `Server` (201). 409 when the name is taken |
| POST | `/servers/test` | `CreateServer` (unsaved) | `{ checks: CheckResult[], capabilities, version: string \| null, bucketCount: number \| null }` |
| GET | `/servers/:id` | — | `Server` (`:id` accepts the id or the name) |
| PATCH | `/servers/:id` | `Partial<CreateServer>` (omit secret to keep it) | `Server` |
| DELETE | `/servers/:id` | — | 204 (the saved connection is forgotten; data on the server is untouched) |
| POST | `/servers/:id/test` | — | same as `/servers/test` |
| POST | `/servers/:id/check` | — | `Server` (runs a health check now) |
| POST | `/servers/check-all` | — | 202 |
| PUT | `/servers/:id/maintenance` | `{ enabled }` | `Server` |
| GET | `/servers/:id/metrics` | `?range=24h\|7d\|30d` | `{ capacity: [{ t, usedBytes, totalBytes }], latency: [{ t, ms }], uptime: number }` |
| GET | `/servers/:id/nodes` | — | `{ items: [{ name, endpoint, state: 'online'\|'offline'\|'degraded', drivesOnline, drivesTotal, uptimeSec, cpu: number\|null, mem: number\|null, usedBytes, totalBytes }] }` (`NOT_SUPPORTED` when the capability is missing) |
| GET | `/servers/:id/events` | `?limit` | `{ items: [{ at, kind: 'up'\|'down'\|'degraded'\|'latency'\|'check', detail }] }` |

## Buckets

All per-bucket paths are prefixed `/servers/:sid/buckets/:bucket`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/buckets` | `?q&serverId&access&sort=size\|name\|quota\|written&page&pageSize` | `{ items: Bucket[], total, summary: { buckets, sizeBytes, objects, withQuota, nearQuota, public } }` |
| POST | `/servers/:sid/buckets` | `{ name, region?, versioning: boolean, objectLock: boolean, quota: { limitBytes, mode } \| null, access }` | `Bucket` (201) |
| GET | `…` | — | `BucketDetail = Bucket & { owner: string \| null, tags: Record<string,string>, defaultStorageClass: string \| null, noncurrentVersions: number \| null }` |
| DELETE | `…` | `?force=false` | 204. 409 `BUCKET_NOT_EMPTY` |
| POST | `…/empty` | `{ includeVersions: boolean }` | `Job` (202) |
| GET · PUT | `…/access` | `{ access: 'private'\|'public-read' }` | `{ access, policy: object \| null }` |
| GET · PUT | `…/policy` | `{ policy: object \| null }` | `{ policy }` |
| GET · PUT | `…/versioning` | `{ status: 'enabled'\|'suspended' }` | `{ status }` |
| GET · PUT | `…/object-lock` | `{ mode: 'GOVERNANCE'\|'COMPLIANCE'\|null, days: number\|null, years: number\|null }` | `{ enabled, mode, days, years }` |
| GET · PUT | `…/lifecycle` | `{ rules: LifecycleRule[] }` | `{ rules }` |
| GET · PUT | `…/cors` | `{ rules: CorsRule[] }` | `{ rules }` |
| GET · PUT | `…/tags` | `{ tags: Record<string,string> }` | `{ tags }` |
| GET · PUT | `…/replication` | `{ rules: ReplicationRule[] }` | `{ rules, status }` |
| GET · PUT | `…/notifications` | `{ targets: NotificationTarget[] }` | `{ targets }` |
| GET · PUT | `…/quota` | `{ limitBytes: number \| null, mode, threshold }` | `{ quota: Quota \| null, usage: { sizeBytes, objects } }` |

```ts
interface LifecycleRule { id: string; enabled: boolean; prefix: string; tags: Record<string,string>
  expireDays: number | null; noncurrentExpireDays: number | null; abortMultipartDays: number | null
  transition: { days: number; storageClass: string } | null; expiredDeleteMarkers: boolean }
interface CorsRule { allowedOrigins: string[]; allowedMethods: string[]; allowedHeaders: string[]; exposeHeaders: string[]; maxAgeSeconds: number | null }
interface ReplicationRule { id: string; enabled: boolean; prefix: string; destination: { bucketArn: string; storageClass: string | null }; deleteMarkers: boolean; priority: number }
interface NotificationTarget { id: string; arn: string; kind: 'queue'|'topic'|'lambda'; events: string[]; prefix: string; suffix: string }
```

## Objects

All paths are prefixed `/servers/:sid/buckets/:bucket/objects`. `key` always travels in the query string (URL-encoded).

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `` | `?prefix&delimiter=/&cursor&limit=200&q&showVersions=false` | `{ prefixes: [{ prefix }], objects: ObjectItem[], nextCursor: string \| null }` |
| GET | `/meta` | `?key&versionId` | `ObjectMeta` |
| GET | `/download` | `?key&versionId&inline=false` | byte stream; honours `Range`, sets `Content-Disposition` |
| POST | `/download-zip` | `{ keys: string[], prefixes: string[] }` | `application/zip` stream |
| PUT | `/upload` | `?key&overwrite=true` raw body; headers `Content-Type`, `X-Sio-Meta-*`, `X-Sio-Tags`, `X-Sio-Storage-Class` | `ObjectItem` (409 `CONFLICT` if `overwrite=false` and the key exists) |
| PUT | `/content` | `?key` text body (edit in place → new version) | `ObjectItem` |
| POST | `/folder` | `{ prefix }` | 201 |
| POST | `/delete` | `{ objects: [{ key, versionId? }], prefixes: string[], allVersions: boolean }` | `{ deleted: number, errors: [{ key, message }], job: Job \| null }` (prefixes and big sets become a job) |
| POST | `/copy` | `{ keys: string[], prefixes: string[], destServerId, destBucket, destPrefix, move: boolean, conflict: 'skip'\|'overwrite'\|'rename' }` | `{ copied, errors, job: Job \| null }` |
| POST | `/rename` | `{ key, newKey }` | `ObjectItem` |
| GET | `/versions` | `?key` | `{ items: ObjectVersion[] }` |
| POST | `/restore-version` | `{ key, versionId }` | `ObjectItem` |
| GET · PUT | `/tags` | `?key&versionId` · `{ tags }` | `{ tags }` |
| PUT | `/metadata` | `?key` `{ contentType, cacheControl, contentDisposition, metadata: Record<string,string> }` | `ObjectMeta` |
| PUT | `/retention` | `?key&versionId` `{ mode: 'GOVERNANCE'\|'COMPLIANCE', until } \| { legalHold: boolean }` | `ObjectMeta` |
| POST | `/presign` | `{ key, versionId?, expiresInSeconds /* 60..604800 */, download: boolean }` | `{ url, expiresAt }` |

```ts
interface ObjectItem { key: string; size: number; lastModified: string; etag: string; storageClass: string | null
  versionId: string | null; isLatest: boolean | null; deleteMarker: boolean }
interface ObjectMeta extends ObjectItem { contentType: string | null; cacheControl: string | null; contentDisposition: string | null
  metadata: Record<string,string>; tags: Record<string,string>; retention: { mode, until } | null; legalHold: boolean | null; versionCount: number | null }
interface ObjectVersion { versionId: string; lastModified: string; size: number; isLatest: boolean; deleteMarker: boolean; etag: string | null }
```

## IAM: S3 users, groups, policies, access keys

Aggregated lists span every server whose driver supports them. Servers that failed come back in `unavailable: [{ serverId, message }]`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/iam/users` | `?serverId&q&status&page&pageSize` | `{ items: S3User[], total, unavailable }` |
| POST | `/servers/:sid/iam/users` | `{ name, secret: string \| null /* minio */, policies: string[], groups: string[], createAccessKey: boolean }` | `{ user: S3User, accessKey: CreatedKey \| null }` |
| GET · PATCH · DELETE | `/servers/:sid/iam/users/:name` | PATCH `{ status: 'enabled'\|'disabled' }` | `S3UserDetail` / 204 |
| PUT | `/servers/:sid/iam/users/:name/policies` | `{ policies: string[] }` (full set) | `S3UserDetail` |
| PUT | `/servers/:sid/iam/users/:name/groups` | `{ groups: string[] }` | `S3UserDetail` |
| GET | `/iam/groups` | `?serverId&q` | `{ items: S3Group[], total, unavailable }` |
| POST · PATCH · DELETE | `/servers/:sid/iam/groups[/:name]` | `{ name, members: string[], policies: string[], status? }` | `S3Group` / 204 |
| GET | `/iam/policies` | `?serverId&q` | `{ items: PolicySummary[], total, unavailable }` |
| GET · PUT · DELETE | `/servers/:sid/iam/policies/:name` | PUT `{ document: object, description?: string }` (create or replace) | `PolicyDetail` / 204 (built-ins are read-only → 409) |
| POST | `/iam/policies/validate` | `{ document }` | `{ valid, errors: [{ path, message }], warnings: string[] }` |
| POST | `/iam/policies/simulate` | `{ document, action, resource, context?: Record<string,string> }` | `{ decision: 'allow'\|'deny'\|'implicit-deny', statementSid: string \| null, statementIndex: number \| null }` |
| GET | `/iam/access-keys` | `?serverId&userName&status=active\|expiring\|disabled\|expired&q&page` | `{ items: AccessKey[], total, counts: { all, active, expiring, disabled }, unavailable }` |
| POST | `/servers/:sid/iam/access-keys` | `{ userName, name, expiresAt: string \| null, policy: object \| null }` | `CreatedKey` (201, the secret is shown once) |
| PATCH · DELETE | `/servers/:sid/iam/access-keys/:accessKeyId` | `{ name?, status?, expiresAt? }` | `AccessKey` / 204 |
| POST | `/servers/:sid/iam/access-keys/:accessKeyId/rotate` | `{ graceSeconds: number /* 0 = disable now */, expiresAt: string \| null }` | `CreatedKey` |

```ts
interface S3User { serverId: string; serverName: string; provider: Provider; name: string; status: 'enabled'|'disabled'|'unknown'
  policies: string[]; groups: string[]; accessKeyCount: number; createdAt: string | null; lastActivityAt: string | null }
interface S3UserDetail extends S3User { accessKeys: AccessKey[]; inheritedPolicies: [{ policy, fromGroup }] }
interface S3Group { serverId; serverName; name; members: string[]; policies: string[]; status: 'enabled'|'disabled' }
interface PolicySummary { serverId; serverName; name; builtIn: boolean; description: string | null; attachedCount: number; updatedAt: string | null }
interface PolicyDetail extends PolicySummary { document: object; attachedTo: { users: string[]; groups: string[] } }
interface AccessKey { serverId; serverName; provider; accessKeyId: string; userName: string; name: string | null
  status: 'active'|'disabled'|'expired'; restricted: boolean; createdAt: string | null; expiresAt: string | null; lastUsedAt: string | null
  rotation: { replacedBy: string; disableAt: string } | null }
interface CreatedKey { accessKey: AccessKey; secretAccessKey: string; endpoint: string; region: string }
```

## Quotas

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/quotas` | `?q&serverId&filter=all\|near\|unlimited&page` | `{ items: [{ bucket: Bucket, usageRatio: number \| null, trend: number[] /* 7 daily sizes */, supported: 'native'\|'alert-only'\|'unavailable' }], total, summary: { withQuota, over90, over80, unlimited } }` |

Quotas are set per bucket via `PUT …/quota`. When the driver has no native quota, the API stores an alert-only quota (`native: false`).

## Bulk jobs

```ts
type JobType = 'copy'|'move'|'delete'|'tag'|'storage-class'|'retention'|'restore-versions'|'empty-bucket'
type JobStatus = 'queued'|'scheduled'|'running'|'paused'|'completed'|'completed_with_errors'|'failed'|'cancelled'
interface JobFilters { prefix: string; modifiedAfter: string|null; modifiedBefore: string|null; minSize: number|null; maxSize: number|null; glob: string|null; tags: Record<string,string> }
interface Job { id; name; type: JobType; status: JobStatus
  source: { serverId; serverName; bucket; filters: JobFilters }
  target: { serverId; serverName; bucket; prefix } | null
  params: { tags?; storageClass?; retention?: { mode, days }; includeVersions?: boolean }
  options: { conflict: 'skip'|'overwrite'|'rename'; concurrency: number /* 1..64 */; dryRun: boolean }
  schedule: { kind: 'now' } | { kind: 'at'; at: string } | { kind: 'cron'; cron: string; timezone: string; enabled: boolean; nextRunAt: string|null }
  progress: { total: number|null; processed: number; failed: number; skipped: number; bytes: number; objectsPerSec: number; bytesPerSec: number; etaSeconds: number|null }
  createdAt; startedAt; finishedAt; waitingFor: string | null /* e.g. "ceph-lab offline" */ }
```

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/jobs` | `?view=active\|scheduled\|history&page` | `{ items: Job[], total, counts: { active, scheduled, history } }` |
| POST | `/jobs` | `{ name?, type, source: { serverId, bucket, filters }, target?, params, options, schedule }` | `Job` (201) |
| POST | `/jobs/estimate` | `{ source }` | `{ objects, bytes, partial: boolean }` (time-boxed listing) |
| GET · PATCH · DELETE | `/jobs/:id` | PATCH `{ enabled?, name? }` | `Job` / 204 |
| POST | `/jobs/:id/{pause,resume,cancel,run-now}` | — | `Job` |
| GET | `/jobs/:id/logs` | `?cursor&level=all\|error` | `{ items: [{ at, level: 'info'\|'warn'\|'error', message, key: string\|null }], nextCursor }` |

## Activity, notifications, dashboard, search, settings, events

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/activity` | `?q&from&to&serverId&category=objects\|buckets\|access\|servers\|jobs\|system\|auth&result=success\|failure\|warning&page` | `{ items: ActivityEvent[], total }` |
| GET | `/activity/:id` | — | `ActivityEvent` |
| GET | `/activity/export.csv` | same filters | `text/csv` |
| GET | `/notifications` | `?unread=true` | `{ items: [{ id, at, level: 'info'\|'warning'\|'error', title, detail, href: string\|null, read }], unread }` |
| POST | `/notifications/read` | `{ ids: string[] \| 'all' }` | 204 |
| GET | `/dashboard` | — | `Dashboard` (see below) |
| GET | `/search` | `?q&limit=20` | `{ items: [{ type: 'server'\|'bucket'\|'user'\|'key'\|'policy'\|'job', id, label, sublabel, href }] }` |
| GET · PATCH | `/settings` | PATCH: partial `Settings` | `Settings` |
| POST | `/settings/notifications/test` | `{ channel: 'email'\|'webhook' }` | `{ ok, detail }` |
| POST | `/settings/export` | `{ passphrase }` | `application/octet-stream` (encrypted config) |
| POST | `/settings/import` | multipart `file` + `passphrase` | `{ servers: number, settings: boolean }` |
| GET | `/events` | SSE | `event: server.health\|job.progress\|job.status\|notification\|inventory.updated`, `data: JSON` |

```ts
interface ActivityEvent { id; at; category; action: string /* e.g. "object.delete" */; title: string
  actor: { type: 'admin'|'system'|'token'; name: string }; target: string | null; serverId: string | null; serverName: string | null
  ip: string | null; result: 'success'|'failure'|'warning'; requestId: string | null; details: object }
interface Dashboard {
  totals: { usedBytes; capacityBytes; objects; buckets; usedDelta7dBytes; objectsDeltaToday: number | null
    servers: { total; healthy; degraded; offline } ; nearQuotaBuckets: number }
  growth: [{ t: string; usedBytes: number }] /* 30 daily points */
  byServer: [{ serverId; name; provider; usedBytes; totalBytes }]
  jobs: Job[] /* active, max 3 */; activity: ActivityEvent[] /* 6 */; expiringKeys: AccessKey[] /* next 30 days */
  largestBuckets: Bucket[] /* 5 */; incidents: [{ serverId; serverName; status; detail; since }]
}
interface Settings {
  profile: { displayName; email: string | null }
  security: { sessionTtlHours: number; allowedNetworks: string[] }
  appearance: { density: 'comfortable'|'compact' }   // per-browser prefs such as theme stay client-side
  region: { timezone: string; sizeUnits: 'decimal'|'binary'; calendar: 'auto'|'gregory'|'persian'|'islamic'; digits: 'auto'|'latn'; weekStart: 'auto'|0|1|6 }
  transfers: { parallel: number; partSizeMb: 8|16|64; bandwidthLimitMbps: number | null; verifyChecksums: boolean; keepIncompleteDays: number }
  notifications: { email: { enabled; host; port; secure; username; password?: string /* write-only */; from; to: string[] }
    webhook: { enabled; url; secret?: string }
    rules: Record<'server.offline'|'quota.threshold'|'key.expiring'|'job.failed'|'auth.new-device', { inApp: boolean; email: boolean; webhook: boolean }> }
  retention: { activityDays: number; metricsDays: number }
  health: { defaultIntervalSec: number; latencyWarnMs: number }
}
```

## Additions (every concept action is implemented; none are stubs)

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/servers/:sid/buckets/:bucket/objects/import-url` | `{ url, key, overwrite }` (the API fetches the URL server-side, streams it into the bucket, max size from settings) | `ObjectItem` |
| PUT | `/servers/:sid/buckets/:bucket/objects/storage-class` | `?key` `{ storageClass }` | `ObjectMeta` |
| POST | `/buckets/bulk` | `{ buckets: [{ serverId, bucket }], action: 'quota'\|'lifecycle-rule'\|'tags'\|'access', payload }` | `{ results: [{ serverId, bucket, ok, message }] }` |
| POST | `/servers/:id/rotate-credentials` | `{ mode: 'auto' } \| { mode: 'manual', accessKeyId, secretAccessKey }` (auto: create a new admin key through the IAM driver, verify it, swap the stored credentials, then disable/delete the old key) | `{ server: Server, rotatedAt }` |
| GET | `/servers/:id/nodes/:node/drives` | — | `{ items: [{ path, state, usedBytes, totalBytes, model: string\|null, healing: boolean }] }` |
| GET | `/servers/:sid/iam/policies/:name/versions` | — | `{ items: [{ id, createdAt, document, note }] }` (the app DB snapshots every PUT made through storage-io) |
| POST | `/servers/:sid/iam/policies/:name/versions/:vid/restore` | — | `PolicyDetail` |
| GET | `/iam/users/export.csv` · `/iam/access-keys/export.csv` | list filters | `text/csv` |
| PATCH | `/jobs/:id` | `{ enabled?, name?, concurrency?, schedule? }` (live concurrency change for running jobs; schedule edit for scheduled ones) | `Job` |
| POST | `/jobs/:id/duplicate` | `{ asSchedule?: { cron, timezone } }` | `Job` |
| GET | `/jobs/:id/runs` | `?page` | `{ items: Job[], total }` (each run of a recurring job is a child `Job` with `parentId`) |
| GET | `/servers/:sid/buckets/:bucket/notifications/status` | — | `{ items: [{ targetId, arn, state: 'online'\|'offline'\|'unknown', detail }] }` (MinIO target status via admin API; other providers return `unknown`) |

Contract additions: `Job.parentId: string | null`. Settings gains `notifications.telegram: { enabled, botToken?: string /* write-only */, chatId }` (with rule flags per channel), `activity.syslog: { enabled, host, port, protocol: 'udp'|'tcp'|'tls', format: 'rfc5424'|'json', facility }` and `transfers.importUrlMaxMb`. `POST /settings/notifications/test` accepts `channel: 'email'|'webhook'|'telegram'|'syslog'`. Admin credentials come from env, so there is no password-change endpoint; the Settings page shows them as "Managed by environment".
