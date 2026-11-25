# syntax=docker/dockerfile:1
#
# Homebase web (Next.js 16, output: "standalone").
# Build context is the repo root:  docker build -f infra/docker/web.Dockerfile .
#
# Requirements on apps/web/next.config.* (see docs/decisions.md):
#   output: "standalone"
#   transpilePackages: ["@homebase/shared", "@homebase/db", ...]  (packages export TS source)
#   outputFileTracingRoot: <repo root>  (Next 16 infers it from pnpm-lock.yaml; set it explicitly)
#   serverExternalPackages: ["argon2"]  (native addon)
# and a GET /api/health route that returns 200 when the app can reach Postgres.

ARG NODE_IMAGE=node:24.22-bookworm-slim

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    npm_config_update_notifier=false \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable \
 && corepack prepare pnpm@10.34.7 --activate \
 && pnpm --version \
 && chown -R node:node /opt/corepack
WORKDIR /app

# ---------------------------------------------------------------- deps
FROM base AS deps
# Toolchain only for native addons that lack a prebuilt binary (argon2 normally ships one).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Lockfile-only layer: re-downloads packages only when the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --store-dir /pnpm/store
COPY . .
# The server checkout may be owner-only (umask 077); make sources world-readable for the app user.
RUN chmod -R a+rX /app \
 && pnpm install --frozen-lockfile --offline --store-dir /pnpm/store

# ---------------------------------------------------------------- build
FROM deps AS build
ENV NODE_ENV=production \
    SKIP_ENV_VALIDATION=1
RUN pnpm --filter @homebase/web build \
 && mkdir -p apps/web/public \
 && if [ ! -f apps/web/.next/standalone/apps/web/server.js ]; then \
      echo "ERROR: apps/web/.next/standalone/apps/web/server.js not found." >&2; \
      echo "Set output: 'standalone' and outputFileTracingRoot to the repo root in apps/web/next.config." >&2; \
      ls -la apps/web/.next/standalone >&2 || true; \
      exit 1; \
    fi

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=127.0.0.2 \
    HOMEBASE_LISTEN_HOST=127.0.0.2 \
    PORT=3000 \
    TZ=America/New_York
WORKDIR /app
# Standalone server + traced node_modules, then static assets and public/.
# Owned by node so Next can write .next/cache at runtime.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
# Probe the address the server actually binds ($HOSTNAME: the 127.0.0.2 loopback
# alias, Linux-only; nothing listens on 127.0.0.1:3000 on purpose).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://'+(process.env.HOSTNAME||'127.0.0.2')+':'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
