<!--
Thanks for the pull request. Keep the description about the change itself: what
it does, and why it is shaped this way. Link the issue it closes.
-->

## What this changes

<!-- One or two sentences. Closes #… -->

## Why

<!-- The problem, or the decision and what it was chosen over. -->

## How it was verified

<!--
Commands you actually ran, and their result. "Should work" is not a result.
-->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm --filter @storage-io/api test:it` (when the change touches a provider
      driver or an S3 path — needs `docker compose -f docker/docker-compose.dev.yml up -d`)
- [ ] Checked in the browser at 1440 px **and** 375 px

## Checklist

- [ ] The contract (`packages/contracts`) and `docs/API.md` changed together, or
      neither did.
- [ ] Web UI uses shadcn/ui primitives — no hand-rolled replacements for an
      existing one.
- [ ] Routes carry opaque ids, never names, and no data in the query string
      (`docs/ROUTES.md`).
- [ ] Styling uses logical properties (`ms-*`, `ps-*`, `start-*`), so RTL keeps
      working.
- [ ] User-facing strings go through i18next; no literal copy in a component.
- [ ] No secret value in a file, a log, a comment or a fixture.
- [ ] A schema change comes with its generated migration (`pnpm db:generate`).

## Anything a reviewer should look at first

<!-- The risky part, the thing you are unsure about, the trade-off you made. -->
