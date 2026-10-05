# Deployment guide (Increment 11)

How to build, configure, and run the Luvora backend in production. The topology
is deliberately simple: a stateless **API** process and a separate **worker**
process, both built from the same image, sharing one PostgreSQL database.

> No Redis/Kafka/Prometheus-server is required. Rate limiting and metrics are
> **process-local** (see Scaling & limitations below).

## 1. Build the image

A production, multi-stage, non-root `Dockerfile` is at the repo root:

```bash
docker build -t luvora-backend:latest .
```

Stages: compile `@luvora/shared` + backend to JS → install production-only
dependencies → copy compiled output + prod `node_modules` into a slim runtime
that runs as the non-root `node` user. The default command starts the API:
`node apps/backend/dist/src/server.js`.

## 2. Run the API and the worker

Same image, different command. The API process stays API-only
(`JOB_WORKER_ENABLED=false`); the worker drains the durable queue:

```bash
# API
docker run -d --name luvora-api -p 3000:3000 --env-file prod.env luvora-backend:latest

# Worker (separate process/container, same DB)
docker run -d --name luvora-worker --env-file prod.env \
  luvora-backend:latest node apps/backend/dist/src/jobs/workerMain.js
```

Graceful shutdown: the server installs SIGTERM/SIGINT handlers (closes WS
channels, stops the embedded worker if any, drains the pool), so orchestrators
can stop containers cleanly.

## 3. Required configuration (production fail-fast)

The app **refuses to boot** in `NODE_ENV=production` if any of these are
insecure (it logs the problem names — never a secret value — and exits):

| Variable | Requirement in production |
|---|---|
| `JWT_ACCESS_SECRET` | ≥ 32 chars, not a dev/example value |
| `JWT_REFRESH_SECRET` | ≥ 32 chars, must DIFFER from the access secret |
| `BCRYPT_ROUNDS` | ≥ 10 |
| `CORS_ALLOWED_ORIGINS` | explicit allowlist, no wildcard with credentials |
| `DEVELOPER_MODE` | must be `false` |
| `DATABASE_URL` | required |

Generate strong secrets, e.g. `openssl rand -base64 48`.

## 4. Key security / tuning environment variables

See `apps/backend/.env.example` for the full list. Highlights:

- **CORS**: `CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com`
- **Proxy**: `TRUST_PROXY_HOPS` = number of trusted reverse proxies in front of
  the app (so `req.ip` is the real client and `X-Forwarded-For` can't be forged).
  Default `0` (direct connection). Behind one LB/ingress, set `1`.
- **HSTS**: `HSTS_ENABLED=true` only when TLS is terminated in front and you
  intend browsers to pin HTTPS (`HSTS_MAX_AGE_SECONDS`).
- **Abuse control**: `ABUSE_GUARD_ENABLED` (default on), `ABUSE_GUARD_MAX_KEYS`.
- **Login throttle**: `LOGIN_MAX_FAILURES`, `LOGIN_FAILURE_WINDOW_SECONDS`,
  `LOGIN_THROTTLE_SECONDS`.
- **Request limits**: `JSON_BODY_LIMIT_BYTES`, `MAX_URL_LENGTH`.
- **WebSocket**: `WS_MAX_CONNECTIONS_PER_USER`, `WS_MAX_FRAME_BYTES`,
  `WS_EVENT_WINDOW_MS`, `WS_EVENT_MAX`.
- **Media**: `MEDIA_MAX_BYTES`, `MEDIA_MAX_WIDTH/HEIGHT`, `MEDIA_MAX_PIXELS`.
- **Retention**: `SECURITY_EVENT_RETENTION_DAYS`,
  `OPERATIONAL_EVENT_RETENTION_DAYS` (audit logs are never pruned).
- **Observability**: `METRICS_ENABLED`, `METRICS_REQUIRE_AUTH` (keep auth on in
  production).

## 5. Database migrations

Migrations are plain SQL in `database/migrations/` and are **applied out of
band** at deploy time (not automatically on boot), so a rollout is deliberate:

```bash
# From a one-off task/job container with DATABASE_URL set:
node apps/backend/dist/src/db/migrate.js up      # if compiled
# or in a toolchain image:
npm run -w @luvora/backend migrate:up
```

Run migrations BEFORE routing traffic to a new version. They are idempotent and
tracked, so re-running is safe.

## 6. Health & readiness

- `GET /health` — cheap liveness (no DB dependency). Used by the container
  HEALTHCHECK and by load balancers for liveness.
- `GET /ready` — readiness: verifies DB reachability + schema; returns `503`
  until ready. Gate traffic on this. It never leaks connection strings/SQL.
- `GET /metrics` — Prometheus-format metrics (keep `METRICS_REQUIRE_AUTH=true`;
  scrape with an admin token). Values are per-process.

## 7. Backups

Schedule logical backups and test restores — see `docs/DISASTER_RECOVERY.md`
and `scripts/backup-db.sh` / `scripts/restore-db.sh`.

## 8. Scaling & honest limitations

- The API is stateless and horizontally scalable behind a load balancer.
- **Rate limiting / abuse control and metrics are process-local.** With N API
  instances, each enforces its own limits and reports its own metrics; they are
  NOT aggregated or globally enforced. For cluster-wide throttling you must add
  a shared backend (e.g. Redis) — the `AbuseBackend` seam marks where.
- Volumetric DDoS must be absorbed at the edge (CDN/WAF/LB); application limits
  are not a substitute.
- External push (FCM/APNs/WebPush) and distributed presence/realtime are
  unimplemented placeholders. Job execution is at-least-once.
