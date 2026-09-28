# Web page waves — shared instructions

Read: docs/BUILD-RULES.md, docs/ARCHITECTURE.md, docs/API.md (incl. Additions), docs/FEATURE-CHECKLIST.md, apps/web/README.md (kit + conventions). Match the approved concept page pixel-for-pixel in spirit: `design/concept/<page>.html` (+ `assets/css/global.css`, `assets/css/pages/<page>.css`). Serve the concept with `python3 -m http.server 4173 --directory design/concept` to compare side by side.

Hard rules:
- **Only shadcn primitives** (via the kit in src/components/app and src/components/ui). No native select/table/checkbox/radio/file/date/range/textarea/confirm/alert. ESLint enforces this.
- **Nothing is a stub**: every button, menu item, dialog and flow from the concept page and from docs/FEATURE-CHECKLIST.md must work against the real API. No "coming soon" toasts.
- Data via TanStack Query hooks per domain in `src/features/<domain>/api.ts` (query keys from the factory, mutations invalidate precisely, optimistic updates where it improves feel). Forms via react-hook-form + zod schemas from @storage-io/contracts. Errors → toast with the problem `detail`, field errors mapped to form fields.
- i18n keys for every string (en only). RTL-correct (logical utilities, flip directional icons). Loading skeletons, empty states, error states, disabled/unsupported states per capability (`NOT_SUPPORTED`, alert-only quotas, offline servers).
- Deep links: filters/tabs/selection-independent state in URL search params; dialogs openable via the `?dialog=` convention (register yours).

Verification (required): run the API (`pnpm --filter @storage-io/api dev` with apps/api/.env from .env.example) against the dev containers (`docker compose -f docker/docker-compose.dev.yml up -d`), add the MinIO and SeaweedFS servers through the UI, and exercise every flow in your pages in the built-in browser at 1440px and 375px, light and dark, and dir=rtl. Fix what you find. Component tests for complex logic. typecheck/lint/test green. Report: short — pages done, flows exercised, anything not working and why.

## Current state notes (lead)
- The backend feature modules (buckets, objects, IAM, jobs, dashboard…) are being built in parallel. If an endpoint you need is not implemented yet, build strictly against `@storage-io/contracts` and extend the MSW handlers in `apps/web/src/mocks` with realistic data (use the concept's demo data) so the page is fully exercisable in `pnpm dev:mock`. A later integration pass runs every page against the real API — keep all API access in `src/features/<domain>/api.ts` so that pass is mechanical.
- Wherever the real API already exists (auth, servers, settings, activity, notifications), verify against it too.
- Size units default to decimal (TB). Sidebar user/key counts come from `Dashboard.totals.users/accessKeys` (being added to the contract).
- DatePicker: when `Settings.region.calendar` resolves to Persian, use react-day-picker's Persian calendar (`react-day-picker/persian`) so the grid is Solar Hijri; Hijri likewise if available — fix this in the kit if your page uses dates.
- Several agents edit `apps/web` concurrently: stay inside your routes/features; shared files (`router.tsx`, dialog registry, mocks index, i18n `en` namespaces) — make small additive edits only, re-read right before editing.
