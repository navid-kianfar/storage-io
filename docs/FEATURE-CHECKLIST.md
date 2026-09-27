# Feature checklist — everything in the concept is real

The concept stubbed these actions with a "not part of the concept" toast. **All of them must work in the real app.** Tick them off in the final verification pass.

## Removed by decision
- Two-factor authentication: the login OTP step, 2FA settings, recovery codes and the setup's "create admin" step. The admin comes from env. The first-run wizard (`/welcome`) goes: connect storage → verify → preferences → done.

## Objects (object browser)
- [ ] Rename (F2) · Copy to… / Move to… (any server/bucket/prefix, with a conflict policy) · Edit metadata · Edit tags · Change storage class · Set retention / legal hold
- [ ] Run selection as bulk job… (pre-fills the New job wizard)
- [ ] Import from URL · Upload files / Upload folder (folder structure preserved) · New folder
- [ ] Preview (image/video/audio/pdf/text/json/markdown/archive listing) · Edit contents (CodeMirror, saves a new version) · Download · ZIP download of a selection · Share link (presign, expiry, force download) · Versions (restore, download, delete marker) · Delete (with the versioning-aware dialog)
- [ ] Bucket settings menu entries: Properties, Access policy, Quota, Versioning, Lifecycle rules, Replication, Event notifications, CORS, Delete bucket

## Buckets
- [ ] Create (server, name validation, versioning, object lock, quota, access) · Delete (typed confirm, empty first) · Empty bucket (job)
- [ ] Row menu: Browse, Settings, Copy S3 URI, Edit quota, Access policy, Empty, Delete
- [ ] Bulk: Set quota, Apply lifecycle rule, Edit tags, Delete · Columns menu · Export CSV
- [ ] Bucket settings page, every section editable: General + tags, Access policy (presets + JSON editor + validate), Quota, Versioning & lock, Lifecycle (add/edit/delete rule dialog), Replication (add/edit rule), Events (add/edit destination, delivery status), CORS, Danger zone

## Servers
- [ ] Add (3-step wizard with live checks) · Edit connection · Test · Check all · Maintenance mode · Rotate admin credentials (auto/manual) · Remove (typed confirm)
- [ ] Server detail: Overview (KPIs, nodes & drives + Drive details, health, traffic), Buckets, Users & keys (New S3 user), Connection, Capabilities

## Access
- [ ] S3 users: create, edit, enable/disable, delete, attach/detach policies, groups, create/rotate/change expiry/delete keys from the user sheet, export list, reset filters
- [ ] Groups: create, edit, add members, delete
- [ ] Policies: new (templates), visual editor (add/edit/duplicate/remove/move statement), JSON editor, validate, simulate, import JSON, download JSON, duplicate, delete, version history + restore, attached-to list
- [ ] Access keys: create (+ one-time secret with .env/AWS CLI/rclone/mc snippets, download CSV), rotate with grace period, edit name & expiry, disable, delete, expiring-soon banner

## Storage operations
- [ ] Quotas: list, filters, edit quota dialog (hard / alert-only), export CSV
- [ ] Bulk jobs: new job wizard (all 7 types, filters, estimate, conflict policy, concurrency, dry run, now/at/cron), pause/resume/cancel, change concurrency, view log, run again, duplicate, save as schedule, edit/delete schedule, run history
- [ ] Transfers: queue with pause/resume/retry/cancel, open location, clear completed, pause all, bandwidth limit, settings (parallel, part size, retries, checksum, resume) + reset to defaults, throughput chart

## System
- [ ] Activity: filters incl. custom date range and filter-by-actor, event sheet with raw JSON, export CSV, forward to syslog (settings)
- [ ] Notifications: in-app popover (mark all read), channels email/webhook/Telegram (connect + test), event rules matrix
- [ ] Settings: profile, sessions (revoke, sign out others), CLI tokens (create/revoke), session timeout, allowed networks, appearance (theme, density, reduce motion, click behaviour), language & region, transfers, notifications, backup (export/import config), retention, about/check for updates
- [ ] Command palette: navigation, every create action (bucket, key, S3 user, bulk job, share link, add server, upload), live search, preferences
- [ ] Dashboard: all cards live, quick actions working, incident banner retry
