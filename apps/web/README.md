# @storage-io/web

The storage-io console: React 19 + Vite + TypeScript (strict) + Tailwind CSS v4 +
shadcn/ui, reproducing the approved concept in `design/concept/` ("Refined").

This document is for the agents building the feature pages on top of this
foundation. Read `docs/BUILD-RULES.md`, `docs/ARCHITECTURE.md` and `docs/API.md`
first; this is the web app's own contract.

---

## Running it

```bash
pnpm --filter @storage-io/web dev        # against the real API on :3000
pnpm --filter @storage-io/web dev:mock   # against the MSW mocks, no API needed
```

`pnpm dev` at the root runs the API and the web app in parallel. The dev server is
on `http://localhost:5173` and proxies `/api` to `http://localhost:3000`, including
the SSE stream at `/api/v1/events` (no buffering, no timeout).

| script | what it does |
|---|---|
| `dev` / `dev:mock` | dev server; `dev:mock` sets `VITE_MOCK_API=1` |
| `build` | production build into `dist/` |
| `preview` | serves `dist/` on :4174 |
| `test` / `test:watch` | Vitest + Testing Library |
| `typecheck` | `tsc --noEmit` for the app and for the config files |
| `lint` | ESLint, including the project's hard rules |
| `normalize:ui` | re-applies our patches to `src/components/ui` after `shadcn add` |

Environment variables are documented in `.env.example`. All are optional.

---

## The rules that are enforced, not just asked for

**No browser-native primitives in feature code.** `<select>`, `<textarea>`,
`<table>`, `<input type="checkbox|radio|file|date|range|number|…">`,
`window.confirm`, `alert` and `prompt` are ESLint errors outside
`src/components/ui`. Use the kit.

**Never import `@/components/ui/*` from a page.** That is an ESLint error too.
Application code imports from `@/components/app`; the kit is the single place a
shadcn primitive is wrapped, so changing a component means changing one file.
Adding a shadcn component means adding its wrapper first.

**No runtime CDNs.** The app runs on-premise and may be offline. Fonts are
self-hosted through `@fontsource` (Geist, Geist Mono, Vazirmatn for `fa`, IBM Plex
Sans Arabic for `ar`) and switch on `:lang()`. Never add a `<link>` or an
`@import` to an external host.

**No hard-coded colours, radii or spacing.** Everything comes from the tokens in
`src/styles/globals.css`, which are a 1:1 port of the concept's. If a token is
missing, add it there (and say so) rather than inventing a literal in one screen.

**Logical properties only.** `ms-*`, `pe-*`, `start-*`, `text-start`, `border-s`.
Persian and Arabic set `dir="rtl"` and the same components have to work. The
shadcn primitives were converted by `scripts/normalize-ui.mjs`; re-run
`pnpm normalize:ui` after any `shadcn add --overwrite`.

---

## Layout of the source

```
src/
  app/            App providers and the router (every route lives in router.tsx)
  components/
    ui/           shadcn primitives — vendored, normalised, never imported by a page
    app/          THE KIT: one wrapper per primitive, imported everywhere
    shell/        sidebar, topbar, breadcrumbs, popovers, command palette
  features/<x>/   a feature's queries, dialogs and page components
  pages/          the placeholder and 404 pages
  lib/
    api/          typed fetch client and ApiError
    query/        query client defaults and the query-key factory
    events/       useEventStream (SSE)
    format/       Intl formatters and the FormatProvider
    dialogs/      the URL-addressable dialog registry
  stores/         zustand: preferences, transfers
  i18n/           i18next setup and the locale files
  mocks/          MSW handlers and fixtures (dev only)
  test/           setup and renderWithProviders
```

---

## The kit — `@/components/app`

| Component | For |
|---|---|
| `PageHeader` | the title / description / actions block every page starts with |
| `DataTable` | every list. See below. |
| `Combobox` | a searchable single-select (Popover + Command) |
| `DatePicker`, `DateRangePicker` | Calendar + Popover |
| `FileDropzone` | the only file input in the app: drag-drop, folders, accept/size/count limits |
| `ConfirmDialog` | "are you sure?", with an optional typed-name confirmation |
| `CopyField` | a value the operator copies — always LTR and monospaced |
| `CodeEditor` | CodeMirror 6 (`json` / `markdown` / `plain`), lazily loaded |
| `Meter`, `MeterStack` | quota and capacity bars, with the 80% / 90% thresholds |
| `KpiCard`, `Delta`, `Sparkline` | the dashboard tiles |
| `ChoiceCards` | the radio-cards group (provider picker, mode picker) |
| `SegmentedControl` | a value switch built on ToggleGroup (use Tabs for panels) |
| `useStepper`, `StepList`, `StepPanels`, `StepperNav` | the wizard pattern |
| `EmptyState` | the "nothing here" state |
| `ProviderMark` | MI / SW / S3 / CE / GA / R2 / WA tiles in the concept's colours |
| `ServerStatusBadge`, `JobStatusBadge`, `AccessKeyStatusBadge`, `UserStatusBadge`, `StatusDot` | every status in the system |
| `Bytes`, `Num`, `Pct`, `Ms`, `Duration`, `DateTime`, `RelativeTime`, `Dash` | every formatted value |
| `DialogHost` | mounted by the shell; renders whatever `?dialog=` asks for |

### Formatting

Never call `Intl` directly and never concatenate a unit onto a number. Use the
display components, or `useFormat()` when you need a string (a `title`, an
`aria-label`, a CSV cell):

```tsx
<Bytes value={bucket.sizeBytes} />          // "3.2 TB" or "2.9 TiB"
<Num value={objects} compact />             // "8.4M"
<Pct value={usageRatio} />                  // "80%"
<RelativeTime value={server.lastSeenAt} />  // "4 min. ago", refreshed on its own
<DateTime value={event.at} style="datetime" />
```

They honour `Settings.region` — size units (decimal/binary), calendar, digits and
timezone — through `FormatProvider`, which the shell feeds from `GET /settings`.
`RelativeTime` widens its own refresh interval as the value ages.

### DataTable

Controlled, and it does not fetch. The page owns the query and the URL state:

```tsx
const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
const [sorting, setSorting] = useState<SortingState>([]);
const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE });
const buckets = useBuckets({ page: pagination.pageIndex + 1, pageSize: pagination.pageSize });

<DataTable
  aria-label={t('buckets.title')}
  columns={[selectionColumn<Bucket>(), ...bucketColumns]}
  data={buckets.data?.items ?? []}
  getRowId={(bucket) => `${bucket.serverId}/${bucket.name}`}
  loading={buckets.isLoading}
  emptyState={<EmptyState icon={DatabaseIcon} title={…} action={…} />}
  rowSelection={rowSelection} onRowSelectionChange={setRowSelection}
  sorting={sorting} onSortingChange={setSorting}
  pagination={pagination} onPaginationChange={setPagination}
  total={buckets.data?.total}
  showColumnsMenu
  bulkActions={({ selectedRows, clearSelection }) => …}
  onRowClick={(bucket) => navigate({ to: '/buckets/$server/$bucket', params: … })}
/>
```

Notes worth knowing before you fight it:

- `getRowId` is required and must be stable: selection survives a refetch by id.
- Passing `pagination` turns on **server** pagination and therefore `manualSorting`
  — sort in the query, not in the browser, or you sort one page of many.
- A sortable numeric column sorts **descending first** (largest bucket at the top).
  The header's accessible name always states what the next click will do.
- Selection replaces the toolbar with the bulk bar. A bulk action must be **one
  request**, never a loop over `selectedIds`; if the endpoint does not exist, say
  so rather than looping.

---

## Routing

Code-based, all in `src/app/router.tsx`. To build a page, replace that route's
`component` and leave `path` and `staticData` alone.

- **Breadcrumbs** come from `staticData`: `crumb` is a key in the `pages`
  namespace, `crumbFromParams(params)` returns the text for a dynamic segment.
- **Search params** are validated on the root route with a *loose* schema, so a
  page may add its own filters without declaring them. `dialog` and anything
  starting with `d_` are reserved.
- Do not write a helper that wraps `createRoute`: the router infers `Link`'s `to`
  types from the literal `path`, and a helper taking `path: string` collapses every
  route type in the app.
- Heavy pages should be split: `component: lazyRouteComponent(() => import('…'))`.
  The initial bundle is ~845 kB / 261 kB gzipped today (React, the router, Query,
  Radix, i18next, lucide, cmdk). CodeMirror and Recharts are already outside it —
  keep Recharts there by lazily loading any section that charts.

### URL-addressable dialogs — the `?dialog=` convention

Every dialog that something else can open lives in the URL:

```
/servers?dialog=add-server
/quotas?dialog=edit-quota&d_server=minio-prod-01&d_bucket=media-prod
```

`dialog` names it; everything after `d_` is that dialog's own context. Back closes
the dialog, and a link or a bookmark opens it.

**Every page that owns a dialog must do three things**, or the command palette's
action does nothing:

1. add the key to `DIALOG_KEYS` in `src/lib/dialogs/registry.ts` (it is a union
   type, so a typo is a compile error);
2. point `DIALOG_OWNERS[key]` at the route whose module registers it;
3. call `registerDialog('<key>', MyDialog)` at module scope in that route's module.

```tsx
// src/features/servers/dialogs/AddServerDialog.tsx
import { registerDialog, type DialogProps } from '@/lib/dialogs/registry';

export function AddServerDialog({ params, onClose }: DialogProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      …
    </Dialog>
  );
}

registerDialog('add-server', AddServerDialog);
```

Render it always-open and close with `onClose()`; the host mounts it only while the
URL asks for it. To open one from elsewhere: `useDialogs().open('add-server')`
(navigates to the owner route first) or `.openHere(key, params)` when the page
already owns it.

Keys whose dialog needs a bucket (`upload`, `import-url`, `new-folder`,
`share-link`) are owned by `/browse`; the object browser registers them with the
bucket pre-filled from the route, and `/browse` registers the same component with a
bucket picker. Two routes registering the *same* component under one key is fine;
two different components is not — the last one wins.

**Today none of the 18 keys has a component yet.** The palette, the URL handling
and the host are done and verified; the dialogs are page work. Until a key is
registered, opening it logs a precise error in development and clears the param.

---

## Data layer

```tsx
const servers = useQuery({
  queryKey: queryKeys.servers.list(filters),
  queryFn: ({ signal }) => api.get<ServerList>('/servers', filters, signal),
});
```

- `api` (`src/lib/api/client.ts`) sends `credentials: 'include'` and turns any
  non-2xx into an `ApiError` carrying the problem+json `code`. Branch on
  `error.is('BUCKET_NOT_EMPTY')`, never on a status number. A 401 anywhere
  redirects to `/login` with the address to come back to.
- **Query keys only come from `queryKeys`** (`src/lib/query/keys.ts`). Never build
  one inline: `useEventStream` invalidates by scope and relies on the shape.
- Types come from `@storage-io/contracts`. Never redeclare a response shape; if
  the contract is wrong, change `docs/API.md` and the zod schema together and say
  so in your report.
- Forms: react-hook-form + `zodResolver(<schema from contracts>)`. When a schema
  has a default, the input and output types differ — use
  `useForm<z.input<S>, unknown, z.output<S>>`.

### Live updates

The shell opens one SSE connection. `src/lib/events/useEventStream.ts` maps each
event to the query scopes it makes stale:

| event | invalidates |
|---|---|
| `server.health` | servers, dashboard |
| `job.progress` | jobs |
| `job.status` | jobs, dashboard, activity |
| `notification` | notifications |
| `inventory.updated` | buckets, quotas, servers, dashboard |

A page never subscribes to the stream. It uses a query, and the query goes stale
when the server says the underlying thing changed. If a new event type is added,
extend that map — do not add a poll.

---

## i18n

Namespaced, keyed messages: `common`, `nav`, `auth`, `command`, `domain`, `pages`.
`en` is complete and is the fallback; `tr`, `fa` and `ar` are intentionally empty
`{}` files — translation is a separate task, and an empty namespace falls through
to English key by key rather than showing a raw key.

- Every string a user sees goes through `t()`. No literal English in a component.
- Numbers, sizes, dates and durations never go through i18next — they go through
  `src/lib/format`.
- Adding a namespace means adding the file for all four languages and registering
  it in `src/i18n/index.ts`.
- `fa` and `ar` switch `<html lang dir>`, the font and the Intl locale
  automatically.

---

## Theme and density

`<html data-theme="light|dark" data-density="comfortable|compact">`, written before
first paint by the inline script in `index.html` and kept in step by
`useApplyPreferences`. The storage key (`sio.prefs`) and its shape are duplicated
in that script — **change them together**.

Density is real: control heights, row heights, card padding and page padding all
derive from `--control-h`, `--row-h`, `--card-pad` and `--content-pad-*`. A
component that hard-codes `h-9` opts out of it.

---

## Testing

Vitest + Testing Library, `renderWithProviders` from `src/test/render.tsx`.

Test what breaks: selection and bulk actions, a typed confirmation, a rejected
file, a formatter's units, an empty state. Query by role and accessible name, not
by class. The English messages are loaded for real, so a missing key fails a test.

---

## Known gaps and deviations, as of this foundation

- **`Settings.region.sizeUnits` defaults to `binary`**, so the app shows
  "16.7 TiB / 30 TiB" where the concept drew "18.4 TB / 33 TB". The formatter
  supports both; this is the contract's default, not a UI choice. Worth a decision.
- **TanStack Table is pinned to v8.** v9 (the current latest) is a rewrite
  (`useTable` + explicit `features` + store atoms) with no shadcn support yet.
- **The DatePicker's month grid is Gregorian.** With `calendar: 'persian'` the
  *displayed* value is Solar Hijri (it goes through `Intl`) while the grid is not;
  react-day-picker has no Solar Hijri or Hijri calendar.
- **`src/components/ui` is linted lightly** (see `eslint.config.js`): it is
  vendored code that `shadcn add` regenerates. Our patches to it are re-applied by
  `pnpm normalize:ui`.
- **The sidebar's S3-users and access-keys counts are empty.** The concept draws
  "38" and "61" there, but `GET /dashboard` carries no totals for either. Do not
  substitute `expiringKeys.length` — it means something else. Either the contract
  gains `totals.users` / `totals.keys`, or those two badges stay empty.
- **No dialog component is registered yet.** The palette, the `?dialog=` handling
  and the host are complete and verified end to end; each of the 18 keys is page
  work. Until a key is registered, opening it logs a precise error in development
  and clears the param.
- The placeholder pages exist so every route, breadcrumb and shell state is real.
  None of them ships.
