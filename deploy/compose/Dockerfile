# deploy/compose/Dockerfile
# =============================================================================
# Shared multi-stage image for the governance control-plane application services.
# Phase 54 / task T054. Each app is a build `target` selected from control-plane.yml
# (target: api | command-worker | projector | discovery-agent | web).
#
# The monorepo is an npm workspace on Node 22 (see ./package.json engines). Sources
# are TypeScript executed with Node's type stripping (`--experimental-strip-types`),
# matching the repo's test scripts, so there is no separate compile step to drift from.
# =============================================================================

# ---- base: workspace install ------------------------------------------------
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production
# Copy the workspace manifests first for cacheable installs.
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY adapters ./adapters
COPY deploy ./deploy
COPY db ./db
# Deterministic install of the whole workspace.
RUN npm ci --omit=dev || npm install --omit=dev
# Directory the file:// healthchecks probe for worker liveness markers.
RUN mkdir -p /app/.health

# ---- per-app targets --------------------------------------------------------
# Each target sets the entrypoint for one process boundary. The core-only compose
# profile builds exactly these five.

FROM base AS api
ENV SERVICE_NAME=api
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "apps/api/src/server.ts"]

FROM base AS command-worker
ENV SERVICE_NAME=command-worker
CMD ["node", "--experimental-strip-types", "apps/command-worker/src/main.ts"]

FROM base AS projector
ENV SERVICE_NAME=projector
CMD ["node", "--experimental-strip-types", "apps/projector/src/main.ts"]

FROM base AS discovery-agent
ENV SERVICE_NAME=discovery-agent
CMD ["node", "--experimental-strip-types", "apps/discovery-agent/src/main.ts"]

# The web UI is served by a small dependency-free static/health server shipped with the
# compose profile. It stays up to render the fail-visible readiness picture and to
# escalate even while the core is degraded (NFR-010 read-only visibility clause). The
# operator SPA build (apps/web) is layered in by a later web-build phase; the entrypoint
# here already serves `/healthz` and reverse-reads the API's `/v1/readiness` surface.
FROM base AS web
ENV SERVICE_NAME=web
EXPOSE 8080
CMD ["node", "deploy/compose/web-server.mjs"]
