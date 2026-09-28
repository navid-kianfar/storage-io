# Web refactor — ID routing, dialogs as routes, form alignment, responsive

Read first: docs/ROUTES.md (binding), docs/briefs/web-pages.md (hard rules), apps/web/README.md, docs/API.md (the new `id` fields and resolve endpoints from the backend ID work).

## 1. Routing (docs/ROUTES.md)
- Replace every route with the route map. Params are opaque IDs: `serverId`, `bucketId`, `userId`, `groupId`, `policyId`, `keyId`, `jobId`, `eventId`. No names in any URL.
- Remove the `?dialog=` + `d_*` convention entirely (registry, `DialogHost`, `DIALOG_OWNERS`). Create/edit dialogs become child routes rendered over their parent page; closing one navigates to the parent. The command palette, quick actions and every "New…" button navigate to those routes.
- Bucket pages resolve `bucketId` with `GET /buckets/:bucketId` (cache it in the query client) and then call the per-server endpoints with `serverId` + name. IAM entities do the same with their resolve endpoints.
- The object key and prefix are splat params (`/buckets/$bucketId/browse/$`, `/buckets/$bucketId/object/$`). The inspector-open state is the `object` route, not `?obj=`.
- Non-ID context (e.g. the object browser's selection pre-filling the new-job wizard: keys, prefixes, type) goes in router history state. Send `source.keys` to the API; drop the glob workaround.
- Search params may only hold view state: filters, sort, page, tab and range. Audit and remove any id, name or key found in search params.
- Breadcrumbs show names (resolved from the IDs) while URLs carry IDs.
- Notification and search `href`s from the API already follow ROUTES.md. Navigate to them directly.
- Old URLs: none are shipped yet, so no redirects are needed. Update the tests.

## 2. Form alignment (the user flagged misaligned fields)
- Every label + control pair uses `FormField` from the kit. No ad-hoc `<span className="text-sm font-medium">` or bare `Label` above a control. There are ~20 such spans today; grep and convert all of them.
- Fields placed side by side sit in a grid with `items-start`, so labels and controls line up even when one field has a hint or an error.
- Every control has the same height: Input, Select trigger (fixed to `h-(--control-h)`), Combobox trigger, DatePicker trigger, ByteSizeInput and InputGroup. Verify in both densities.
- Anything that picks an existing entity is a Combobox fed by the API (server, bucket, user, policy, group), never a free-text input.
- Add a component test that renders a two-column FormField row with Input + Combobox + Select and asserts the controls share the same top offset and height (jsdom cannot lay out, so assert on classes/structure, or use a Vitest browser-mode test if available).
- Then look at every form in the app side by side in the browser (dialogs, settings, bucket settings, wizards) and fix any remaining misalignment.

## 3. Responsive down to 375 px (every page, dialog, sheet and wizard)
- No horizontal page scroll anywhere, at 375, 390, 768 and 1024 px.
- Tables: keep them inside a scroll container with the key columns first, or switch to a card/list layout under `md` where a table is unusable (object browser, users, keys, activity, jobs history, buckets).
- Toolbars and filter rows wrap or collapse into a "Filters" sheet/menu. Bulk bars stay reachable and sticky at the bottom on mobile.
- Dialogs become full-screen sheets or drawers on mobile with a sticky footer. Wizards keep Back/Next visible. Side sheets take full width on mobile.
- Two-pane layouts (policies, bucket settings sub-nav, settings sub-nav, object inspector) stack or use a sheet on mobile.
- Charts and KPI grids reflow; long mono strings (keys, ARNs, endpoints) wrap or truncate with copy.
- Touch targets ≥ 40 px on mobile; row actions reachable without hover.

Verification: in the built-in browser at 375 and 1440 (and a pass at 768), light and dark, `dir=rtl` (fa), against the real API on :3000. Go through every route in ROUTES.md and every dialog. typecheck/lint/test green. Commit nothing. Report: short.

## 4. Collected fixes (from the integration passes)
- Breadcrumbs: add a central entity-name resolver (server/bucket/user/group/policy/key/job from the query cache or the resolve endpoints) so id routes never show a UUID in the breadcrumb or page title.
- Fix the typecheck errors in `src/mocks/*` and the IAM test fixtures caused by the new `id` fields (Bucket, S3User, S3Group, PolicySummary, AccessKey). Mocks must mirror the real contract.
- Command palette and search: use the API's `href` (now ROUTES.md-compliant) or type+id. Jobs go to `/jobs/$jobId`.
- Upload dialog title reads "Upload to Select" when no bucket is picked: use a neutral title ("Upload files") until a bucket is chosen.
- Welcome → size units hint: make it describe the selected option (decimal vs binary), not always decimal.
- After any `@storage-io/contracts` rebuild, restart the web dev server (Vite's module graph breaks otherwise).
- `Dashboard.totals.usedBytes` may be renamed by the backend (bucket bytes vs server capacity). Follow the contract.
- Users bulk bar: switch to the new `POST /iam/users/bulk` (and `/iam/access-keys/bulk` for keys), one request.
- Run a live transfer end to end (upload a real file) and check the populated transfers popover and floating panel.
- Refresh the lists in other tabs on the SSE events `activity.created`, `server.created` and `server.deleted`.
