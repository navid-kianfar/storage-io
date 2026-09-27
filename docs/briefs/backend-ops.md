# Backend wave 2c — jobs engine, notifications delivery, dashboard, search, settings extras

Read: docs/BUILD-RULES.md, docs/ARCHITECTURE.md, docs/API.md (incl. Additions), docs/FEATURE-CHECKLIST.md, apps/api/README.md.

Scope (`apps/api/src/modules/{jobs,notifications,dashboard,search,settings,retention,syslog,config-backup}`):
- Jobs engine: all JobTypes (copy, move, delete, tag, storage-class, retention, restore-versions, empty-bucket), filters (prefix, modified before/after, size range, glob via contracts matcher, tag match — fetch tags only when a tag filter is set), estimate (time-boxed listing), options (conflict skip/overwrite/rename, concurrency 1..64 adjustable live, dry run), schedule now/at/cron (timezone aware, enable/disable, next run), child runs for recurring jobs (parentId), checkpointing (continuation token + counters persisted every N objects) and resume after restart, pause/resume/cancel, waitingFor when a server is offline (auto-resume on health recovery), per-job logs with levels, throughput + ETA, SSE `job.progress` (throttled ~1/s) and `job.status`, activity + notifications on completion/failure. Implement/replace the `JobsService.enqueue()` port if wave 2a created one. Endpoints: everything under "Bulk jobs" + duplicate, runs, PATCH.
- Notifications delivery: rules matrix from settings → in-app rows + email (nodemailer SMTP), webhook (JSON POST with HMAC-SHA256 signature header), Telegram (Bot API sendMessage); test endpoint for each channel incl. syslog. Dedup/rate-limit repeated alerts.
- Activity syslog forwarding (RFC 5424 or JSON over UDP/TCP/TLS) when enabled.
- Dashboard `/dashboard` aggregation per docs/API.md (growth from snapshots, byServer, incidents, jobs, activity, expiring keys, largest buckets).
- Search `/search`: servers, buckets (cache), users/keys/policies (cache or live with timeout), jobs.
- Settings extras: export/import encrypted config (passphrase → scrypt → AES-256-GCM; includes servers with secrets and settings), retention pruning cron (activity/metrics/job logs).
- Tests: unit tests for scheduler/cron next-run, filters, conflict handling, notification formatting/signing; e2e: create copy job between MinIO and SeaweedFS buckets with a few hundred objects, pause/resume/cancel, restart-resume (simulate by re-instantiating the engine), dry run counts, delete job with versions, scheduled cron job creates child run.

Report: short; what you ran and results; any contract changes.

Also (deployment): in production serve the built web app from `WEB_DIST` (env, set by the Dockerfile to /app/public) with SPA fallback for every non-`/api` path (`@nestjs/serve-static`), long cache headers for hashed assets and no-cache for index.html. Make `docker build .` (root Dockerfile, uses `pnpm deploy`) succeed and the container start, log in and serve the UI; fix the Dockerfile if needed. `docker-compose.yml` at the root is the production example.
