# Contributing to storage-io

storage-io is a self-hosted console for S3-compatible object storage. It is a
pnpm monorepo: a NestJS API, a React web app, and a shared contract package that
both compile against.

Read these before a substantial change — they are short and they are the
decisions, not a tour:

| Document               | What it settles                                            |
| ---------------------- | ---------------------------------------------------------- |
| `docs/ARCHITECTURE.md` | Why the pieces are shaped this way                         |
| `docs/API.md`          | The contract. Changing it changes `packages/contracts` too |
| `docs/ROUTES.md`       | The web route map, and the two binding rules about URLs    |
| `docs/BUILD-RULES.md`  | Workspace etiquette and the quality bar                    |
| `apps/api/README.md`   | The API's module map and the traps worth knowing           |
| `apps/web/README.md`   | The UI kit, the lint rules that are errors, and the layout |

---

## Getting set up

You need **Node ≥ 22** and **pnpm 10** (`corepack enable` picks up the version
pinned in `package.json`'s `packageManager` field — don't install pnpm globally
and fight it). Docker is needed only for the integration tests and the image
build.

```bash
git clone https://github.com/navid-kianfar/storage-io.git
cd storage-io
pnpm install

cp apps/api/.env.example apps/api/.env   # then set ADMIN_PASSWORD and APP_SECRET
pnpm dev                                  # API on :3000, web on :5173
```

`pnpm dev` builds `@storage-io/contracts` first — the other two packages compile
against its `dist/`, so a fresh clone that skips it fails with a hundred
unresolved imports rather than one clear error.

Open <http://localhost:5173> and sign in with the `ADMIN_USERNAME` /
`ADMIN_PASSWORD` you just set. There is no sign-up: one admin, from the
environment.

### Local storage servers

```bash
docker compose -f docker/docker-compose.dev.yml up -d
```

MinIO on `:9000` (console `:9001`) and SeaweedFS on `:8333`. The endpoints and
the fixed development credentials are documented at the top of that file. Add
both through the UI, or run the demo seed:

```bash
pnpm seed:demo            # needs the API running and the containers up
```

The seed registers both servers, creates buckets, uploads sample objects, and
creates S3 users, policies, access keys and a couple of jobs — enough that every
page has something on it. It is idempotent: run it twice and nothing doubles.

> The credentials in `docker/docker-compose.dev.yml` and in the seed script are
> **development values**, fixed so the integration tests can find them. They must
> never appear in a deployed environment.

### The `pnpm` mutex you may see mentioned

`docs/BUILD-RULES.md` asks for a lock file around every `pnpm install`. That rule
exists because several automated agents work in this repo in parallel and two
concurrent installs corrupt the store. **If you are a human with your own
checkout, ignore it** — just run `pnpm install`.

---

## The commands

| Command                                      | What it does                                           |
| -------------------------------------------- | ------------------------------------------------------ |
| `pnpm dev`                                   | API + web in parallel                                  |
| `pnpm build`                                 | Contracts, then both apps                              |
| `pnpm lint`                                  | ESLint across the workspace                            |
| `pnpm format` / `pnpm format:check`          | Prettier write / verify (CI runs the check)            |
| `pnpm typecheck`                             | `tsc --noEmit` in every package                        |
| `pnpm test`                                  | Contracts, API unit + e2e, web component tests         |
| `pnpm --filter @storage-io/api test:it`      | Integration tests against the real containers          |
| `pnpm --filter @storage-io/api db:generate`  | Generate a migration after editing the schema          |
| `pnpm --filter @storage-io/web normalize:ui` | Re-apply our patches after `shadcn add`                |
| `pnpm seed:demo`                             | Fill a local installation with demo data               |
| `pnpm screenshots`                           | Capture `docs/screenshots/` with your installed Chrome |

`pnpm lint`, `pnpm typecheck` and `pnpm test` must be green before you open a
pull request. `pnpm format:check` is not a CI gate yet — the tree has not been
formatted end to end — but run `pnpm format` on the files you touched. The integration suite is required when you touch a provider
driver or an S3 code path; without `S3_IT=1` those specs skip themselves, so
`pnpm test` stays green on a machine with no Docker.

---

## Conventions

These are not style preferences. Most of them are enforced by ESLint or by a
test, and a PR that breaks one will fail CI.

### The contract is the source of truth

`packages/contracts` holds the zod schema for every request and response. No DTO
in the API restates a field, and no component redeclares a shape. If the
contract is wrong, change `docs/API.md` **and** the schema in the same commit.

### The web app uses the kit, not raw primitives

- Feature code imports from `@/components/app`. Importing `@/components/ui/*`
  from a page is an ESLint error — the kit is the single place a shadcn
  primitive is wrapped.
- **shadcn/ui primitives only.** `<select>`, `<textarea>`, `<table>`, most
  `<input type=…>`, `window.confirm`, `alert` and `prompt` are ESLint errors
  outside `src/components/ui`. If a primitive is missing, add the shadcn
  component and its wrapper rather than hand-rolling one.
- No hard-coded colours, radii or spacing. Everything comes from the tokens in
  `src/styles/globals.css`. Add a token instead of a literal.
- No runtime CDNs — the app runs on-premise and may be offline. Fonts are
  self-hosted via `@fontsource`.

### Routes carry ids, never names

`docs/ROUTES.md` is binding:

- a route param is an **opaque id** (`/buckets/$bucketId`), never a server,
  bucket, user or policy name;
- **no data in the query string.** Search params are for view state only —
  filters, sort, page, active tab, time range. Context that is neither an id nor
  view state travels in router history state;
- the object key is the exception, because in S3 the key _is_ the identity: it
  is a splat param, never a query param.

### Logical CSS, always

`ms-*`, `pe-*`, `start-*`, `text-start`, `border-s`. Persian and Arabic set
`dir="rtl"` and the same components have to work in both directions. Never
`ml-*`, `pr-*`, `left-*`. After `shadcn add --overwrite`, run
`pnpm --filter @storage-io/web normalize:ui` to re-apply the conversion.

### Everything user-facing goes through i18next

English is complete; `tr`, `fa` and `ar` exist and fall back to it. The test
setup loads the real English messages, so a missing key fails a test rather than
rendering a key name. Numbers, bytes and dates go through `Intl`, not through
string concatenation.

### Every page works at 375 px

No horizontal page scroll; tables scroll inside their container or become cards;
dialogs become full-height sheets. Check it before you open the PR — it is on
the PR checklist because it is easy to forget and expensive to retrofit.

### Tests prove behaviour

- API: unit tests for logic, e2e (supertest, in-memory SQLite) for a route,
  integration (`test/it/**`, behind `S3_IT=1`) for anything that talks to a real
  storage server. A provider quirk gets a test that names the version it was
  observed on.
- Web: Vitest + Testing Library via `renderWithProviders`. Query by role and
  accessible name, never by class. Test what breaks — selection, bulk actions, a
  rejected file, an empty state, a formatter's units.
- Report what you actually ran. A test you did not run is not a passing test.

### Schema changes are migrations

Edit `apps/api/src/db/schema.ts`, then `pnpm --filter @storage-io/api db:generate`
and commit the generated SQL with the change. Never hand-edit a migration that
has shipped, and never edit the database by hand to make one unnecessary — the
fresh-create path and the upgrade path are the same code, and a test asserts
they end up identical.

### Secrets

No credential value ever goes into a file, a log, a comment, a fixture or a
commit — not even a "temporary" one. The development credentials in
`docker/docker-compose.dev.yml` are the single documented exception and they
exist so the integration tests can find them. If you find a real secret in the
history, see [SECURITY.md](SECURITY.md): it needs rotating, and a PR that
deletes the line is not the fix.

---

## Pull requests

- Branch from `main`. One logical change per PR.
- Commit messages: a short imperative subject, and a body that says _why_ when
  the reason is not obvious. Conventional-commit prefixes (`feat:`, `fix:`,
  `chore(deps):`) are welcome and are what Dependabot uses, but they are not
  enforced.
- Fill in the PR template, including how you verified the change. CI runs lint,
  format, typecheck, unit + e2e, the container integration suite and a Docker
  build; it is the same set you can run locally.
- A change that touches a provider driver should say which provider version it
  was tested against. Several of the sharp edges in this codebase are a specific
  release's behaviour, and the comments record that on purpose.

By contributing you agree that your contribution is licensed under the MIT
License, as in [LICENSE](LICENSE).

## Code of conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
