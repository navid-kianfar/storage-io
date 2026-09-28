# syntax=docker/dockerfile:1.7
# storage-io — single image: NestJS API serving the built React app.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
# better-sqlite3 ships prebuilds for linux-x64 and linux-arm64, but a platform it
# has no prebuild for falls back to node-gyp — so the toolchain is here as the
# safety net rather than as a routine build step.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# The API compiles against the contracts' dist, so that build comes first. `pnpm
# deploy` copies the API with only its production dependencies; the web app's
# build output is copied in beside it, and WEB_DIST below points the API at it.
#
# The last step is belt and braces: `pnpm deploy` already carries
# apps/api/drizzle, and `cp -r <dir>/. <dir>/` merges into it rather than nesting
# a second drizzle/ inside the first. Without those migrations the container
# starts against an empty database and fails on its first query.
RUN pnpm --filter @storage-io/contracts build \
 && pnpm --filter @storage-io/web build \
 && pnpm --filter @storage-io/api build \
 && pnpm --filter @storage-io/api deploy --prod --legacy /out \
 && cp -r apps/web/dist /out/public \
 && mkdir -p /out/drizzle && cp -r apps/api/drizzle/. /out/drizzle/

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/storage-io.sqlite WEB_DIST=/app/public
WORKDIR /app
RUN groupadd -r sio && useradd -r -g sio sio && mkdir -p /data && chown sio:sio /data
COPY --from=build --chown=sio:sio /out ./
USER sio
VOLUME ["/data"]
EXPOSE 3000
# `/health` is deliberately outside the /api/v1 prefix (see bootstrap.ts), and it
# is the one path the SPA fallback does not answer — so a probe here can never be
# satisfied by the web app's index.html.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
