# Feature checklist — everything in the concept is real

The concept stubbed these actions with a "not part of the concept" toast. **All of them must work in the real app.** Tick them off in the final verification pass.

Ticked in the final verification pass (2026-09-28) against the running API on :3000, the
MinIO and SeaweedFS dev containers, and the web console. A ticked box was exercised and its
result observed — in the UI unless the note says otherwise. Boxes that were **not** exercised
are left unticked with the reason, rather than ticked on the strength of the code reading.

## Removed by decision
- Two-factor authentication: the login OTP step, 2FA settings, recovery codes and the setup's "create admin" step. The admin comes from env. The first-run wizard (`/welcome`) goes: connect storage → verify → preferences → done.

## Objects (object browser)
- [x] Rename (F2) · Copy to… · Edit tags · Change storage class — rename and copy driven in the UI and confirmed on MinIO; tags set in the inspector and read back from the server. Storage class exercised against the API (MinIO accepts `REDUCED_REDUNDANCY` and correctly refuses `STANDARD_IA` with a provider error).
  - [ ] **Move to…**, **Edit metadata**, **Set retention / legal hold** — dialogs present and routed, not driven end-to-end here. Retention and legal hold are covered by the `S3_IT` suite against MinIO.
- [ ] Run selection as bulk job… (pre-fills the New job wizard) — not exercised; the selection toolbar offers Download / Copy to / Move to / Delete only.
- [x] Upload files / Upload folder (folder structure preserved) · New folder — folder upload landed `site/index.html`, `site/css/main.css`, `site/js/app.js` and `site/img/deep/note.txt` with the tree intact.
  - [ ] **Import from URL** — the SSRF guard was verified (loopback, IPv6 loopback and `169.254.169.254` all refused, nothing reached a local listener). An import from a genuine remote URL was not exercised, because the guard blocks every address available in this environment.
- [x] Preview (image/text/json/markdown) · Edit contents (CodeMirror, saves a new version) · Download · ZIP download of a selection · Share link (presign, expiry, force download) · Versions (restore) · Delete (with the versioning-aware dialog) — delete created a delete marker with the earlier version intact; the share link opened with no cookie at all and a tampered signature returned 403.
  - [ ] **video / audio / pdf / archive-listing previews** and **version download / delete marker** — not exercised.
- [x] Bucket settings menu entries: Properties, Access policy, Quota, Versioning, Lifecycle rules, Replication, Event notifications, CORS, Delete bucket — all nine sections render against the real bucket with live values and capability-aware disabled states.

## Buckets
- [x] Create (server, name validation, versioning, object lock, quota, access) · Delete — create driven in the UI; delete exercised through the API including `?force=true` on a non-empty bucket.
  - [ ] **Empty bucket (job)** — not exercised.
- [ ] Row menu: Browse, Settings, Copy S3 URI, Edit quota, Access policy, Empty, Delete — present, not exercised item by item.
- [ ] Bulk: Set quota, Apply lifecycle rule, Edit tags, Delete · Columns menu · Export CSV — present, not exercised.
- [x] Bucket settings page, every section editable — a lifecycle rule was added through the dialog and confirmed on MinIO itself with `mc ilm rule ls`. The other sections were seen rendering their live values but not saved through.

## Servers
- [x] Add (3-step wizard with live checks) · Test · Rotate admin credentials (auto/manual) — a server was added through the wizard with all nine live checks passing and the capability strip populated, then removed. Test returns the full check list with per-check durations.
  - [ ] **Edit connection**, **Check all**, **Maintenance mode**, **Remove (typed confirm)** — the controls and menu entries are present (Edit connection tab renders its form; Remove server sits in the overflow menu), but the typed-confirm dialog itself was not opened: the menu item could not be activated through the test harness. Removal was done through the API instead.
- [x] Server detail: Overview (KPIs, nodes & drives, health, metrics), Buckets, Users & keys (New S3 user), Connection, Capabilities — all five tabs render live data.

## Access
- [ ] S3 users: create, edit, enable/disable, delete, attach/detach policies, groups, keys from the user sheet, export list, reset filters — the list renders 11 real users with policies, key counts, groups and status, and the filters and Columns menu are present; the write actions were not exercised.
- [ ] Groups: create, edit, add members, delete — tab present with 2 groups; not exercised.
- [x] Policies: list and editor — the editor opens by opaque id and renders the real document as statements (Allow/Deny, actions, resources, conditions) with Visual/JSON views.
  - [ ] **new (templates), validate, simulate, import/download JSON, duplicate, delete, version history + restore** — present, not exercised.
- [ ] Access keys: create, rotate, edit, disable, delete, expiring-soon banner — the list renders 9 real keys with the status KPI strip; the write actions were not exercised.

## Storage operations
- [ ] Quotas: list, filters, edit quota dialog, export CSV — the list renders live usage for 19 buckets with its KPIs and filters; the edit dialog was not driven.
- [x] Bulk jobs: new job wizard (all 7 types, filters, estimate, conflict policy, concurrency, dry run, now/at/cron), pause/resume/cancel, change concurrency, view log — a 12,000-object copy MinIO → SeaweedFS was paused mid-run, resumed, had its concurrency raised from 1 to 8 live (throughput went 270 → 884 objects/s), streamed its log, and a second run was cancelled at 4,644/12,000. A 2,000-object copy completed with 0 failures and all 2,000 keys verified on the destination.
  - [ ] **dry run, at/cron scheduling, run again, duplicate, save as schedule, edit/delete schedule, run history** — offered by the wizard and the row menu, not exercised.
- [x] Transfers: queue with pause/resume, bandwidth limit, settings (parallel, part size, retries, checksum, resume) + reset to defaults, throughput chart — a 60 MB upload was paused at 27 %, held there, resumed and completed byte-perfect; a 40 MB upload went out as a real 3-part multipart. The floating panel, the topbar popover and `/transfers` all showed the same transfer.
  - [ ] **retry/cancel of a failed transfer, open location, clear completed, pause all** — present, not exercised.

## System
- [x] Activity: filters incl. date range and actor, event sheet, export CSV, forward to syslog — the log records this pass's own actions with actor, target, source IP and result; filters and controls present. The event sheet and CSV export were not opened.
- [x] Notifications: in-app popover (mark all read), channels email/webhook/Telegram (connect + test), event rules matrix — the webhook was configured and its test delivered a real POST to a local listener, reported as "The endpoint answered HTTP 200"; a disabled channel reports "The <channel> channel is disabled in settings." rather than a generic failure.
  - [ ] **a genuine delivery failure** (unreachable endpoint) was not produced, so that message is unverified.
- [x] Settings: profile, appearance, language & region, transfers, notifications, backup (export/import config), retention, about — every section renders; the config export/import round trip was verified end to end, including that a wrong passphrase is refused and that an imported archive restores a changed setting.
  - [ ] **sessions (revoke, sign out others), CLI tokens, session timeout, allowed networks, check for updates** — present, not exercised.
- [x] Command palette: navigation, create actions, live search — search returns real buckets and jobs alongside navigation and create entries.
- [x] Dashboard: all cards live — totals match the API exactly.

## Cross-cutting rules
- [x] **Opaque ids only in routes, no data in the query string** — every route in `docs/ROUTES.md` was walked; params are UUIDs or the object-key splat, and search params carry only view state (filter, sort, page, tab, time range).
- [x] **Usable at 375 px** — 35 routes (lists, details and dialog routes) measured at 375 px: zero horizontal page overflow on every one, tables scroll inside their container and dialogs become full-height sheets.
- [x] **RTL and dark** — 18 routes at 375 px in `fa` + dark: `dir=rtl`, flipped layout, Persian digits and Solar Hijri dates, zero overflow.
- [x] **shadcn primitives only** — no `window.confirm/alert/prompt` and no native `select`, `table`, `textarea` or `input type=checkbox/radio/file/date/range` outside the kit; the one native file input lives in `FileDropzone` and is visually hidden.
- [x] **A clean console** — a cold load of the object browser fired `/servers//buckets//objects` and 404ed on every visit; fixed, and a fresh load now shows zero 4xx.
- [x] **Production image** — `docker build .` succeeds; the container serves the SPA and the API, signs in with env credentials, refuses a wrong password, and answers `/dashboard`, `/servers` and `/settings` behind the session. Removed afterwards.
