# syntax=docker/dockerfile:1

# =============================================================================
# Luvora backend — production image (Increment 11; deps hardened Increment 12).
#
# Multi-stage build:
#   1. "build"   installs ALL workspace deps and compiles shared + backend to JS.
#   2. "deps"    installs ONLY production deps for a lean runtime node_modules.
#   3. "runtime" copies compiled JS + prod deps, runs as a NON-ROOT user.
#
# The container runs the API process (`node dist/src/server.js`). The background
# worker is the SAME image with a different command (see docs/DEPLOYMENT.md):
#   docker run <image> node apps/backend/dist/src/jobs/workerMain.js
#
# Node signals: server.ts installs SIGTERM/SIGINT handlers for graceful
# shutdown, so the container stops cleanly without --init. We still default
# NODE_ENV=production (which engages the config fail-fast guard).
#
# NODE_VERSION 22 is REQUIRED (not just preferred): the media pipeline depends
# on file-type v21 (ESM-only; the advisory fix) loaded via dynamic import from
# CommonJS, which relies on Node 22's built-in require(esm) support. The runtime
# deps also include sharp 0.35.5 (patched libvips/libheif) and ioredis (the
# distributed abuse backend client).
# =============================================================================

ARG NODE_VERSION=22

# ---- 1. build -------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

# Copy manifests first for better layer caching.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/

# Install the full workspace (dev deps needed to compile TypeScript + build
# sharp's native bindings).
RUN npm ci

# Copy sources and compile shared -> backend.
COPY packages/shared ./packages/shared
COPY apps/backend ./apps/backend
COPY database ./database
RUN npm run -w @luvora/shared build \
 && npm run -w @luvora/backend build

# ---- 2. deps (production only) -------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
# Omit dev dependencies; keep the workspace layout so @luvora/shared resolves.
RUN npm ci --omit=dev

# ---- 3. runtime -----------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Production node_modules. npm hoists workspace dependencies to the root
# node_modules (and symlinks @luvora/shared there), so this single tree is all
# the runtime needs.
COPY --from=deps /app/node_modules ./node_modules
# Compiled JS + the manifests needed to resolve the workspace package.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
# SQL migrations (applied out-of-band at deploy time; see docs/DEPLOYMENT.md).
COPY --from=build /app/database ./database

# Drop privileges: the official node image ships a non-root `node` user.
USER node

EXPOSE 3000

# Liveness probe hits the cheap /health endpoint (no DB dependency).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default command: the API server. Override to run the worker.
CMD ["node", "apps/backend/dist/src/server.js"]
