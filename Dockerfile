# syntax=docker/dockerfile:1.7
# storage-io — single image: NestJS API serving the built React app.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
# native modules (better-sqlite3 / argon2) need a toolchain at build time
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @storage-io/contracts build \
 && pnpm --filter @storage-io/web build \
 && pnpm --filter @storage-io/api build \
 && pnpm --filter @storage-io/api deploy --prod --legacy /out \
 && cp -r apps/web/dist /out/public

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/storage-io.sqlite WEB_DIST=/app/public
WORKDIR /app
RUN groupadd -r sio && useradd -r -g sio sio && mkdir -p /data && chown sio:sio /data
COPY --from=build --chown=sio:sio /out ./
USER sio
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
