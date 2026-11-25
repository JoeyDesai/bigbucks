# syntax=docker/dockerfile:1
#
# Homebase worker (pg-boss jobs) and the one-shot `migrate` service.
# Build context is the repo root:  docker build -f infra/docker/worker.Dockerfile .
#
# Workspace packages export TypeScript source (no build step), so the worker
# runs under tsx. The image therefore carries the full workspace install
# (tsx is a root devDependency).
#
# Healthcheck contract: the worker touches /tmp/homebase-worker.heartbeat at
# least every 60 s while its pg-boss loop is healthy (see docs/decisions.md).

ARG NODE_IMAGE=node:24.22-bookworm-slim

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    npm_config_update_notifier=false
RUN corepack enable \
 && corepack prepare pnpm@10.34.7 --activate \
 && pnpm --version \
 && chown -R node:node /opt/corepack
WORKDIR /app

# ---------------------------------------------------------------- deps
FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --store-dir /pnpm/store
COPY . .
# The server checkout may be owner-only (umask 077); make sources world-readable for the app user.
RUN chmod -R a+rX /app \
 && pnpm install --frozen-lockfile --offline --store-dir /pnpm/store

# ---------------------------------------------------------------- runtime
FROM base AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    TZ=America/New_York
# Root-owned and read-only for the app user: the worker never writes its own code.
COPY --from=deps /app /app
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "-e", "const fs=require('node:fs');try{const s=fs.statSync('/tmp/homebase-worker.heartbeat');process.exit(Date.now()-s.mtimeMs<180000?0:1)}catch{process.exit(1)}"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]
