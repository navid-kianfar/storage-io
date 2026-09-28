# @storage-io/web

The storage-io console: React 19 + Vite + TypeScript (strict) + Tailwind CSS v4 +
shadcn/ui, in the "Refined" design direction.

This document is for anyone building pages on top of this foundation. Read
`docs/ARCHITECTURE.md`, `docs/API.md` and `docs/ROUTES.md` first; this is the web
app's own contract.

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
    dialogs/      dialog routes: RouteState, useRouteOverlay
    entities/     the opaque-id resolver (id -> serverId + name)
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
  getRowId={(bucket) => bucket.id}
  loading={buckets.isLoading}
  emptyState={<EmptyState icon={DatabaseIcon} title={…} action={…} />}
  rowSelection={rowSelection} onRowSelectionChange={setRowSelection}
  sorting={sorting} onSortingChange={setSorting}
  pagination={pagination} onPaginationChange={setPagination}
  total={buckets.data?.total}
  showColumnsMenu
  bulkActions={({ selectedRows, clearSelection }) => …}
  onRowClick={(bucket) => navigate({ to: '/buckets/$bucketId', params: { bucketId: bucket.id } })}
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

Code-based, all in `src/app/router.tsx`. The route map is **docs/ROUTES.md** and
that document is binding.

- **Every param is an opaque id** — `$serverId`, `$bucketId`, `$userId`,
  `$groupId`, `$policyId`, `$keyId`, `$jobId`, `$eventId`. Never a name: a name is
  unique only within one server, is not a safe path segment, and leaks what the
  operator called something into every link they paste. The object key and the
  browsed prefix are splats, because a key is the object's identity in S3 and has
  no other id.
- **Search params carry view state only**: filters, sort, page, the active tab and
  a time range. Identity travels in the path; context that is neither identity nor
  view state travels in router history state (below). The root route's schema is
  *loose*, so a page may add its own filters without declaring them.
- **Breadcrumbs** come from `staticData`: `crumb` is a key in the `pages`
  namespace, and `crumbEntity` names an id param plus what kind of entity it is, so
  the crumb shows the resolved *name* while the URL keeps the id.
- Do not write a helper that wraps `createRoute`: the router infers `Link`'s `to`
  types from the literal `path`, and a helper taking `path: string` collapses every
  route type in the app.
- Heavy pages should be split: `component: lazyRouteComponent(() => import('…'))`.
  CodeMirror and Recharts are outside the initial bundle — keep Recharts there by
  lazily loading any section that charts.

### Dialogs are routes

A dialog that creates or edits an entity is a **child route**, rendered over its
parent page through that page's `<Outlet/>`. Closing it navigates to the parent —
never `history.back()`, which does nothing useful when the dialog's URL was opened
directly. A small in-page confirmation (delete, rename, tag, "share this link")
stays component state and has no URL.

```
/servers            ServersPage, with <Outlet/>
/servers/new          → AddServerRoute renders the wizard over it
/keys               KeysPage, with <Outlet/>
/keys/new             → CreateAccessKeyRoute
/keys/$keyId/rotate   → staticData.overlay = 'key-rotate'; the page renders it
```

Two shapes, and the difference is who owns the state:

1. **Self-contained** — "create a bucket", "add a server". The child route's
   `component` is a small `…Route` wrapper that supplies `onClose` (a navigation to
   the parent) and renders the dialog. Nothing from the page is needed.
2. **Acts on the row behind it** — pause a job, rotate a key, edit a group. The
   page keeps ownership because the handlers and the list's queries live there, so
   the route carries only `staticData: { overlay: '<name>' }` and its id param, and
   the page asks `useRouteOverlay()` (`src/lib/dialogs/route.ts`) which overlay is
   open and with which id. The params come from the deepest match, because
   `useParams` inside the *parent's* component never sees the child's `$jobId`.

The `?dialog=` + `d_*` registry this replaces is gone. It put entity names and ids
in the query string, which the routing rules forbid, and it made every dialog a
runtime lookup that could silently fail to register.

### History state — context that is neither an id nor view state

`navigate({ to, state: routeState({ … }) })`, read back with `useRouteState()`.
The shape is `RouteState` in `src/lib/dialogs/route.ts`; every field is optional
because a typed URL, a bookmark or a reload arrives with none of them.

This is how the object browser hands its selection to the new-job wizard: the
server, the bucket, the prefix, the chosen keys and the operation. A selection of
tens of thousands of keys has no business in an address bar, and a bookmark of
`/jobs/new` is simply an empty wizard, which is the right answer.

### Resolving an id — `src/lib/entities/resolve.ts`

Every URL carries ids while every per-server endpoint is addressed by `serverId` +
*name*, so one module turns one into the other: `useEntityRef(kind, id)` for the
`{ id, serverId, name }` a breadcrumb or a route needs, `useBucketScope(bucketId)`
for the `{ serverId, bucket }` every bucket query keys off, and the
`use…ById` hooks in `features/iam/api.ts` when a page needs the whole entity in one
request. They share the `entities` query scope, so a page and its breadcrumb
resolve the same id once between them, and `seedEntities` fills that cache from a
list the operator has already seen.

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
| `server.created` / `server.deleted` | servers, dashboard, buckets, quotas, iam |
| `job.progress` | jobs |
| `job.status` | jobs, dashboard, activity |
| `notification` | notifications, activity |
| `activity.created` | activity, dashboard |
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
- **`Dashboard.totals.bucketsBytes` is not the servers' used capacity.** It is the
  sum of every bucket's size; `byServer[].usedBytes` is what each server reports
  about itself, and the two do not have to agree — replication, erasure coding and
  anything on the server storage-io did not put there sit in the difference. The
  sidebar's meter and the Storage KPI show `bucketsBytes` against `capacityBytes`.
- **The transfer engine does not know about the query cache.** A finished upload
  invalidates the object listing through a handler `src/app/App.tsx` installs
  (`setUploadCompletedHandler`), the same seam as the API client's unauthorized
  handler. Nothing on the SSE stream reports an object write, so without it a
  folder stays one upload out of date.
