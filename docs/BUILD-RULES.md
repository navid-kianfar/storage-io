# Build rules for everyone working in this repo

Read first: `docs/ARCHITECTURE.md` (decisions) and `docs/API.md` (contract). The approved UI is in `design/concept/*.html` together with `design/concept/assets/css/global.css`.

## Shared workspace etiquette (several agents work in parallel)

- **pnpm mutex.** Never run two installs at once. Wrap every `pnpm install` / `pnpm add` / `pnpm remove` like this:
  `until mkdir /tmp/storage-io-pnpm.lock 2>/dev/null; do sleep 3; done; <pnpm command>; rmdir /tmp/storage-io-pnpm.lock`
  Always release the lock, even on failure (`; rmdir …` runs regardless).
- Add deps to your package only: `pnpm --filter @storage-io/api add x`. Root devDeps only when truly shared.
- Stay inside the paths you were assigned. If you need a change in someone else's area (contracts, another module), make the minimal change and list it in your final report.
- Do not commit. Do not touch `design/`.
- `packages/contracts` is the single source of truth for request/response shapes. If the contract needs to change, edit `docs/API.md` and the zod schema together.

## Ports and env

- API: `http://localhost:3000`, prefix `/api/v1`. Web dev server: `http://localhost:5173`, which proxies `/api` to 3000.
- `apps/api/.env.example` documents every variable. Required: `ADMIN_USERNAME`, `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_HASH`), `APP_SECRET` (≥ 32 chars), `DATABASE_PATH` (default `./data/storage-io.sqlite`).
- Dev S3 targets: `docker compose -f docker/docker-compose.dev.yml up -d`. Endpoints and credentials are documented in that file.

## Quality bar

- TypeScript strict, no `any` in feature code, ESLint + Prettier clean, `pnpm typecheck` and `pnpm test` green before you report.
- Prove behaviour with tests (unit plus e2e for the API; component tests for the web). Report what you actually ran and its result.
