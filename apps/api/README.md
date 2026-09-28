# @storage-io/api

NestJS REST API + SSE for storage-io. SQLite via Drizzle, provider drivers per
storage backend, a single admin from the environment.

Read first: `docs/ARCHITECTURE.md` (decisions), `docs/API.md` (the contract) and
`CONTRIBUTING.md` (workflow and conventions). `packages/contracts` is the single
source of truth for every request and response shape; no DTO in this app restates
a field.

---

## Running it

```bash
# once, from the repo root
pnpm install
pnpm --filter @storage-io/contracts build     # the API compiles against dist/

cd apps/api
cp .env.example .env                          # then edit ADMIN_PASSWORD + APP_SECRET
pnpm dev                                      # nest start --watch, on :3000
```

- API base path `http://localhost:3000/api/v1`
- `GET /health` is outside the prefix and public
- Swagger UI at `http://localhost:3000/api/docs` (dev and test only)

From the repo root, `pnpm dev` builds the contracts and then runs every app in
`apps/` in parallel.

### The dev storage servers

```bash
docker compose -f docker/docker-compose.dev.yml up -d
```

MinIO on `:9000` and SeaweedFS on `:8333`; endpoints and the fixed dev
credentials are documented at the top of that file. Add them through
`POST /api/v1/servers` or the web UI.

> **Image note.** `docker.io/minio/minio` is no longer anonymously pullable, so
> the compose file pins Broadcom's legacy Bitnami image, which packages the
> upstream MinIO binary (`DEVELOPMENT.2025-05-24T17-08-30Z`) with the Admin API
> v3 intact. Swap the `image:` line if the official one becomes reachable again.

### Tests

```bash
pnpm test         # unit + e2e, and the container specs skip themselves
pnpm test:unit    # pure logic, no app
pnpm test:e2e     # the real Nest app over supertest, in-memory SQLite
pnpm test:it      # against the MinIO/SeaweedFS containers (sets S3_IT=1)
pnpm typecheck
pnpm lint
```

`test/it/**` needs the containers up. Without `S3_IT=1` those specs skip, so
`pnpm test` is green on a machine with no Docker. `test/it/migration.it.spec.ts`
needs no container and always runs.

### The database

SQLite at `DATABASE_PATH` (default `./data/storage-io.sqlite`), WAL mode, foreign
keys on. Migrations in `./drizzle` are applied at boot by `src/db/migrate.ts`.

**A schema change is a migration, never a hand-edit:**

```bash
# 1. edit src/db/schema.ts
pnpm db:generate            # writes drizzle/NNNN_*.sql
pnpm db:check               # sanity-check the journal
# 2. commit the generated SQL with the schema change
# 3. run the API against an EXISTING database and confirm the upgrade
```

The fresh-create path and the upgrade path are the same code — `applyMigrations`
— so they cannot drift. `test/it/migration.it.spec.ts` asserts that a migrated
database and a fresh one end up with an identical schema.

**Driver:** `better-sqlite3@13`. It was chosen over `@libsql/client` after
checking that it works on the local Node 25.2.1 (`NODE_MODULE_VERSION 141`): the
npm package ships `prebuilds/darwin-arm64.node` and friends, so it needs no
`node-gyp` and no compiler. It is deliberately **not** in the root
`pnpm.onlyBuiltDependencies` list — approving its install script makes pnpm run
`node-gyp rebuild`, which fails because node-gyp is not installed and is not
needed.

---

## Environment

`.env.example` documents every variable. The three that matter:

| Variable                                      | Notes                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADMIN_USERNAME`                              | The only account. No sign-up, no password change, no 2FA.                                                                                                                |
| `ADMIN_PASSWORD` **or** `ADMIN_PASSWORD_HASH` | Exactly one. The hash is an argon2id PHC string; `.env.example` has the one-liner that generates it.                                                                     |
| `APP_SECRET`                                  | ≥ 32 chars. HKDF input for the AES-256-GCM key that encrypts server secrets. **Changing it makes every stored secret unreadable** and every server has to be re-entered. |

Validation happens once, at boot, in `src/config/env.schema.ts`. A bad
environment prints the list of problems and exits 1 — never a stack trace.

---

## Module map

```
src/
  main.ts                bootstrap + the env-error exit path
  bootstrap.ts           createApp(): helmet, compression, cookies, prefix, Swagger,
                         shutdown hooks. The e2e suite uses this exact function.
  app.module.ts          the global guards/pipe/interceptor/filter, in order
  logging.ts             pino options, including the redaction list
  version.ts             APP_VERSION, reported by /health

  config/                zod-validated env → AppConfigService (@Global)
  db/                    schema.ts, migrate.ts, DbModule (@Global; DB + SQLITE_CLIENT tokens)
  crypto/                CryptoService: HKDF, AES-256-GCM, token hashing, argon2id (@Global)
  settings/              the Settings document, one row per section, cached (@Global)
  events/                EventBusService + GET /events (SSE) (@Global)
  activity/              the audit trail: service, global interceptor, list/detail/CSV (@Global)
  notifications/         in-app notifications, dedup, and the real channel drivers
                         (SMTP, signed webhook, Telegram, syslog) (@Global)
  auth/                  login/logout/me, sessions, API tokens
  providers/             the provider framework — see below
  servers/               /servers endpoints, repository, health checker, traffic sampler
  maintenance/           the hourly retention sweep
  web/                   WebStaticModule: serves the built app from WEB_DIST (prod only)
  health/                GET /health and /api/v1/health (public)

  modules/               wave 2 feature modules, imported by app.module in this order
    storage/             StorageContextService: ":sid" -> row + connection + S3 client
                         + capability map. Every storage operation starts here.
    inventory/           the bucket cache and the sweep that fills it. No controllers;
                         buckets and quotas read it, and it emits inventory.updated.
    jobs/                the bulk-job engine behind JOBS_PORT: /jobs, the runner,
                         the cron scheduler, checkpointing and the job log
    quotas/              GET /quotas (+ export.csv), the quota table, threshold watcher
    objects/             the object browser's endpoints, streaming throughout
    buckets/             /buckets, /buckets/bulk and every per-bucket setting
    dashboard/           GET /dashboard — aggregates the tables above, never a server
    search/              GET /search — local tables plus a budgeted live IAM fan-out
    config-backup/       POST /settings/{export,import}: the encrypted config archive

  common/
    actor.ts             who made the request, and @CurrentActor()
    csv.ts               RFC 4180 writing, with the spreadsheet-formula guard
    dto.ts               dtoFrom(schema) — a Nest DTO from a contract schema
    request-id.ts        the x-request-id middleware
    decorators/          @Public(), @SkipOriginCheck()
    errors/              DomainException hierarchy + the provider error mapper
    filters/             the problem+json exception filter
    guards/              AuthGuard, OriginGuard
    middleware/          AllowedNetworksMiddleware
    net/cidr.ts          IPv4/IPv6 CIDR matching
```

### Request pipeline, in order

1. **`requestIdMiddleware`** — stamps `x-request-id`, echoed on the response and
   carried into the log line and the activity row.
2. **`AllowedNetworksMiddleware`** — `Settings.security.allowedNetworks`. Runs as
   middleware, not a guard, so it also covers SSE and the streaming object
   endpoints that never reach a handler.
3. **`ThrottlerGuard`** — the API-wide bucket, plus the login bucket on the login
   route.
4. **`AuthGuard`** — session cookie `sio_session` or `Authorization: Bearer sio_…`.
   **Everything is protected unless marked `@Public()`.**
5. **`OriginGuard`** — CSRF defence for cookie mutations. Runs after auth because
   it needs to know _how_ the request authenticated; a Bearer token is exempt,
   because a browser never attaches one by itself.
6. **`ZodValidationPipe`** (nestjs-zod) — validates against the contract schemas.
7. **`ActivityInterceptor`** — records every mutating request, success **and**
   failure.
8. **`ProblemExceptionFilter`** — one `application/problem+json` envelope for the
   whole API.

---

## How to add a feature module

Take buckets as the worked example.

1. **Schemas already exist.** `packages/contracts` covers all of `docs/API.md`,
   including the Additions section. Import from `@storage-io/contracts`; do not
   redeclare a shape. If the contract is genuinely wrong, change `docs/API.md`
   and the zod schema together.

2. **`src/buckets/buckets.module.ts`** — import `ProvidersModule` and
   `ServersModule`. Everything else (config, db, crypto, settings, events,
   activity, notifications) is `@Global()` and already available.

3. **DTOs** — one file, `buckets.dto.ts`:

   ```ts
   import { createBucketRequestSchema } from '@storage-io/contracts';
   import { dtoFrom } from '../common/dto';

   export class CreateBucketDto extends dtoFrom(createBucketRequestSchema) {}
   ```

4. **The service is the business layer.** Controllers validate, delegate and map
   — nothing else. Get a `ServerConnection` through
   `ServerRepository.toConnection(row)`; that is the only place a secret is
   decrypted.

5. **Controller** — thin, with `@ApiTags` / `@ApiOperation`, and `@LogActivity`
   on every mutating route:

   ```ts
   @Post()
   @LogActivity({ category: 'buckets', action: 'bucket.create', title: 'Created a bucket' })
   async create(@Param('sid') sid: string, @Body() body: CreateBucketDto): Promise<Bucket> { … }
   ```

   Route order matters: literal segments before `:id`, or Express matches the
   literal as a parameter. `/servers/test` sits above `/servers/:id` for exactly
   this reason.

6. **Errors** — throw from `common/errors/domain.exception.ts`
   (`NotFoundError`, `ConflictError`, `NotSupportedError`, `BucketNotEmptyError`,
   …). An AWS SDK error you do not catch is mapped automatically by
   `provider-error.mapper.ts`, so you rarely need to translate one yourself.

7. **Register it** in `AppModule`'s `imports`.

8. **Tests** — a `test/e2e/buckets.spec.ts` using `createTestApp()`, plus
   `test/it/buckets.it.spec.ts` behind `IT_ENABLED` for the real containers.

---

## How to add a provider driver

`src/providers` exists so a provider's quirks stay in one file.

1. **Capability profile** — add an entry to
   `provider-profiles.ts`. `not_configured` means "the provider can do this, but
   this server has not been given the endpoint or token it needs";
   `not_supported` is a permanent no. The UI shows them differently.

2. **The driver** — extend `S3GenericDriver`, which already handles the S3 client
   and the three capabilities that can be probed over S3:

   ```ts
   @Injectable()
   export class CephDriver extends S3GenericDriver {
     readonly iam: IamSubDriver;
     readonly quota: QuotaSubDriver;

     constructor(clients: S3ClientFactory, probes: S3ProbeService, private readonly admin: CephAdminClient) {
       super('ceph', clients, probes);
       this.iam = { kind: 'ceph-admin', ping: …, listUsers: … };
       this.quota = { getBucketQuota: …, setBucketQuota: … };
     }

     override async detectCapabilities(connection, context) { … }
     async additionalChecks(connection) { … }   // adds a row to the connection test
     async serverInfo(connection) { … }         // version, nodes, capacity
   }
   ```

   Sub-drivers are **optional**. Leaving one out and reporting the capability as
   `not_supported` is better than a stub that throws: `ProviderRegistryService`
   raises a consistent `NOT_SUPPORTED` for a missing sub-driver.

3. **Register it** in `ProviderRegistryService.buildDrivers()`. Providers with no
   admin API need nothing — the loop gives them `S3GenericDriver` with their own
   profile.

4. **`detectCapabilities` must not throw.** A probe that fails leaves the
   capability at its profile value. Use `keepBetter` semantics: a probe may
   confirm or deny, never weaken a known `supported` to a maybe.

5. **Nothing from a provider is passed through unmapped.** MinIO's
   `/minio/admin/v3/info` includes `minio_env_vars`, which contains
   `MINIO_ROOT_PASSWORD` — the driver maps only the fields it needs, and an
   integration test asserts none of it leaks.

### The storage modules (wave 2a)

- **The bucket list is served from a cache, never live.** `GET /buckets` spans every
  server; asking each one per page load would let the slowest server set the
  latency and would drop an offline server's buckets from the list entirely.
  `InventoryRefresherService` sweeps on an interval (`INVENTORY_REFRESHER_ENABLED`),
  and anything the API itself writes is written to the cache in the same request so
  the list never lags the operator's own action.
- **Sizes come from a native usage API where there is one** (MinIO's
  `datausageinfo`, one call for every bucket), otherwise from a listing scan with a
  per-server page budget and a round-robin cursor. A bucket larger than the budget
  keeps `sizeBytes: null` — the contract's "unknown" — rather than a number that is
  wrong.
- **An object's bytes are never served as the provider typed them.** The store
  holds whatever was uploaded and the console is same-origin, so a `text/html`
  object returned as `text/html` is stored XSS against the console's own session.
  `object-stream.service.ts` renders only inert types inline — the six raster
  image types, `application/pdf`, `video/*`, `audio/*`, and any `text/*` forced to
  `text/plain; charset=utf-8` — and hands everything else back as
  `application/octet-stream` with an `attachment` disposition whatever
  `?inline=true` asked for. `nosniff` and a `default-src 'none'; … sandbox` policy
  go on every response that carries object bytes, including the ZIP.
- **ZIP entry names are sanitised, not copied.** An object key is not a path: S3
  stores `../../etc/x` happily and several extractors still resolve entry names
  against the destination directory. `zipEntryName` drops `.`/`..` segments and
  leading slashes and normalises backslashes; a key that leaves nothing behind is
  skipped and logged rather than renamed.
- **Nothing buffers a body.** Uploads go through `@aws-sdk/lib-storage`'s `Upload`
  with the operator's part size and concurrency; downloads pass `Range` through and
  pipe the provider's own stream; ZIPs are appended as their `GetObject` bodies
  arrive. `bootstrap.ts` excludes `…/objects/upload` and `…/objects/content` from
  **both** body parsers (see `modules/objects/raw-upload.ts`) — either one would
  otherwise read an upload into memory and hand the handler an empty stream.
- **Work that cannot finish in a request becomes a job**, through `JOBS_PORT`. Only
  `enqueue` exists today: the row is written in `queued` and wave 2c's engine picks
  it up. Explicit object keys travel in the stored `params` JSON under `_keys`,
  outside the contract shape.
- **A browser that has to survive a dropped connection drives the multipart upload
  itself** (`modules/objects/multipart.service.ts`). Nothing about the session is
  stored here — S3 is the record, through `ListParts` — so a resume works after an
  API restart as well as after a lost connection. `…/objects/upload` remains the
  right call when an upload either finishes or is retried from the start.
- **The archive preview never downloads the object.** A ZIP has an index, so
  `archive-reader.service.ts` finds its end-of-central-directory record in a ranged
  read of the tail and then reads the directory itself: a 40 GB ZIP costs a few
  hundred kilobytes. A tar has no index, so it is scanned from the start under a byte
  budget and reports `truncated`.
- **Provider quirks are recorded where they bite**, with the version they were
  verified against: MinIO drops `AbortIncompleteMultipartUpload` from a lifecycle
  rule it accepted; MinIO has no per-bucket CORS; SeaweedFS's `ListObjectsV2`
  doubles the first path segment on a versioned bucket (worked around in
  `ObjectsService`); SeaweedFS deletes a non-empty bucket without complaint, and
  accepts an object-lock retention it does not enforce.

### Opaque ids

`docs/ROUTES.md` is binding: a web route param is an id, never a name. Two
registries make that possible, and both are lazy — an id is minted the first time
storage-io sees the entity, by whichever listing sees it first.

- **`bucket_cache.id`** is written on insert and never on update, so the
  refresher's own upsert cannot change it. `InventoryRepository.locate(id)` is
  what `GET /buckets/:bucketId` resolves with.
- **`iam_entities`** is a registry, not a mirror: `(server_id, kind, name)` →
  `id`, for `user`, `group`, `policy` and `key` (a key's name is its access key
  id). `IamEntityRepository.idsFor` is one insert plus one select per chunk, so a
  list of five hundred users costs two statements rather than five hundred. The
  insert's `onConflictDoUpdate` touches only `last_seen_at` — leaving `id` out of
  the `set` is what makes the id stable.
- An entity that is **deleted and created again** keeps its id (the registry row
  outlives it); a **bucket** does not (its cache row is the id). A deleted
  _server_ cascades both away. `test/it/opaque-ids.it.spec.ts` pins all three
  across a real close-and-reopen of the database.
- Anything that builds a link — `GET /search`, every `notifications.raise` — uses
  these ids. A name in an `href` is a bug; there is an e2e assertion for it.

### The IAM drivers

All four exist (backend wave 2b), in `src/providers/iam/`:

| Driver         | Providers              | Users                  | Groups          | Policies                 | Keys                                             | Verified against               |
| -------------- | ---------------------- | ---------------------- | --------------- | ------------------------ | ------------------------------------------------ | ------------------------------ |
| `minio-admin`  | MinIO                  | yes                    | yes             | canned                   | service accounts, native expiry + session policy | the dev container              |
| `aws-iam`      | AWS, Wasabi, SeaweedFS | yes                    | AWS/Wasabi only | managed, AWS/Wasabi only | yes, expiry app-tracked                          | SeaweedFS in the dev container |
| `ceph-admin`   | Ceph RGW               | yes                    | no              | no                       | yes, no status                                   | fixture test only              |
| `garage-admin` | Garage                 | keys **are** the users | no              | no                       | yes, no status                                   | fixture test only              |

`IamCapableS3Driver` is what carries them: S3 core plus one IAM sub-driver, and one
`ping` that decides whether the IAM capabilities are `supported` or
`not_configured` on this server. It never promotes a `not_supported` from the
capability profile — a reachable endpoint does not give SeaweedFS groups.

Ceph and Garage have no container in `docker/docker-compose.dev.yml`, so their
coverage is `test/unit/{ceph,garage}-iam.spec.ts`: a real `node:http` fixture that
asserts the request line, the SigV4 or bearer header and the response mapping. The
paths themselves are **unverified against a live cluster** and each driver's header
comment says which API version they came from.

### MinIO's Admin API

`minio/minio-admin.client.ts` is the transport: SigV4 with service `s3`, a real
`x-amz-content-sha256`, and transparent madmin envelope handling. It uses
`node:http`/`node:https` rather than `fetch` so the per-server `tlsVerify` and
`caPem` settings apply through a real agent.

`minio/madmin-crypto.ts` implements madmin `EncryptData`/`DecryptData`. The
framing is documented nowhere, so it was written from `minio/madmin-go`'s
`encrypt.go` and `secure-io/sio-go`, and the header comment records it:

```
salt (32) | algorithm id (1) | nonce (8) | sio stream of 16 KiB chunks
```

with `argon2id(secretKey, salt, t=1, m=64 MiB, p=4, len=32)`, a per-chunk nonce
of `nonce ‖ LE32(counter)` where **the counter starts at 1**, and 17 bytes of
associated data — a flag byte (`0x00`, `0x80` on the last chunk) followed by the
tag of an empty plaintext sealed under counter 0. Both AES-256-GCM (id `0x00`)
and ChaCha20-Poly1305 (id `0x01`) are handled, because MinIO picks by CPU.

It is verified against a live MinIO in both directions
(`test/it/madmin.it.spec.ts`): decrypting the `list-users` response MinIO
produced, and encrypting an `add-user` body MinIO accepts.

---

## Notification channels

`notifications/delivery/notification-channel.ts` defines
`NotificationChannelDriver`; `delivery/channels.ts` implements all four and
`NotificationsModule` binds them through `NOTIFICATION_CHANNELS`. To add a
transport, add a class there — nothing outside `delivery/` changes.

- **email** — SMTP through nodemailer, a transport per delivery (settings can
  change between two notifications, and a pool keyed on them buys nothing at a few
  messages an hour). `secure` is the operator's choice because it is not
  inferable: 465 is implicit TLS, 587 is STARTTLS.
- **webhook** — a JSON POST signed
  `HMAC-SHA256(secret, "<timestamp>.<body>")` in `x-storage-io-signature`, with the
  timestamp in `x-storage-io-timestamp`. Signing the timestamp _with_ the body is
  what makes a captured request unreplayable. No secret means no header, and the
  request still goes.
- **telegram** — Bot API `sendMessage`, deliberately plain text: a bucket name with
  an underscore breaks Markdown parsing and Telegram answers 400.
- **syslog** — carries _activity_, not notifications, so the fan-out skips it;
  `ActivitySyslogService` is what writes to it and this driver exists so
  `POST /settings/notifications/test` can exercise the collector.

`deliver` must **not** throw, and none of them do: the callers are the health
checker and the job engine, and a dead SMTP host must not fail the thing that
noticed the problem. Nothing is retried either — a notification is news, not a
task, and the in-app row is always written.

**Repeated alerts are deduplicated by fingerprint.** `raise({ fingerprint })`
keeps the same alert quiet for 15 minutes (`notification_dedup`), and the next one
that gets through reports how many repeats were folded into it, so nothing is
dropped silently. Alerts that are new every time — a job finishing, a key created —
pass no fingerprint.

---

## Things worth knowing before you change them

- **The login throttler is confined by `skipIf`, not by the decorator.** In
  `@nestjs/throttler` v6 every configured throttler applies to every route;
  `@Throttle({ login: {} })` only overrides that bucket's options. Without the
  `skipIf` in `auth/login-throttler.ts`, a login limit of 10/min rate-limits the
  whole API after ten requests. An e2e test covers it.
- **`request.path` is unreliable in middleware.** Nest mounts middleware on a
  wildcard and Express strips the mount path, so `request.path` is `/` there. Use
  `request.originalUrl`. This is why `/health` briefly was _not_ exempt from the
  allowed-networks check.
- **Locking yourself out of `allowedNetworks` is possible and immediate.** The
  API does not refuse a list that excludes the caller — an operator may be
  configuring for a different network on purpose. `/health` stays reachable; the
  way back is to clear the `security` row in SQLite and restart (the settings
  cache is process-local).
- **Compression is disabled for `/events`.** A compressed SSE stream is buffered
  until the window fills, so events arrive in bursts or not at all.
- **`Settings` secrets are write-only *and* encrypted at rest.**
  `email.password`, `webhook.secret` and `telegram.botToken` are accepted on
  PATCH, stripped from every response by `stripWriteOnly`, and stored as
  `CryptoService` envelopes — the settings row is as readable as any other table
  to anyone holding the SQLite file. `getInternal()` decrypts them; a value that
  will not decrypt is returned as it stands, because a database written before
  this rule holds plaintext and must keep working until the bootstrap pass
  rewrites it. That pass (`SettingsService.onApplicationBootstrap`) is idempotent
  and costs one read on every boot after the first. Add a new secret to
  `SECRET_FIELDS` — one list drives both rules.
- **`trust proxy` is off unless `TRUST_PROXY` says otherwise.** `X-Forwarded-For`
  is a request header, so any client can send one; Express only believes it when
  the app has been told a proxy is in front. With the setting off — the default —
  `request.ip` is the socket's peer and a forged header changes nothing, which is
  what `AllowedNetworksMiddleware`, the login throttler and the activity trail all
  depend on. Behind a reverse proxy set `TRUST_PROXY=1` (one hop) or a
  comma-separated list of the proxies' addresses or CIDRs. `true` is rejected by
  the env schema on purpose: it means "believe anybody".
- **Activity `details` is sanitized centrally** in `sanitizeDetails`. Add a key to
  `REDACTED_KEYS` rather than filtering at a call site.
- **The health checker is one interval that asks which servers are due**, not a
  timer per server, so an edit to `healthIntervalSec` takes effect on the next
  tick with no bookkeeping.

### The job engine (wave 2c)

- **A page is the unit of work, and the checkpoint sits on the page being worked,
  not the one after it.** `jobs.checkpoint` is
  `{ segment, token, cursor }`: which stretch of the plan the run is on, the token
  that stretch's *current* page was listed with, and how many of that page's
  entries are done. A pause or a shutdown in the middle of a page keeps the page's
  own token and records the cursor, so the resume re-lists that page and skips
  exactly what was finished. Storing the page's `nextToken` instead — which is what
  this did — lost the rest of the page on every early stop. The cursor is a count
  rather than a key set because `runWithPool` starts items in order and waits for
  everything it started, so what is complete is always a run from the front. A
  checkpoint written in the old bare-token format still parses, as segment 0 at
  the start of that page.
- **A job works the union of its explicit keys and *every* selected prefix.**
  `planSegments` turns `_keys` and `_prefixes` into an ordered plan and removes the
  overlaps up front — a prefix inside another prefix, a key inside a selected
  prefix — so nothing is done twice and the run needs no set of seen keys to
  survive a pause. A job with neither is its filter's single listing, which is what
  `POST /jobs` creates. `JobSource.filters.prefix` and `JobSource.prefixes` are
  different things and the contract says so.
- **`onApplicationBootstrap` requeues anything the database still calls `running`.**
  Nothing is running at boot, so every such row is a job the process died inside; it
  goes back to `queued` with its checkpoint intact.
- **A queued job whose server is offline is left queued with `waitingFor`**, and the
  tick retries — so it starts by itself when the health checker sees the server
  come back. The queue scan is deliberately wider than the number of run slots, or
  two such jobs at the head would block every other job in the installation.
- **A cron schedule never runs itself**: it stays `scheduled` and spawns a child run
  per fire (`parentId`), which is what makes `GET /jobs/:id/runs` a history. An
  `at` schedule _is_ the run. A missed schedule fires **once**, not once per missed
  interval, and `nextRunAt` re-bases from now.
- **`JOB_ENGINE_ENABLED=false` in tests**, and `JobEngineService.drain()` is the
  same pass without that guard — that is how a spec drives a run deterministically.
  A background tick would claim a row in the middle of an assertion about it.
- **The S3 verbs a job uses live in `job-actions.service.ts`, not in
  `modules/objects`.** Objects already imports this module for `JOBS_PORT`, so
  reaching back would be a cycle; one duplicated `CopyObjectCommand` is cheaper
  than a circular module graph.

### Traffic metrics

- Sampled **with the health check** (`TrafficSamplerService`), not on a timer of its
  own: the check already decides which servers are due, already holds a decrypted
  connection and already skips maintenance.
- The **previous sample is read from the database**, not held in memory, so a
  restart costs one point instead of the whole series.
- **MinIO caches its cluster metrics for about ten seconds** (verified against
  DEVELOPMENT.2025-05-24T17-08-30Z), so the series is meaningful over the health
  interval and would be noise at one-second sampling.
- `traffic: null` in `GET /servers/:id/metrics` means "no data for this server";
  `[]` means "data exists, none in this range". An empty array would draw as a flat
  line at zero requests per second, which is a different and false claim.

### Serving the web app

- `WEB_DIST` set (the Dockerfile sets `/app/public`) turns on `WebStaticModule`,
  which must be **last** in `AppModule`: its SPA fallback answers every GET no
  controller claimed. `/api{/*path}` and `/health{/*path}` are excluded by hand, so
  an unknown API route is still problem+json and a probe is never handed HTML.
- Vite's fingerprinted assets are immutable for a year; `index.html` is `no-cache`,
  because it is the document that names those fingerprints and a cached copy after a
  deploy points at files that no longer exist.
