# Redis operations (Increment 12)

Luvora can use Redis as the shared backend for **abuse / rate-limit
coordination** across multiple API instances. This document is the operator's
guide: when Redis is needed, how it is deployed and secured, what happens when
it fails, and what to monitor.

> Redis is **optional**. The default `ABUSE_BACKEND=memory` is process-local and
> fine for development, tests, and single-instance deployments. Enable Redis
> only for multi-instance production, where process-local limits would NOT be
> globally enforced.

## Purpose — why Luvora uses Redis

With more than one API instance, a process-local limiter lets an attacker bypass
a limit by spreading requests across instances (each instance only sees its own
share). The Redis backend keeps the counters/windows and penalty blocks in one
shared place with **atomic** check-and-increment (a single server-side Lua
script), so limits — including login brute-force protection — are enforced
cluster-wide and cannot be raced.

Redis is used ONLY for ephemeral abuse state. It is **never** a source of truth
for users, matches, messages, media, notifications, moderation, or audit logs —
those live exclusively in PostgreSQL (see Backup/DR below).

## Production topology

```
          ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
 clients→ │  API inst 1 │   │  API inst 2 │   │  API inst N │
          └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
                 └─────────────────┼─────────────────┘
                                   ▼
                           ┌───────────────┐
                           │     Redis     │  (abuse state only, ephemeral)
                           └───────────────┘
                 all instances also share one PostgreSQL (source of truth)
```

Each instance opens ONE pooled Redis connection (not one per request) via the
shared ioredis client, with a bounded reconnect strategy.

## Configuration

| Variable | Meaning |
|---|---|
| `ABUSE_BACKEND` | `memory` (default) or `redis`. |
| `REDIS_URL` | Connection string (required when `redis`). Supports `rediss://` for TLS. Never logged. |
| `REDIS_KEY_PREFIX` | Namespace for all abuse keys (default `luvora`). `clear()` only ever touches this prefix — never `FLUSHALL`. |
| `ABUSE_REDIS_TIMEOUT_MS` | Per-op timeout (default 100). |
| `ABUSE_FAIL_POLICY` | `closed` (default/required in prod) or `open`. See Failure below. |
| `ABUSE_FINGERPRINT_SECRET` | HMAC key for fingerprinting identifiers before they become keys. Empty → derived from `JWT_ACCESS_SECRET`. |
| `READINESS_REDIS_TIMEOUT_MS` | Redis readiness PING timeout (default 1000). |

Production fail-fast refuses to boot when `ABUSE_BACKEND=redis` without a
`REDIS_URL`, with `ABUSE_FAIL_POLICY=open`, or with a weak dedicated
`ABUSE_FINGERPRINT_SECRET`.

## Key layout & privacy

Keys are namespaced and versioned, and contain only HMAC fingerprints — never a
raw IP, email, user id, token, or any secret:

```
<prefix>:abuse:v1:w:<scope>:<fingerprint>   sorted set  (sliding window)
<prefix>:abuse:v1:b:<scope>:<fingerprint>   string+TTL  (penalty block)
```

The fingerprint is `HMAC-SHA256(ABUSE_FINGERPRINT_SECRET, identifier)` truncated
to 20 hex chars. The secret is never logged. Key length is additionally bounded
defensively. This means a Redis compromise does not reveal who was limited.

## Security

- **Never expose Redis publicly.** Bind it to a private network / VPC only.
- **Require authentication** (`requirepass` / ACL user) and pass credentials via
  `REDIS_URL` — which this app never logs.
- **Use TLS** (`rediss://`) where supported, especially across any network
  segment you don't fully control.
- Restrict access with a **firewall / security group**; grant the API the
  **least privilege** needed (it only runs `EVAL`, `PTTL`, `DEL`, `SCAN`).
- **Rotate credentials** periodically; rotating `ABUSE_FINGERPRINT_SECRET`
  invalidates existing fingerprints (counters effectively reset — acceptable
  for ephemeral abuse state).
- The Redis password is never written to logs or metrics; diagnostics expose
  only `backend` + a status string.

## Failure behaviour

The app distinguishes availability from security:

- **`ABUSE_FAIL_POLICY=closed` (default, required in production):** when Redis is
  unavailable, security-critical counting checks are **denied** (fail closed) —
  a control that cannot verify must not wave traffic through. `/ready` reports
  `abuseBackend: error` and returns **503**, so a load balancer stops routing to
  an instance that cannot enforce limits. `/health` (liveness) stays OK — the
  process is alive and should not be killed.
- **`ABUSE_FAIL_POLICY=open`:** checks are allowed through on Redis error
  (availability over strict enforcement). Not permitted in production with the
  Redis backend.
- The app does **not** silently downgrade to the process-local backend when
  Redis was explicitly configured — that would be an invisible security
  downgrade. It keeps using the Redis client, which reconnects on its own.
- A probe (`blockedFor`) returns 0 on Redis error, so a transient blip never
  permanently locks a user out; the subsequent counting check applies the fail
  policy.
- Redis errors are logged with the error NAME only (no URL/credentials) and
  counted in `abuse_backend_errors_total` / `abuse_backend_fallbacks_total`.

## Monitoring

Watch these metrics (`/metrics`, Prometheus format; labels are bounded):

- `abuse_backend_requests_total{backend,op}` — call volume.
- `abuse_backend_errors_total{backend,op}` — Redis op failures (alert on a rate).
- `abuse_backend_fallbacks_total{policy}` — how often the fail policy engaged.
- `abuse_redis_rejections_total{scope}` — requests the distributed backend denied.
- `abuse_redis_latency_ms` — Redis round-trip latency histogram.

Also watch Redis itself (memory usage, connected clients, evictions) and the
admin diagnostic `GET /api/admin/abuse-backend` (`{ backend, status, failPolicy }`,
no connection details).

## Capacity & memory

Memory is self-bounding — no application sweep is needed:

- Window sorted sets carry a TTL equal to the window length (refreshed on each
  hit) and expired members are trimmed inside the Lua script.
- Penalty-block keys expire with the block (TTL = throttle seconds).
- Idle keys disappear on their own.

Peak key count ≈ (active distinct fingerprints per scope) × (number of scopes).
These are small, short-lived keys; a modest Redis (a few hundred MB) is ample
for typical traffic. Enabling a `volatile-ttl`/`allkeys-lru` eviction policy is a
safe extra guard, since all abuse keys are expendable.

## Recovery & DR interaction

Redis holds **ephemeral** abuse state only. If Redis is lost/restarted:

- No PostgreSQL (source-of-truth) data is affected. A Redis restore is **not**
  required to restore core application data (see `docs/DISASTER_RECOVERY.md`).
- Abuse counters and penalty blocks reset — i.e. in-flight throttles clear. This
  is acceptable: the protection resumes immediately on fresh traffic, and the
  durable `security_events` audit trail in PostgreSQL is unaffected.
- Do NOT configure Redis persistence expecting to preserve abuse state across
  restarts; it is intentionally disposable.

## Local development & testing

- Dev: `docker compose -f docker/docker-compose.yml up -d` starts PostgreSQL and
  an optional Redis (`redis://localhost:6379`); set `ABUSE_BACKEND=redis` +
  `REDIS_URL` to exercise it.
- Tests: `npm test` / `npm run verify` run with the memory backend and stay
  self-contained. `npm run verify:redis` boots an ephemeral Redis and runs the
  ENTIRE suite through the distributed backend. The Redis integration tests skip
  cleanly if no `redis-server` binary is present (we never pretend they ran).
- Live: `scripts/smoke-redis.sh` proves distributed brute-force, readiness, the
  admin diagnostic, and fail-closed behaviour end-to-end over HTTP.
