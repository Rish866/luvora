# Setup

## Prerequisites

- Node.js ≥ 20 (tested on Node 22)
- One of:
  - **Docker** (recommended) for local PostgreSQL, or
  - a native PostgreSQL ≥ 13 you manage yourself.

## 1. Install dependencies

```bash
npm install
```

This installs all workspaces (`packages/shared`, `apps/backend`).

## 2. Start PostgreSQL

### Option A — Docker (recommended for developers)

```bash
docker compose -f docker/docker-compose.yml up -d
# Postgres is now at postgres://app:app@localhost:5432/luvora_dev
```

### Option B — your own PostgreSQL

Create a database and set `DATABASE_URL` accordingly in
`apps/backend/.env.development`.

## 3. Configure environment

```bash
cp apps/backend/.env.example apps/backend/.env.development
# edit apps/backend/.env.development:
#   - set DATABASE_URL
#   - set strong JWT_ACCESS_SECRET / JWT_REFRESH_SECRET
#     (e.g. `openssl rand -base64 48`)
```

## 4. Migrate + seed

```bash
npm run -w @luvora/backend migrate:up
npm run -w @luvora/backend seed        # optional demo adults + a match
```

## 5. Run the API

```bash
npm run -w @luvora/backend dev         # ts-node-dev, auto-reload
# or production build:
npm run build && npm run -w @luvora/backend start
```

Health check: `GET http://localhost:4000/health`
Readiness (checks DB): `GET http://localhost:4000/ready`

## Running the test suite

### On a developer machine (with Docker Postgres running)

```bash
bash scripts/test-with-docker.sh
```

Or manually:

```bash
createdb -h localhost -U app luvora_test   # or psql CREATE DATABASE
DATABASE_URL=postgres://app:app@localhost:5432/luvora_test \
NODE_ENV=test \
JWT_ACCESS_SECRET=test-access-secret-at-least-16-chars \
JWT_REFRESH_SECRET=test-refresh-secret-at-least-16-chars \
  npm run -w @luvora/backend migrate:up && npm run -w @luvora/backend test
```

### In an environment without a stable Docker daemon (e.g. CI sandbox)

```bash
npm run verify
```

`verify` boots an **ephemeral native PostgreSQL** (initdb → start over a Unix
socket → migrate → run the full test suite → tear down), all within one process.
It requires the `postgresql`/`postgresql-server` binaries to be installed.

## Notes on migrations & ORM

Luvora uses plain, auditable SQL migrations (in `database/migrations/`) applied
by a small forward-only runner (`apps/backend/src/db/migrate.ts`) over the `pg`
driver — **not** Prisma. There is therefore no `prisma validate`/`generate`
step; the equivalent verification is running the migrations and the integration
tests against a real PostgreSQL (`npm run verify`).

## Notes on this build sandbox

The sandbox used to author this repo had no stable container runtime, so
`npm run verify` is the verification path there. On your machine, prefer Docker
(`docker compose -f docker/docker-compose.yml up -d`) — the application code and
connection string format are identical either way.
