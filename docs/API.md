# storage-io API contract (v1)

This document is the source of truth for `packages/contracts` (zod schemas). Change it there first, then in both apps.

- Base path: `/api/v1`. JSON everywhere except the streaming object endpoints.
- Auth: session cookie `sio_session`, or `Authorization: Bearer sio_…`. Every route requires auth unless marked **public**.
- Errors: `application/problem+json` `{ type, title, status, detail, code, errors?: [{ path, message }] }`. Stable `code` values include `AUTH_INVALID`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, `PROVIDER_ERROR`, `NOT_SUPPORTED`, `SERVER_OFFLINE`, `BUCKET_NOT_EMPTY` and `RATE_LIMITED`.
- Timestamps are ISO-8601 strings. Sizes are bytes (number). IDs are UUIDs unless stated.
- **Every entity a URL can point at carries an opaque `id`.** `docs/ROUTES.md` is binding here: a route param is an id, never a server, bucket, user, group, policy or key **name**. A bucket's id is stable per `(serverId, name)` and lives on its cache row; a user's, group's, policy's and access key's is stable per `(serverId, kind, name)` and lives in `iam_entities`. Both are assigned the first time storage-io sees the entity, survive a restart, and are released only when the entity's row is (a deleted bucket; a deleted **server** for an IAM entity) — so a bucket deleted and created again gets a new id. The name-based endpoints under `/servers/:sid/…` are unchanged; the resolve endpoints below turn an id into one.
- Lists return `{ items: T[], total: number }` with `page` (1-based) and `pageSize` (default 50, max 500).

## Shared types

```ts
type Provider =
  | 'minio'
  | 'seaweedfs'
  | 'aws'
  | 'ceph'
  | 'garage'
  | 'r2'
  | 'wasabi'
  | 'generic';
type ServerStatus =
  'healthy' | 'degraded' | 'offline' | 'maintenance' | 'unknown';
type Capability =
  | 'objects'
  | 'versioning'
  | 'objectLock'
  | 'lifecycle'
  | 'cors'
  | 'bucketPolicy'
  | 'tagging'
  | 'replication'
  | 'notifications'
  | 'encryption'
  | 'storageClasses'
  | 'iamUsers'
  | 'iamGroups'
  | 'iamPolicies'
  | 'accessKeys'
  | 'accessKeyExpiry'
  | 'bucketQuota'
  | 'usageStats'
  | 'nodes'
  | 'traffic';
type CapabilityState = 'supported' | 'not_configured' | 'not_supported';

interface Server {
  id: string;
  name: string /* slug, unique */;
  provider: Provider;
  endpoint: string;
  region: string;
  status: ServerStatus;
  statusDetail: string | null;
  latencyMs: number | null;
  lastCheckedAt: string | null;
  lastSeenAt: string | null;
  version: string | null;
  uptime24h: number | null; /* 0..1 */
  capacity: {
    usedBytes: number | null;
    totalBytes: number | null /* null = unknown/unbounded */;
    budget: boolean;
  };
  counts: { buckets: number; users: number | null; objects: number | null };
  capabilities: Record<Capability, CapabilityState>;
  options: ServerOptions;
  accessKeyId: string;
  secretMasked: string; /* "••••last4" */
  maintenance: boolean;
  tls: boolean;
  createdAt: string;
}
interface ServerOptions {
  pathStyle: boolean;
  tlsVerify: boolean;
  caPem: string | null;
  adminEndpoint: string | null;
  iamEndpoint: string | null;
  adminToken?: string /* write-only (garage) */;
  healthIntervalSec: number; /* 15..3600 */
}

interface Bucket {
  id: string; /* opaque, stable per (serverId, name) */
  serverId: string;
  serverName: string;
  provider: Provider;
  name: string;
  region: string | null;
  createdAt: string | null;
  objects: number | null;
  sizeBytes: number | null;
  statsAt: string | null;
  versioning: 'enabled' | 'suspended' | 'off';
  objectLock: boolean;
  access: 'private' | 'public-read' | 'custom';
  quota: Quota | null;
  unavailable: boolean; /* server offline, cached data */
}
interface Quota {
  limitBytes: number;
  mode: 'hard' | 'alert';
  threshold: number /* 0..1, alert level */;
  native: boolean;
}
interface CheckResult {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  detail: string | null;
  durationMs: number;
}
```

## Auth

| Method | Path                                                | Body                                        | Response                                                                                                                                                                                                |
| ------ | --------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/login` **public**                            | `{ username, password, remember: boolean }` | `{ user: Me }` and sets the cookie. 401 `AUTH_INVALID`; 429 when rate-limited                                                                                                                           |
| POST   | `/auth/logout`                                      | —                                           | 204                                                                                                                                                                                                     |
| GET    | `/auth/me`                                          | —                                           | `Me = { username, displayName, email: string \| null }`                                                                                                                                                 |
| PATCH  | `/auth/me`                                          | `{ displayName?, email? }`                  | `Me`                                                                                                                                                                                                    |
| GET    | `/auth/sessions`                                    | —                                           | `{ items: [{ id, userAgent, ip, createdAt, lastSeenAt, expiresAt, current }] }`                                                                                                                         |
| DELETE | `/auth/sessions/:id` · `/auth/sessions?others=true` | —                                           | 204                                                                                                                                                                                                     |
| GET    | `/auth/tokens`                                      | —                                           | `{ items: [{ id, name, prefix, createdAt, lastUsedAt, expiresAt }] }`                                                                                                                                   |
| POST   | `/auth/tokens`                                      | `{ name, expiresInDays: number \| null }`   | `{ token /* shown once */, item }`                                                                                                                                                                      |
| DELETE | `/auth/tokens/:id`                                  | —                                           | 204                                                                                                                                                                                                     |
| GET    | `/health` · `/api/v1/health` **public**             | —                                           | `{ status: 'ok', version, uptimeSec }` — the same probe on both paths. `/health` is outside the version prefix for the container healthcheck and is the one path exempt from `security.allowedNetworks` |

## Servers

| Method | Path                       | Body / query                                                                                                         | Response                                                                                                                                                                                                                      |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/servers`                 | `?q&status&provider`                                                                                                 | `{ items: Server[], total }`                                                                                                                                                                                                  |
| POST   | `/servers`                 | `CreateServer = { name, provider, endpoint, region, accessKeyId, secretAccessKey, options: Partial<ServerOptions> }` | `Server` (201). 409 when the name is taken                                                                                                                                                                                    |
| POST   | `/servers/test`            | `CreateServer` (unsaved)                                                                                             | `{ checks: CheckResult[], capabilities, version: string \| null, bucketCount: number \| null }`                                                                                                                               |
| GET    | `/servers/:id`             | —                                                                                                                    | `Server` (`:id` accepts the id or the name)                                                                                                                                                                                   |
| PATCH  | `/servers/:id`             | `Partial<CreateServer>` (omit secret to keep it)                                                                     | `Server`                                                                                                                                                                                                                      |
| DELETE | `/servers/:id`             | —                                                                                                                    | 204 (the saved connection is forgotten; data on the server is untouched)                                                                                                                                                      |
| POST   | `/servers/:id/test`        | —                                                                                                                    | same as `/servers/test`                                                                                                                                                                                                       |
| POST   | `/servers/:id/check`       | —                                                                                                                    | `Server` (runs a health check now)                                                                                                                                                                                            |
| POST   | `/servers/check-all`       | —                                                                                                                    | 202                                                                                                                                                                                                                           |
| PUT    | `/servers/:id/maintenance` | `{ enabled }`                                                                                                        | `Server`                                                                                                                                                                                                                      |
| GET    | `/servers/:id/metrics`     | `?range=24h\|7d\|30d`                                                                                                | `{ capacity: [{ t, usedBytes, totalBytes }], latency: [{ t, ms }], uptime: number, traffic: [{ t, requestsPerSec, errorsPerSec, rxBytesPerSec, txBytesPerSec }] \| null }`                                                    |
| GET    | `/servers/:id/nodes`       | —                                                                                                                    | `{ items: [{ name, endpoint, state: 'online'\|'offline'\|'degraded', drivesOnline, drivesTotal, uptimeSec, cpu: number\|null, mem: number\|null, usedBytes, totalBytes }] }` (`NOT_SUPPORTED` when the capability is missing) |
| GET    | `/servers/:id/events`      | `?limit`                                                                                                             | `{ items: [{ at, kind: 'up'\|'down'\|'degraded'\|'latency'\|'check', detail }] }`                                                                                                                                             |

## Buckets

All per-bucket paths are prefixed `/servers/:sid/buckets/:bucket`.

| Method    | Path                    | Body / query                                                                                               | Response                                                                                                                                                                                                                                                  |
| --------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET       | `/buckets`              | `?q&serverId&access&sort=size\|name\|quota\|written&page&pageSize`                                         | `{ items: Bucket[], total, summary: { buckets, sizeBytes, objects, withQuota, nearQuota, public } }`                                                                                                                                                      |
| GET       | `/buckets/:bucketId`    | —                                                                                                          | `BucketDetail` — resolves the opaque id, refreshing from the bucket's server when it is reachable and answering from the cache when it is not. 404 `NOT_FOUND` for an id that names nothing. Declared **below** `/buckets/export.csv` and `/buckets/bulk` |
| POST      | `/servers/:sid/buckets` | `{ name, region?, versioning: boolean, objectLock: boolean, quota: { limitBytes, mode } \| null, access }` | `Bucket` (201)                                                                                                                                                                                                                                            |
| GET       | `…`                     | —                                                                                                          | `BucketDetail = Bucket & { owner: string \| null, tags: Record<string,string>, defaultStorageClass: string \| null, noncurrentVersions: number \| null }`                                                                                                 |
| DELETE    | `…`                     | `?force=false`                                                                                             | 204. 409 `BUCKET_NOT_EMPTY`                                                                                                                                                                                                                               |
| POST      | `…/empty`               | `{ includeVersions: boolean }`                                                                             | `Job` (202)                                                                                                                                                                                                                                               |
| GET · PUT | `…/access`              | `{ access: 'private'\|'public-read' }`                                                                     | `{ access, policy: object \| null }`                                                                                                                                                                                                                      |
| GET · PUT | `…/policy`              | `{ policy: object \| null }`                                                                               | `{ policy }`                                                                                                                                                                                                                                              |
| GET · PUT | `…/versioning`          | `{ status: 'enabled'\|'suspended' }`                                                                       | `{ status }`                                                                                                                                                                                                                                              |
| GET · PUT | `…/object-lock`         | `{ mode: 'GOVERNANCE'\|'COMPLIANCE'\|null, days: number\|null, years: number\|null }`                      | `{ enabled, mode, days, years }`                                                                                                                                                                                                                          |
| GET · PUT | `…/lifecycle`           | `{ rules: LifecycleRule[] }`                                                                               | `{ rules }`                                                                                                                                                                                                                                               |
| GET · PUT | `…/cors`                | `{ rules: CorsRule[] }`                                                                                    | `{ rules }`                                                                                                                                                                                                                                               |
| GET · PUT | `…/tags`                | `{ tags: Record<string,string> }`                                                                          | `{ tags }`                                                                                                                                                                                                                                                |
| GET · PUT | `…/replication`         | `{ rules: ReplicationRule[] }`                                                                             | `{ rules, status }`                                                                                                                                                                                                                                       |
| GET · PUT | `…/notifications`       | `{ targets: NotificationTarget[] }`                                                                        | `{ targets }`                                                                                                                                                                                                                                             |
| GET · PUT | `…/quota`               | `{ limitBytes: number \| null, mode, threshold }`                                                          | `{ quota: Quota \| null, usage: { sizeBytes, objects } }`                                                                                                                                                                                                 |

```ts
interface LifecycleRule {
  id: string;
  enabled: boolean;
  prefix: string;
  tags: Record<string, string>;
  expireDays: number | null;
  noncurrentExpireDays: number | null;
  abortMultipartDays: number | null;
  transition: { days: number; storageClass: string } | null;
  expiredDeleteMarkers: boolean;
}
interface CorsRule {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds: number | null;
}
interface ReplicationRule {
  id: string;
  enabled: boolean;
  prefix: string;
  destination: { bucketArn: string; storageClass: string | null };
  deleteMarkers: boolean;
  priority: number;
}
interface NotificationTarget {
  id: string;
  arn: string;
  kind: 'queue' | 'topic' | 'lambda';
  events: string[];
  prefix: string;
  suffix: string;
}
```

## Objects

All paths are prefixed `/servers/:sid/buckets/:bucket/objects`. `key` always travels in the query string (URL-encoded).

| Method    | Path               | Body / query                                                                                                                           | Response                                                                                                 |
| --------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GET       | ``                 | `?prefix&delimiter=/&cursor&limit=200&q&showVersions=false`                                                                            | `{ prefixes: [{ prefix }], objects: ObjectItem[], nextCursor: string \| null }`                          |
| GET       | `/meta`            | `?key&versionId`                                                                                                                       | `ObjectMeta`                                                                                             |
| GET       | `/download`        | `?key&versionId&inline=false`                                                                                                          | byte stream; honours `Range`, sets `Content-Disposition`                                                 |
| POST      | `/download-zip`    | `{ keys: string[], prefixes: string[] }`                                                                                               | `application/zip` stream                                                                                 |
| PUT       | `/upload`          | `?key&overwrite=true` raw body; headers `Content-Type`, `X-Sio-Meta-*`, `X-Sio-Tags`, `X-Sio-Storage-Class`                            | `ObjectItem` (409 `CONFLICT` if `overwrite=false` and the key exists)                                    |
| PUT       | `/content`         | `?key` text body (edit in place → new version)                                                                                         | `ObjectItem`                                                                                             |
| POST      | `/folder`          | `{ prefix }`                                                                                                                           | 201                                                                                                      |
| POST      | `/delete`          | `{ objects: [{ key, versionId? }], prefixes: string[], allVersions: boolean }`                                                         | `{ deleted: number, errors: [{ key, message }], job: Job \| null }` (prefixes and big sets become a job) |
| POST      | `/copy`            | `{ keys: string[], prefixes: string[], destServerId, destBucket, destPrefix, move: boolean, conflict: 'skip'\|'overwrite'\|'rename' }` | `{ copied, errors, job: Job \| null }`                                                                   |
| POST      | `/rename`          | `{ key, newKey }`                                                                                                                      | `ObjectItem`                                                                                             |
| GET       | `/versions`        | `?key`                                                                                                                                 | `{ items: ObjectVersion[] }`                                                                             |
| POST      | `/restore-version` | `{ key, versionId }`                                                                                                                   | `ObjectItem`                                                                                             |
| GET · PUT | `/tags`            | `?key&versionId` · `{ tags }`                                                                                                          | `{ tags }`                                                                                               |
| PUT       | `/metadata`        | `?key` `{ contentType, cacheControl, contentDisposition, metadata: Record<string,string> }`                                            | `ObjectMeta`                                                                                             |
| PUT       | `/retention`       | `?key&versionId` `{ mode: 'GOVERNANCE'\|'COMPLIANCE', until } \| { legalHold: boolean }`                                               | `ObjectMeta`                                                                                             |
| POST      | `/presign`         | `{ key, versionId?, expiresInSeconds /* 60..604800 */, download: boolean }`                                                            | `{ url, expiresAt }`                                                                                     |

```ts
interface ObjectItem {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
  storageClass: string | null;
  versionId: string | null;
  isLatest: boolean | null;
  deleteMarker: boolean;
}
interface ObjectMeta extends ObjectItem {
  contentType: string | null;
  cacheControl: string | null;
  contentDisposition: string | null;
  metadata: Record<string, string>;
  tags: Record<string, string>;
  retention: { mode; until } | null;
  legalHold: boolean | null;
  versionCount: number | null;
}
interface ObjectVersion {
  versionId: string;
  lastModified: string;
  size: number;
  isLatest: boolean;
  deleteMarker: boolean;
  etag: string | null;
}
```

## IAM: S3 users, groups, policies, access keys

Aggregated lists span every server whose driver supports them. Servers that failed come back in `unavailable: [{ serverId, message }]`.

| Method                | Path                                                | Body / query                                                                                                                         | Response                                                                                                       |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| GET                   | `/iam/users`                                        | `?serverId&q&status&page&pageSize`                                                                                                   | `{ items: S3User[], total, unavailable }`                                                                      |
| GET                   | `/iam/users/:userId`                                | —                                                                                                                                    | `S3UserDetail` — resolves the opaque id. 404 for an id that names nothing                                      |
| GET                   | `/iam/groups/:groupId`                              | —                                                                                                                                    | `S3Group`                                                                                                      |
| GET                   | `/iam/policies/:policyId`                           | —                                                                                                                                    | `PolicyDetail`                                                                                                 |
| GET                   | `/iam/access-keys/:keyId`                           | —                                                                                                                                    | `AccessKey`                                                                                                    |
| POST                  | `/iam/users/bulk`                                   | `{ users?: [{ serverId, name }], ids?: string[], action: 'enable'\|'disable'\|'delete'\|'attach-policy'\|'detach-policy', payload }` | `{ results: [{ id, serverId, name, ok, message }] }` — always 200; see below                                   |
| POST                  | `/iam/access-keys/bulk`                             | `{ keys?: [{ serverId, accessKeyId }], ids?: string[], action: 'enable'\|'disable'\|'delete' }`                                      | `{ results: [{ id, serverId, accessKeyId, ok, message }] }` — always 200                                       |
| POST                  | `/servers/:sid/iam/users`                           | `{ name, secret: string \| null /* minio */, policies: string[], groups: string[], createAccessKey: boolean }`                       | `{ user: S3User, accessKey: CreatedKey \| null }`                                                              |
| GET · PATCH · DELETE  | `/servers/:sid/iam/users/:name`                     | PATCH `{ status: 'enabled'\|'disabled' }`                                                                                            | `S3UserDetail` / 204                                                                                           |
| PUT                   | `/servers/:sid/iam/users/:name/policies`            | `{ policies: string[] }` (full set)                                                                                                  | `S3UserDetail`                                                                                                 |
| PUT                   | `/servers/:sid/iam/users/:name/groups`              | `{ groups: string[] }`                                                                                                               | `S3UserDetail`                                                                                                 |
| GET                   | `/iam/groups`                                       | `?serverId&q`                                                                                                                        | `{ items: S3Group[], total, unavailable }`                                                                     |
| POST · PATCH · DELETE | `/servers/:sid/iam/groups[/:name]`                  | `{ name, members: string[], policies: string[], status? }`                                                                           | `S3Group` / 204                                                                                                |
| GET                   | `/iam/policies`                                     | `?serverId&q`                                                                                                                        | `{ items: PolicySummary[], total, unavailable }`                                                               |
| GET · PUT · DELETE    | `/servers/:sid/iam/policies/:name`                  | PUT `{ document: object, description?: string }` (create or replace)                                                                 | `PolicyDetail` / 204 (built-ins are read-only → 409)                                                           |
| POST                  | `/iam/policies/validate`                            | `{ document }`                                                                                                                       | `{ valid, errors: [{ path, message }], warnings: string[] }`                                                   |
| POST                  | `/iam/policies/simulate`                            | `{ document, action, resource, context?: Record<string,string> }`                                                                    | `{ decision: 'allow'\|'deny'\|'implicit-deny', statementSid: string \| null, statementIndex: number \| null }` |
| GET                   | `/iam/access-keys`                                  | `?serverId&userName&status=active\|expiring\|disabled\|expired&q&page`                                                               | `{ items: AccessKey[], total, counts: { all, active, expiring, disabled }, unavailable }`                      |
| POST                  | `/servers/:sid/iam/access-keys`                     | `{ userName, name, expiresAt: string \| null, policy: object \| null }`                                                              | `CreatedKey` (201, the secret is shown once)                                                                   |
| PATCH · DELETE        | `/servers/:sid/iam/access-keys/:accessKeyId`        | `{ name?, status?, expiresAt? }`                                                                                                     | `AccessKey` / 204                                                                                              |
| POST                  | `/servers/:sid/iam/access-keys/:accessKeyId/rotate` | `{ graceSeconds: number /* 0 = disable now */, expiresAt: string \| null }`                                                          | `CreatedKey`                                                                                                   |

```ts
interface S3User {
  id: string; /* opaque, stable per (serverId, 'user', name) */
  serverId: string;
  serverName: string;
  provider: Provider;
  name: string;
  status: 'enabled' | 'disabled' | 'unknown';
  policies: string[];
  groups: string[];
  accessKeyCount: number;
  createdAt: string | null;
  lastActivityAt: string | null;
}
interface S3UserDetail extends S3User {
  accessKeys: AccessKey[];
  inheritedPolicies: [{ policy; fromGroup }];
}
interface S3Group {
  id: string;
  serverId;
  serverName;
  name;
  members: string[];
  policies: string[];
  status: 'enabled' | 'disabled';
}
interface PolicySummary {
  id: string;
  serverId;
  serverName;
  name;
  builtIn: boolean;
  description: string | null;
  attachedCount: number;
  updatedAt: string | null;
}
interface PolicyDetail extends PolicySummary {
  document: object;
  attachedTo: { users: string[]; groups: string[] };
}
interface AccessKey {
  id: string;
  serverId;
  serverName;
  provider;
  accessKeyId: string;
  userName: string;
  name: string | null;
  status: 'active' | 'disabled' | 'expired';
  restricted: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  rotation: { replacedBy: string; disableAt: string } | null;
}
interface CreatedKey {
  accessKey: AccessKey;
  secretAccessKey: string;
  endpoint: string;
  region: string;
}
```

## Quotas

| Method | Path      | Query                                          | Response                                                                                                                                                                                                       |
| ------ | --------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/quotas` | `?q&serverId&filter=all\|near\|unlimited&page` | `{ items: [{ bucket: Bucket, usageRatio: number \| null, trend: number[] /* 7 daily sizes */, supported: 'native'\|'alert-only'\|'unavailable' }], total, summary: { withQuota, over90, over80, unlimited } }` |

Quotas are set per bucket via `PUT …/quota`. When the driver has no native quota, the API stores an alert-only quota (`native: false`).

## Bulk jobs

```ts
type JobType =
  | 'copy'
  | 'move'
  | 'delete'
  | 'tag'
  | 'storage-class'
  | 'retention'
  | 'restore-versions'
  | 'empty-bucket';
type JobStatus =
  | 'queued'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';
interface JobFilters {
  prefix: string;
  modifiedAfter: string | null;
  modifiedBefore: string | null;
  minSize: number | null;
  maxSize: number | null;
  glob: string | null;
  tags: Record<string, string>;
}
interface Job {
  id;
  name;
  type: JobType;
  status: JobStatus;
  source: {
    serverId;
    serverName;
    bucket;
    filters: JobFilters;
    prefixes: string[];
    keyCount: number | null;
  };
  target: { serverId; serverName; bucket; prefix } | null;
  params: {
    tags?;
    storageClass?;
    retention?: { mode; days };
    includeVersions?: boolean;
  };
  options: {
    conflict: 'skip' | 'overwrite' | 'rename';
    concurrency: number /* 1..64 */;
    dryRun: boolean;
  };
  schedule:
    | { kind: 'now' }
    | { kind: 'at'; at: string }
    | {
        kind: 'cron';
        cron: string;
        timezone: string;
        enabled: boolean;
        nextRunAt: string | null;
      };
  progress: {
    total: number | null;
    processed: number;
    failed: number;
    skipped: number;
    bytes: number;
    objectsPerSec: number;
    bytesPerSec: number;
    etaSeconds: number | null;
  };
  createdAt;
  startedAt;
  finishedAt;
  waitingFor: string | null; /* e.g. "ceph-lab offline" */
  parentId: string | null; /* set on each run of a recurring job */
}
```

| Method               | Path                                      | Body / query                                                                                                                       | Response                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET                  | `/jobs`                                   | `?view=active\|scheduled\|history&page`                                                                                            | `{ items: Job[], total, counts: { active, scheduled, history } }`                                                                                                                                                        |
| POST                 | `/jobs`                                   | `{ name?, type, source: { serverId, bucket, filters, keys?: string[], prefixes?: string[] }, target?, params, options, schedule }` | `Job` (201) — `keys` (≤ 100 000) and `prefixes` (≤ 1 000) are an explicit selection from the object browser; they are stored server-side and come back as `source.keyCount` and `source.prefixes`, never as the key list |
| POST                 | `/jobs/estimate`                          | `{ source }`                                                                                                                       | `{ objects, bytes, partial: boolean }` (time-boxed listing)                                                                                                                                                              |
| GET · PATCH · DELETE | `/jobs/:id`                               | PATCH `{ enabled?, name? }`                                                                                                        | `Job` / 204                                                                                                                                                                                                              |
| POST                 | `/jobs/:id/{pause,resume,cancel,run-now}` | —                                                                                                                                  | `Job`                                                                                                                                                                                                                    |
| GET                  | `/jobs/:id/logs`                          | `?cursor&level=all\|error`                                                                                                         | `{ items: [{ at, level: 'info'\|'warn'\|'error', message, key: string\|null }], nextCursor }`                                                                                                                            |

## Activity, notifications, dashboard, search, settings, events

| Method      | Path                           | Body / query                                                                                                               | Response                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET         | `/activity`                    | `?q&from&to&serverId&category=objects\|buckets\|access\|servers\|jobs\|system\|auth&result=success\|failure\|warning&page` | `{ items: ActivityEvent[], total }`                                                                                                                                                                                                                                                                                                          |
| GET         | `/activity/:id`                | —                                                                                                                          | `ActivityEvent`                                                                                                                                                                                                                                                                                                                              |
| GET         | `/activity/export.csv`         | same filters                                                                                                               | `text/csv`                                                                                                                                                                                                                                                                                                                                   |
| GET         | `/notifications`               | `?unread=true`                                                                                                             | `{ items: [{ id, at, level: 'info'\|'warning'\|'error', title, detail, href: string\|null, read }], unread }`                                                                                                                                                                                                                                |
| POST        | `/notifications/read`          | `{ ids: string[] \| 'all' }`                                                                                               | 204                                                                                                                                                                                                                                                                                                                                          |
| GET         | `/dashboard`                   | —                                                                                                                          | `Dashboard` (see below)                                                                                                                                                                                                                                                                                                                      |
| GET         | `/search`                      | `?q&limit=20`                                                                                                              | `{ items: [{ type: 'server'\|'bucket'\|'user'\|'group'\|'key'\|'policy'\|'job', id, label, sublabel, href, status: JobStatus \| null }] }` — `id` is the entity's opaque id and `href` is a `docs/ROUTES.md` route built from it alone: never a name and never a query string. `status` is set on a `job` row and `null` on every other type |
| GET · PATCH | `/settings`                    | PATCH: partial `Settings`                                                                                                  | `Settings`                                                                                                                                                                                                                                                                                                                                   |
| POST        | `/settings/notifications/test` | `{ channel: 'email'\|'webhook' }`                                                                                          | `{ ok, detail }`                                                                                                                                                                                                                                                                                                                             |
| POST        | `/settings/export`             | `{ passphrase }`                                                                                                           | `application/octet-stream` (encrypted config)                                                                                                                                                                                                                                                                                                |
| POST        | `/settings/import`             | multipart `file` + `passphrase`                                                                                            | `{ servers: number, settings: boolean }`                                                                                                                                                                                                                                                                                                     |
| GET         | `/events`                      | SSE                                                                                                                        | `event: server.health\|server.created\|server.deleted\|job.progress\|job.status\|notification\|inventory.updated\|activity.created`, `data: JSON`                                                                                                                                                                                            |

```ts
interface ActivityEvent {
  id;
  at;
  category;
  action: string /* e.g. "object.delete" */;
  title: string;
  actor: { type: 'admin' | 'system' | 'token'; name: string };
  target: string | null;
  serverId: string | null;
  serverName: string | null;
  ip: string | null;
  result: 'success' | 'failure' | 'warning';
  requestId: string | null;
  details: object;
}
interface Dashboard {
  totals: {
    bucketsBytes; /* sum of every bucket's size, from the inventory cache */
    capacityBytes;
    objects;
    buckets;
    bucketsDelta7dBytes;
    objectsDeltaToday: number | null;
    users: number /* S3 users across servers, from the cache */;
    accessKeys: number;
    servers: { total; healthy; degraded; offline };
    nearQuotaBuckets: number;
  };
  growth: [{ t: string; bucketsBytes: number }]; /* 30 daily points */
  byServer: [
    { serverId; name; provider; usedBytes; totalBytes },
  ]; /* usedBytes = what the SERVER reports as used capacity */
  jobs: Job[] /* active, max 3 */;
  activity: ActivityEvent[] /* 6 */;
  expiringKeys: AccessKey[]; /* next 30 days */
  largestBuckets: Bucket[] /* 5 */;
  incidents: [{ serverId; serverName; status; detail; since }];
}
interface Settings {
  profile: { displayName; email: string | null };
  security: { sessionTtlHours: number; allowedNetworks: string[] };
  appearance: { density: 'comfortable' | 'compact' }; // per-browser prefs such as theme stay client-side
  region: {
    timezone: string;
    sizeUnits: 'decimal' | 'binary' /* default 'decimal' */;
    calendar: 'auto' | 'gregory' | 'persian' | 'islamic';
    digits: 'auto' | 'latn';
    weekStart: 'auto' | 0 | 1 | 6;
  };
  transfers: {
    parallel: number;
    partSizeMb: 8 | 16 | 64;
    bandwidthLimitMbps: number | null;
    verifyChecksums: boolean;
    keepIncompleteDays: number;
  };
  notifications: {
    email: {
      enabled;
      host;
      port;
      secure;
      username;
      password?: string /* write-only */;
      from;
      to: string[];
    };
    webhook: { enabled; url; secret?: string };
    rules: Record<
      | 'server.offline'
      | 'quota.threshold'
      | 'key.expiring'
      | 'job.failed'
      | 'auth.new-device',
      { inApp: boolean; email: boolean; webhook: boolean }
    >;
  };
  retention: { activityDays: number; metricsDays: number };
  health: { defaultIntervalSec: number; latencyWarnMs: number };
}
```

## Additions (every concept action is implemented; none are stubs)

| Method | Path                                                     | Body / query                                                                                                                                                                                          | Response                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/servers/:sid/buckets/:bucket/objects/import-url`       | `{ url, key, overwrite }` (the API fetches the URL server-side, streams it into the bucket, max size from settings)                                                                                   | `ObjectItem`                                                                                                                                                                                                                                                                                                                                                                                                      |
| PUT    | `/servers/:sid/buckets/:bucket/objects/storage-class`    | `?key` `{ storageClass }`                                                                                                                                                                             | `ObjectMeta`                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/buckets/bulk`                                          | `{ buckets: [{ serverId, bucket }], action: 'quota'\|'lifecycle-rule'\|'tags'\|'access'\|'delete', payload }`                                                                                         | `{ results: [{ id, serverId, bucket, ok, message }] }` — `id` is the bucket's opaque id, read before the action so a `delete` row still carries it, and `null` for a bucket that was never cached. — `delete` takes `payload: { force: boolean }` (`force` empties each bucket first); a bucket that is not empty comes back as `ok: false` with `BUCKET_NOT_EMPTY` in `message` while the rest are still deleted |
| POST   | `/servers/:id/rotate-credentials`                        | `{ mode: 'auto' } \| { mode: 'manual', accessKeyId, secretAccessKey }` (auto: create a new admin key through the IAM driver, verify it, swap the stored credentials, then disable/delete the old key) | `{ server: Server, rotatedAt }`                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/servers/:id/nodes/:node/drives`                        | —                                                                                                                                                                                                     | `{ items: [{ path, state, usedBytes, totalBytes, model: string\|null, healing: boolean }] }`                                                                                                                                                                                                                                                                                                                      |
| GET    | `/servers/:sid/iam/policies/:name/versions`              | —                                                                                                                                                                                                     | `{ items: [{ id, createdAt, document, note }] }` (the app DB snapshots every PUT made through storage-io)                                                                                                                                                                                                                                                                                                         |
| POST   | `/servers/:sid/iam/policies/:name/versions/:vid/restore` | —                                                                                                                                                                                                     | `PolicyDetail`                                                                                                                                                                                                                                                                                                                                                                                                    |
| GET    | `/iam/users/export.csv` · `/iam/access-keys/export.csv`  | list filters                                                                                                                                                                                          | `text/csv`                                                                                                                                                                                                                                                                                                                                                                                                        |
| PATCH  | `/jobs/:id`                                              | `{ enabled?, name?, concurrency?, schedule? }` (live concurrency change for running jobs; schedule edit for scheduled ones)                                                                           | `Job`                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/:id/duplicate`                                    | `{ asSchedule?: { cron, timezone } }`                                                                                                                                                                 | `Job`                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/jobs/:id/runs`                                         | `?page`                                                                                                                                                                                               | `{ items: Job[], total }` (each run of a recurring job is a child `Job` with `parentId`)                                                                                                                                                                                                                                                                                                                          |
| GET    | `/servers/:sid/buckets/:bucket/notifications/status`     | —                                                                                                                                                                                                     | `{ items: [{ targetId, arn, state: 'online'\|'offline'\|'unknown', detail }] }` (MinIO target status via admin API; other providers return `unknown`)                                                                                                                                                                                                                                                             |

Contract additions: `Job.parentId: string | null`. Settings gains `notifications.telegram: { enabled, botToken?: string /* write-only */, chatId }` (with rule flags per channel), `activity.syslog: { enabled, host, port, protocol: 'udp'|'tcp'|'tls', format: 'rfc5424'|'json', facility }` and `transfers.importUrlMaxMb`. `POST /settings/notifications/test` accepts `channel: 'email'|'webhook'|'telegram'|'syslog'`. Admin credentials come from env, so there is no password-change endpoint; the Settings page shows them as "Managed by environment".

CSV exports (added): `GET /buckets/export.csv` and `GET /quotas/export.csv` accept the same filters as their list endpoints and return `text/csv`. `POST /settings/export` and `POST /settings/import` are owned by backend wave 2c.

## Objects: batch, resumable upload and archive preview (added)

All paths are prefixed `/servers/:sid/buckets/:bucket/objects`.

| Method | Path                                     | Body / query                                                                                            | Response                                                                                                                                                                                                                                                                                                                  |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/batch`                                 | `{ keys: string[] /* 1..1000 */, action: 'tags'\|'storage-class'\|'retention'\|'legal-hold', payload }` | `{ updated: number, errors: [{ key, message }] }` — one metadata-only action applied in the request; `payload` is discriminated by `action` (`{ tags }`, `{ storageClass }`, `{ mode, until }`, `{ legalHold }`). A larger selection goes through `/jobs`. 409 `NOT_SUPPORTED` when the provider lacks the feature at all |
| GET    | `/archive-entries`                       | `?key&versionId&limit=500`                                                                              | `{ format: 'zip'\|'tar'\|'unsupported', entries: [{ path, size, compressedSize: number\|null, modified: string\|null, dir }], truncated }` — ZIP is read from its central directory with ranged GETs; tar is stream-scanned up to a byte budget. An object that is not an archive answers `unsupported`, not an error     |
| POST   | `/multipart`                             | `{ key, contentType: string\|null, metadata, tags, storageClass: string\|null }`                        | `{ uploadId, key, partSizeBytes }` (201). `partSizeBytes` comes from `Settings.transfers.partSizeMb`, never below S3's 5 MiB minimum                                                                                                                                                                                      |
| PUT    | `/multipart/:uploadId/parts/:partNumber` | `?key`, raw body stream, `Content-Length` **required**                                                  | `{ partNumber, etag, size }`. Part numbers are 1..10000; every part but the last must be at least `partSizeBytes`                                                                                                                                                                                                         |
| GET    | `/multipart/:uploadId`                   | `?key`                                                                                                  | `{ parts: [{ partNumber, etag, size }] }` — what the server already holds, so a client resumes instead of restarting                                                                                                                                                                                                      |
| POST   | `/multipart/:uploadId/complete`          | `?key` `{ parts: [{ partNumber, etag }] }`                                                              | `ObjectItem`. Parts may be sent in any order; the API sorts them, because S3 rejects a non-ascending list                                                                                                                                                                                                                 |
| DELETE | `/multipart/:uploadId`                   | `?key`                                                                                                  | 204 — aborts and discards the parts                                                                                                                                                                                                                                                                                       |

Contract additions: `Settings.transfers.retries: number /* 0..10, default 4 */` — attempts per part before a transfer gives up.

## Implementation notes (backend wave 2a)

Behaviour a caller can observe that the tables above do not spell out:

- `DELETE …/buckets/:bucket?force=true` empties the bucket **in the request**, in batches of 1000, and answers 204 only once it is gone. Above 100 000 objects it answers 409 `BUCKET_NOT_EMPTY` and names `POST …/empty`, which is the job-backed path with no size limit. A force delete that answered 204 while work continued in the background would tell the operator the bucket was gone when it was not.
- The 409 for a non-empty bucket is enforced by the API, not left to the provider: SeaweedFS deletes a non-empty bucket and its contents without complaint.
- `POST …/objects/delete` and `POST …/objects/copy` return a `Job` instead of a count when the request names a prefix, or more than 5 000 objects to delete / 200 to copy. `deleted`/`copied` are then `0`.
- `POST …/objects/copy` maps each source key to `destPrefix` + the key's last segment. A whole folder is expressed as a `prefixes` entry, which becomes a job. Every entry in `prefixes` is carried into that job (`JobSource.prefixes`), not just the first, and `POST …/objects/delete` does the same.
- `PUT …/buckets/:bucket/object-lock` answers 409 `NOT_SUPPORTED` unless the bucket already has object lock; S3 only accepts it at creation. On a lock-enabled bucket it edits the default retention.
- A `hard` quota is pushed to the provider where the driver has a native one (MinIO today) and the response says `native: true`. Where it is not native, the API refuses an upload that would exceed the limit using the cached size. An `alert` quota is never pushed to the provider.
- `GET …/notifications/status` reports `unknown` for every target outside MinIO, and for a MinIO target its admin API does not list.
- `POST …/objects/batch` applies its keys sequentially: it runs while an operator waits, and a thousand parallel requests at one bucket is how the console becomes the reason the storage server is slow.
- A part upload is not written to the activity log — a large upload is thousands of them. The start, the completion and the abort are.
- `GET …/objects/archive-entries` never downloads a whole object. A ZIP costs two or three ranged reads whatever its size; a tar has no index, so it is read from the start and reports `truncated` once its budget is spent.

## Implementation notes (backend wave 2c)

Behaviour a caller can observe that the tables above do not spell out.

### Traffic metrics (contract change)

- `GET /servers/:id/metrics` gained `traffic`. It is an **array of per-second
  rates** derived from the provider's cumulative counters, sampled with the health
  check and stored in `metrics_traffic`.
- `traffic: null` means "this server has no traffic data": the provider has no
  metrics endpoint (capability `traffic: 'not_supported'`), or it has never been
  sampled. An **empty array** means "it has data, none in this range" — the
  difference matters, because an empty series draws as a flat line at zero requests
  per second and `null` draws as "not available".
- Only MinIO reports it today, from `/minio/v2/metrics/cluster`, authenticated with
  the same JWT `mc admin prometheus generate` produces (HS512 over the secret key;
  claims `exp`, `sub`, `iss: "prometheus"`). The new `traffic` capability is
  `supported` when the admin surface answered, `not_configured` when it did not, and
  `not_supported` for every other provider.
- The first sample of a series, and any sample where a counter went backwards (the
  storage server restarted), is stored with null rates and is absent from the
  series. So a restart costs one point, not a spike.

### Jobs

- **Views.** `active` is `queued|running|paused`, `scheduled` is `scheduled`,
  `history` is the four terminal statuses. `counts` always describes all three
  whatever `?view=` asked for.
- **A cron schedule never runs itself.** It stays `scheduled` and produces a child
  `Job` per fire, with `parentId` set; `GET /jobs/:id/runs` is that history. An `at`
  schedule _is_ the run: it goes `scheduled → queued` when its time comes.
- **A missed schedule fires once**, not once per missed interval, and `nextRunAt` is
  recomputed from now. A schedule whose previous run has not finished is skipped
  with a line in the parent's log.
- **`POST /jobs/:id/run-now`**: on a schedule it creates and returns a child run and
  leaves `nextRunAt` alone; on a finished job it resets that row (counters,
  checkpoint and **log** cleared) back to `queued`; on a paused job it resumes.
- **`DELETE /jobs/:id` answers 409 `CONFLICT` while the job is running.** Cancel it
  first — deleting the row from under the engine is the alternative.
- **`concurrency` changes live.** A PATCH takes effect on the running job's next
  page. Raising it applies as soon as a worker frees up; lowering it does not
  interrupt transfers already in flight.
- **`progress.total`** is the estimate taken when the run starts, and is `null` when
  the time-boxed listing did not finish — a progress bar against a number known to
  be too small is worse than no bar. `objectsPerSec`, `bytesPerSec` and `etaSeconds`
  are averaged over a 15-second window and are zero/null once the job ends.
- **`waitingFor`** carries `"<server> offline"` for a queued job whose source or
  target is unreachable or in maintenance; the engine starts it by itself once the
  health checker sees the server again. A server that goes offline mid-run puts the
  job back to `queued` with the same text rather than failing it.
- **Resume is exact to one page.** Progress and the listing's continuation token are
  written together at the end of each page, so a restart or a pause replays at most
  one page. A job the process died inside is requeued at boot.
- **A dry run reports what the filters matched** — `processed` and `bytes` — and
  changes nothing. It deliberately does not probe the destination for conflicts, so
  `skipped` is 0 on a dry run even where a real run would skip.
- **`empty-bucket` and `restore-versions` always walk versions**, whatever
  `params.includeVersions` says: deleting only current versions leaves a versioned
  bucket full, and a delete marker is the only thing a restore acts on.
  `restore-versions` removes the current delete marker of each key and skips
  everything else.
- **A `tag` job merges** its tags onto each object's existing set rather than
  replacing it.
- **Per-object failures are counted, not raised.** `completed` means nothing failed;
  `completed_with_errors` means some did; `failed` means none succeeded. The first
  200 failures are in the job log with their keys, after which they are counted only.
- **`JobSource.keyCount`** is how many explicitly selected keys a job works on (a
  job started from a selection in the object browser), or `null` for a filter-defined
  job. The keys themselves are **not** in the contract: a selection can be thousands
  of keys and would then appear in every page of `GET /jobs`.
- **`JobSource.prefixes`** is every prefix that selection contained — all of them,
  not the first. It is separate from `filters.prefix` because the two are different
  things: `filters.prefix` is the single prefix a filter-defined job narrows its
  listing to (it is pushed to the storage server as the listing's `Prefix`), while a
  selection has as many prefixes as the operator ticked. A job with a non-empty
  `prefixes` works the **union** of its `keyCount` keys and every one of those
  prefixes, with overlaps removed — a prefix inside another prefix, or a key inside
  a selected prefix, is counted once. `prefixes` is `[]` for a filter-defined job,
  and `filters.prefix` is `""` for a selection-defined one.
- **`GET /jobs/:id/logs`** pages by `cursor`, which is opaque and monotonic — not an
  offset, so lines arriving while an operator reads are never shown twice.

### Notifications and syslog

- **`email`, `webhook` and `telegram` are real transports now.** Delivery is
  best-effort and never retried: the in-app row is always written, and a channel
  that is misconfigured shows up in `POST /settings/notifications/test` rather than
  in a silent retry queue.
- **Webhook requests are signed** when a secret is set:
  `x-storage-io-signature: hex(HMAC-SHA256(secret, "<timestamp>.<body>"))` with the
  same timestamp in `x-storage-io-timestamp` and the event name in
  `x-storage-io-event`. Signing the timestamp with the body is what makes a captured
  request unreplayable. Without a secret the request is sent unsigned and the header
  is absent. The body is `{ event, data }`; `event` is `notification` or `test`.
- **Repeated alerts are deduplicated**, not rate-limited per channel: an alert
  carries a fingerprint (rule key plus the thing it is about) and the same
  fingerprint is silent for 15 minutes. The next one that gets through says how many
  repeats were folded into it, so nothing is dropped without a trace.
- **Activity is forwarded to syslog** when `Settings.activity.syslog.enabled` is on —
  every row, RFC 5424 or JSON, over UDP, TCP or TLS, newline-framed on the two stream
  transports. The local trail is written first and is authoritative; a collector that
  is down never fails the request that produced the line.

### Dashboard and search

- **`GET /dashboard` never contacts a storage server.** Every figure is local: the
  bucket cache, the daily size samples, the metrics tables, the activity trail,
  `key_meta`, the jobs table and the cached IAM counts. It is therefore fast and a
  few minutes stale, which is the right trade for a headline — and it still answers
  during the outage an operator opened it to look at.
- `growth` is as long as there are samples, not padded to 30 points.
  `totals.objectsDeltaToday` is `null` until there are two days of samples.
  `totals.capacityBytes` is `null` when no server reports a capacity.
- `incidents[].since` is when the server last transitioned into its current
  unhealthy state, from the health-event log — not the last check time.
- **`GET /search` runs on two speeds.** Servers, buckets and jobs are local queries.
  Users, keys and policies are live against every capable server and share a
  **1.5-second budget**: whatever answers in time is included, whatever does not is
  simply absent from that keystroke's results. An unreachable server never turns a
  search into an error.
- Results are grouped by type in a fixed order (server, bucket, user, key, policy,
  job), not interleaved by relevance, so a palette can be read by shape.

### Configuration export and import

- `POST /settings/export` returns `application/octet-stream`, `Cache-Control:
no-store`, filename `storage-io-<date>.sioconf`. It contains **every settings
  section including its secrets and every server connection including its secret
  access key and admin token** — that is what makes it a restore.
- The envelope is `magic(7) ‖ version(1) ‖ salt(32) ‖ nonce(12) ‖ AES-256-GCM
ciphertext ‖ tag(16)`; the key is `scrypt(passphrase, salt, N=2^15, r=8, p=1)` and
  the magic and version are authenticated as AAD. The passphrase, not `APP_SECRET`,
  is the key — an archive has to be readable on the machine it is restored onto.
- `POST /settings/import` is a multipart form (`file` + `passphrase`). Settings are
  **replaced** section by section, not merged. Servers are matched **by name**: an
  existing name is updated in place (keeping its id, and therefore its buckets,
  quotas, metrics and job history), a new one is inserted, and nothing is ever
  deleted. No connection test is run — the imported rows start `unknown` and the
  health checker settles them within one interval.
- A wrong passphrase, a truncated file or a payload that no longer validates all
  answer 400 `VALIDATION` with a sentence. A wrong passphrase and a tampered file are
  reported identically, because AES-GCM cannot tell them apart either.

### Serving the web app

- With `WEB_DIST` set (the Dockerfile sets `/app/public`) the API serves the built
  app with an SPA fallback for every path outside `/api` and `/health`, so a deep
  link like `/buckets/photos` loads the client router instead of 404ing.
- Vite's fingerprinted assets are `public, max-age=31536000, immutable`;
  `index.html` is `no-cache` (still revalidated by ETag, so an unchanged deploy
  answers 304). An unknown `/api` path is still a problem+json 404, never HTML.

## Implementation notes (opaque ids, resolve endpoints and bulk IAM)

Behaviour a caller can observe that the tables above do not spell out.

### Ids

- **A bucket's id lives on its `bucket_cache` row**, so it exists as soon as the
  bucket has been seen once — by the inventory sweep, or by the request that
  created it — and it is written on insert and never on update. Repeated lists,
  a refresh and a restart all return the same id.
- **A user's, group's, policy's and access key's id lives in `iam_entities`**, a
  registry rather than a mirror: one row per `(serverId, kind, name)`, holding an
  id and two timestamps and nothing else about the entity. A row is written the
  first time storage-io lists or returns the entity and is never rewritten.
- **An id is released only when its row is.** Deleting a bucket drops its cache
  row, so a bucket deleted and created again under the same name gets a **new
  id** — it is not the bucket the link pointed at. An IAM entity's registry row
  outlives the entity, so a user deleted and recreated keeps its id; deleting the
  **server** cascades every one of its rows away.
- **A resolve endpoint answers 404 for an id it never issued**, and for an id of
  the wrong kind — a group id handed to `/iam/users/:userId` is a 404, not a
  cross-type read.
- `GET /buckets/:bucketId` reads the bucket from its server, exactly as
  `GET /servers/:sid/buckets/:bucket` does. When the server cannot be reached it
  answers from the cache with `unavailable: true` rather than a 502; a bucket the
  server no longer has is still a 404.
- **Route order.** `/buckets/export.csv`, `/buckets/bulk`,
  `/iam/users/export.csv`, `/iam/access-keys/export.csv`, `/iam/users/bulk`,
  `/iam/access-keys/bulk`, `/iam/policies/validate` and `/iam/policies/simulate`
  are all declared above their parameter siblings, so a literal segment is never
  read as an id. E2E tests assert each one still answers.

### Bulk IAM

- Both endpoints **always answer 200** with one row per target, in the order
  `ids` first then the reference list. A partial failure is rows, never a 4xx.
- A target may be addressed by `(serverId, name)` or by opaque `id`; **exactly
  one of the two lists must be non-empty**, and a request with neither is 400
  `VALIDATION`. At most 500 targets per request.
- An `ids` entry the registry never issued comes back as
  `{ id, serverId: null, name: null, ok: false, message: 'NOT_FOUND: …' }` —
  the only case where `serverId` and `name` are null.
- `message` on a failed row is `"<CODE>: <sentence>"`, mapped the same way the
  problem+json envelope maps it. No provider body, stack or path crosses the
  boundary.
- `attach-policy` and `detach-policy` require `payload: { policy }`; the other
  three actions take no payload. The set is applied by reading the user's current
  policies and writing the full set back, because `PUT …/policies` is a full set.
- Rows are applied **sequentially**, not in parallel: each one is a call to a
  storage server's admin API, and five hundred at once is how the console becomes
  the reason that server is slow.

### Jobs from an explicit selection

- `POST /jobs` accepts `source.keys` (≤ 100 000) and `source.prefixes` (≤ 1 000).
  They are stored server-side in the job row's `params`, exactly where
  `POST …/objects/delete` and `…/copy` put a selection, so the engine has one way
  to read one. Empty strings are dropped: a `""` prefix is every object in the
  bucket, which is not what ticking nothing means.
- They come back as `source.keyCount` and `source.prefixes`. **The key list never
  comes back** — a selection can be thousands of keys and would then appear in
  every page of `GET /jobs`.
- A job with a selection works the **union** of its keys and prefixes with
  overlaps removed, as documented under "Jobs" above.

### `activity.created`

- Emitted whenever an audit row is recorded — by the interceptor on a mutating
  request, or directly by a system event.
- **Bursts are throttled**: the first row goes out at once and everything
  recorded in the next second is folded into a single trailing frame carrying the
  **newest** row and `suppressed`, the count of the ones it stands in for. A bulk
  action over five hundred users is one leading frame and one trailing frame, not
  five hundred. The trailing frame always arrives, so the list is never left
  stale.
- Like every frame on this stream it is a hint about which query to invalidate;
  `GET /activity` is the authoritative answer.

### `server.created` and `server.deleted`

- Carry `{ serverId, serverName, at }` rather than the whole `Server`: a
  `deleted` frame has no row left to describe, and a client refetches anyway.
- `server.deleted` is published **after** the row is gone, so a client that
  refetches on the frame cannot race the delete and see the server come back.

### `Dashboard.totals.bucketsBytes` (contract change)

- Renamed from `usedBytes`, and `usedDelta7dBytes` to `bucketsDelta7dBytes`,
  because `byServer[].usedBytes` is a **different measurement** and the two do
  not have to agree. `totals.bucketsBytes` is the sum of every bucket's size from
  the inventory cache — the operator's data. `byServer[].usedBytes` is what the
  storage server reports as its own used capacity, which includes replication,
  erasure-coding overhead, noncurrent versions and anything on the server that
  storage-io did not put there. `growth[].usedBytes` is renamed to
  `bucketsBytes` for the same reason: it is the daily series of that same total.
