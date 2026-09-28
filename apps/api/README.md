# @storage-io/api

NestJS REST API + SSE for storage-io. SQLite via Drizzle, provider drivers per
storage backend, a single admin from the environment.

Read first: `docs/ARCHITECTURE.md` (decisions), `docs/API.md` (the contract) and
`docs/BUILD-RULES.md` (workspace etiquette). `packages/contracts` is the single
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
  notifications/         in-app notifications + the channel driver interface (@Global)
  auth/                  login/logout/me, sessions, API tokens
  providers/             the provider framework — see below
  servers/               /servers endpoints, repository, health checker
  maintenance/           the hourly retention sweep
  health/                GET /health (public)

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

### Still to write

`aws-iam`, `ceph-admin` and `garage-admin` (and SeaweedFS's IAM-compatible API).
Those providers currently run on `S3GenericDriver`, which is why their profiles
report the admin-only capabilities as `not_configured`.

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
`NotificationChannelDriver` and ships an `UnimplementedChannel` per channel, so
the routing, the settings matrix and `POST /settings/notifications/test` all work
today and report "not implemented yet".

To add a real transport, replace one entry in `defaultChannels()`. `deliver` must
**not** throw: the callers are the health checker and the job engine, and a dead
SMTP host must not fail the thing that noticed the problem.

`syslog` is in the list but carries activity, not notifications, so the fan-out
skips it; `Settings.activity.syslog` is its configuration.

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
- **`Settings` secrets are write-only.** `email.password`, `webhook.secret` and
  `telegram.botToken` are accepted on PATCH and stripped from every response by
  `stripWriteOnly`. Add a new secret to `WRITE_ONLY_FIELDS` in the same commit.
- **`trust proxy` is 1.** On-premise installs sit behind one reverse proxy.
  `request.ip` is therefore the client, and a client cannot forge it by adding
  its own `X-Forwarded-For` entry.
- **Activity `details` is sanitized centrally** in `sanitizeDetails`. Add a key to
  `REDACTED_KEYS` rather than filtering at a call site.
- **The health checker is one interval that asks which servers are due**, not a
  timer per server, so an edit to `healthIntervalSec` takes effect on the next
  tick with no bookkeeping.
