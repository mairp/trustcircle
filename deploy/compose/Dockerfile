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
CMD ["node", "--experimental-strip-types", "deploy/compose/api-runtime.mjs"]

FROM base AS command-worker
ENV SERVICE_NAME=command-worker
CMD ["node", "--experimental-strip-types", "deploy/compose/worker-runtime.mjs", "command-worker"]

FROM base AS projector
ENV SERVICE_NAME=projector
CMD ["node", "--experimental-strip-types", "deploy/compose/worker-runtime.mjs", "projector"]

FROM base AS discovery-agent
ENV SERVICE_NAME=discovery-agent
CMD ["node", "--experimental-strip-types", "deploy/compose/worker-runtime.mjs", "discovery-agent"]

FROM node:22-bookworm-slim AS web-build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY adapters ./adapters
COPY scripts ./scripts
RUN npm ci
RUN npm run typecheck
RUN npm run build --workspace @trustcircle/web

# Production operator console. The dependency-free deploy/compose/web-server.mjs remains
# the digest-identifiable JSON readiness fallback described by the governed rollback plan.
FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080 \
    SERVICE_NAME=web
COPY --chown=node:node --from=web-build /app/apps/web/.next/standalone ./
COPY --chown=node:node --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node --from=web-build /app/apps/web/public ./apps/web/public
COPY --chown=node:node deploy/compose/healthcheck.mjs ./deploy/compose/healthcheck.mjs
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
