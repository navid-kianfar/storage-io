# storage-io — architecture

On-premise web console for many S3-compatible storage servers (MinIO, SeaweedFS, AWS S3, Ceph RGW, Garage, Cloudflare R2, Wasabi, generic S3). A single administrator manages servers, buckets, objects, S3/IAM users, policies, access keys, quotas, bulk jobs and transfers.

The UI follows the "Refined" direction: zinc neutrals, a single indigo accent and Geist type, in light and dark themes with full RTL support.

## Monorepo (pnpm workspaces)

```
apps/api            NestJS REST API + SSE, SQLite, provider drivers, job engine
apps/web            React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui
packages/contracts  zod v4 schemas + inferred types for every request/response (shared by api and web)
docker/             docker-compose.dev.yml with MinIO + SeaweedFS for local dev and integration tests
Dockerfile          single production image: api serves the built web app
```

Node ≥ 22 (local dev runs on 25). pnpm 10+. Scripts at the root: `pnpm dev` (api + web in parallel), `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm typecheck`.

## Authentication

- A single admin whose credentials come from the environment: `ADMIN_USERNAME`, plus either `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH` (argon2id). There is no sign-up, no password change in the UI and no 2FA.
- `POST /auth/login` compares with a constant-time check and creates an opaque session token (random 32 bytes). The DB stores only its SHA-256 hash. The token goes in an `httpOnly`, `SameSite=Strict` cookie (`Secure` when `COOKIE_SECURE=true`). This design allows a sessions list and revocation.
- Personal API tokens (Bearer `sio_…`) for CLI/automation are stored hashed, with a prefix shown in the UI.
- Login is rate-limited (throttler). All routes are guarded by default; `@Public()` opts out. Mutating requests from a cookie session must pass an `Origin` check.
- An optional allowed-networks CIDR list (settings) is enforced by middleware.

## Storage server credentials

Server secrets (S3 secret key, admin tokens) are encrypted at rest with AES-256-GCM. The key is derived via HKDF from `APP_SECRET` (env, required, ≥ 32 chars). Secrets never leave the API: responses only return masked values.

## Provider drivers (apps/api/src/providers)

A `ProviderDriver` per server exposes a `capabilities` set and composes three parts:

1. **S3 core** (all providers): the AWS SDK v3 `S3Client` (path-style option, custom CA, TLS-verify toggle). It covers buckets, objects, versioning, object lock, lifecycle, CORS, policy, tagging, replication, notifications, presign, multipart upload (`@aws-sdk/lib-storage`) and copy.
2. **IAM driver**:
   - `minio-admin`: the MinIO Admin API v3, SigV4-signed. Payloads use madmin `EncryptData`/`DecryptData`: argon2id → AES-256-GCM or ChaCha20-Poly1305 in the sio stream format. It covers users, groups, canned policies, service accounts (access keys with expiry and session policy), bucket quota, data-usage info and server info (nodes/drives).
   - `aws-iam`: `@aws-sdk/client-iam` with a configurable IAM endpoint. Used for AWS, SeaweedFS (its IAM-compatible API) and Wasabi. Covers users, groups, managed/inline policies and access keys.
   - `ceph-admin`: the RGW Admin Ops API (SigV4-signed REST `/admin/...`). Covers users, keys, user/bucket quotas and bucket stats.
   - `garage-admin`: the Garage Admin API (Bearer admin token). Covers keys, bucket quotas and bucket info.
   - `none`: R2 and generic S3 (bucket/object features only).
3. **Usage**: native stats where the provider has them (MinIO data-usage, Ceph bucket stats, Garage bucket info). Otherwise a throttled background inventory scan whose result is cached.

Features the provider lacks are reported as capabilities, so the UI can show "Not supported" or "Alert only" (for example, quotas on AWS S3 become app-level alert thresholds).

## Background work (in-process, persisted in SQLite)

- **Health checker**: every server on its interval (default 30 s) records latency, status (`healthy`/`degraded`/`offline`/`maintenance`), capability probe results and capacity snapshots (hourly) for the charts.
- **Inventory refresher**: caches the bucket list and stats per server, so aggregated lists are fast and offline servers still show their last known state.
- **Job engine**: runs bulk jobs (copy, move, delete, tag, storage class, retention, restore versions, empty bucket) with a concurrency limit, pause/resume/cancel, a progress checkpoint (continuation token) persisted so jobs resume after a restart, and a per-job log. Scheduled and recurring (cron) jobs use `@nestjs/schedule` dynamic cron.
- **Key expiry**: disables app-tracked expired keys and finishes rotation grace periods.
- **Quota watcher**: raises notifications when usage crosses thresholds.
- **Retention**: prunes the activity log and metrics per settings.
- **Live updates**: an SSE stream (`GET /api/v1/events`) pushes `server.health`, `job.progress`, `notification` and `inventory.updated` events. The web app invalidates its TanStack Query caches on them.

## Activity log

An interceptor records every mutating request (actor, action, target, server, IP, result, request id and sanitized details). System events (health changes, job lifecycle, quota thresholds) are recorded explicitly. The log can be filtered and exported to CSV.

## Web app

- Routing: TanStack Router (code-based route tree). Data: TanStack Query. Forms: react-hook-form + zod (schemas from `@storage-io/contracts`).
- UI: shadcn/ui components, themed with the concept's tokens (same CSS variable names). lucide-react icons, sonner toasts, cmdk command palette, Recharts via shadcn chart, CodeMirror 6 for JSON/text editing.
- i18n: i18next + react-i18next with keyed messages. English is complete; `tr`, `fa` and `ar` locale files exist and fall back to English. `fa`/`ar` set `dir="rtl"` and load their fonts. Styling uses logical utilities only (`ms-*`, `ps-*`, `start-*` …). Numbers, bytes and dates use `Intl`.
- Theme: light, dark and system, stored in localStorage and applied before first paint.
- Transfers: the browser-side transfer manager (XHR upload progress, concurrency, retry, pause) runs over the API's streaming upload/download endpoints.

## Conventions

- API prefix `/api/v1`. Errors are RFC 7807 `application/problem+json`: `{ type, title, status, detail, code, errors? }`.
- List endpoints use `page`/`pageSize` and return `{ items, total }`. Object listing uses an opaque `cursor`.
- Validation uses zod via `nestjs-zod` DTOs generated from `@storage-io/contracts`. OpenAPI is served at `/api/docs` in development.
- Structured logging uses pino (`nestjs-pino`), with request ids and secrets redacted.
- Tests: Vitest for both apps. The API has unit tests plus e2e tests (supertest) against an in-memory SQLite, and integration tests against the MinIO/SeaweedFS containers when `S3_IT=1`. The web app uses Vitest + Testing Library.
