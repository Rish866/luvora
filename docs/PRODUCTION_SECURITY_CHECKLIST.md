# Production security checklist (Increment 11)

Run through this before exposing the Luvora backend to the public internet.
Items marked **(enforced)** are checked automatically by the production
fail-fast at boot; the rest are operational responsibilities.

## Secrets & configuration
- [ ] `NODE_ENV=production`.
- [ ] `JWT_ACCESS_SECRET` is strong (≥ 32 chars, random) **(enforced)**.
- [ ] `JWT_REFRESH_SECRET` is strong and DIFFERENT from the access secret **(enforced)**.
- [ ] `BCRYPT_ROUNDS` ≥ 10 (12 recommended) **(enforced)**.
- [ ] `DEVELOPER_MODE=false` **(enforced)**.
- [ ] Secrets are injected from the environment / a secrets manager — never
      committed to the repo or baked into the image.

## Transport & network
- [ ] TLS terminated in front of the app (LB/ingress/CDN).
- [ ] `TRUST_PROXY_HOPS` set to the exact number of trusted proxies (so `req.ip`
      is correct and `X-Forwarded-For` cannot be forged).
- [ ] `HSTS_ENABLED=true` (with a sane `HSTS_MAX_AGE_SECONDS`) once HTTPS-only.
- [ ] An edge WAF/CDN absorbs volumetric DDoS (app-layer limits are not enough).

## CORS
- [ ] `CORS_ALLOWED_ORIGINS` is an explicit allowlist of your real origins **(enforced: non-empty, no wildcard)**.
- [ ] No wildcard origin with credentials.

## Authentication & abuse control
- [ ] Login brute-force throttle tuned (`LOGIN_MAX_FAILURES`,
      `LOGIN_FAILURE_WINDOW_SECONDS`, `LOGIN_THROTTLE_SECONDS`).
- [ ] `ABUSE_GUARD_ENABLED=true`; `ABUSE_GUARD_MAX_KEYS` sized for your traffic.
- [ ] Legacy limiter budgets (`RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`,
      `DEVICE_RATE_LIMIT_MAX`) set to production values.
- [ ] **Multi-instance?** Set `ABUSE_BACKEND=redis` with `REDIS_URL`,
      `ABUSE_FAIL_POLICY=closed`, and a strong `ABUSE_FINGERPRINT_SECRET` — the
      default `memory` backend is process-local and does NOT enforce limits (or
      login brute-force protection) across instances. See
      `docs/REDIS_OPERATIONS.md`.
- [ ] Redis (if used) is on a private network with auth/TLS, never public;
      `/ready` returns 503 (fail-closed) when Redis is unavailable.

## Request / WebSocket / media limits
- [ ] `JSON_BODY_LIMIT_BYTES` and `MAX_URL_LENGTH` set appropriately.
- [ ] `WS_MAX_CONNECTIONS_PER_USER`, `WS_MAX_FRAME_BYTES`, `WS_EVENT_WINDOW_MS`,
      `WS_EVENT_MAX` tuned.
- [ ] `MEDIA_MAX_BYTES`, `MEDIA_MAX_WIDTH/HEIGHT`, `MEDIA_MAX_PIXELS` tuned.

## Headers
- [ ] Verified responses carry `X-Content-Type-Options`, `X-Frame-Options:
      DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, and the API
      CSP; `X-Powered-By` is absent. (Covered by tests + live smoke.)

## Data protection & privacy
- [ ] `security_events` store only salted fingerprints — no raw IPs (built-in).
- [ ] Error responses leak no stack traces/SQL/connection strings (built-in).
- [ ] DTOs expose no internal fields (tokens, hashes, storage keys) (built-in).
- [ ] Retention configured: `SECURITY_EVENT_RETENTION_DAYS`,
      `OPERATIONAL_EVENT_RETENTION_DAYS`. Audit logs are append-only (never pruned).

## Database & operations
- [ ] Migrations applied out-of-band BEFORE routing traffic to a new version.
- [ ] Least-privilege DB credentials; DB not publicly reachable.
- [ ] Automated backups scheduled AND a restore has been tested
      (`docs/DISASTER_RECOVERY.md`).
- [ ] Readiness-gated rollout (`/ready`), liveness (`/health`) wired to the
      orchestrator.
- [ ] Metrics scraped with `METRICS_REQUIRE_AUTH=true`; logs shipped centrally.

## Container
- [ ] Image runs as the non-root `node` user (built-in).
- [ ] Only production dependencies in the runtime image (built-in).
- [ ] `npm audit` reviewed. The production image (`--omit=dev`) carries two
      **`npm audit --omit=dev` → 0 vulnerabilities** (Increment 12 upgraded
      `sharp` 0.33.5→0.35.5 and `file-type` 16→21.3.4, remediating the former
      media-pipeline advisories). The remaining `npm audit` findings
      (`vitest`/`esbuild`/`vite`/`ts-node-dev`) are **dev-only** and are not
      shipped in the production image (`npm ci --omit=dev`). Still do NOT run
      `npm audit fix --force` (it would force-bump dev tooling to breaking
      majors). Accepted media formats remain JPEG/PNG/WebP only — the sharp
      upgrade did NOT enable HEIF/AVIF.

## Known limitations (acknowledge, don't paper over)
- [ ] Rate limiting is distributed ONLY when `ABUSE_BACKEND=redis`; the default
      is process-local. Metrics remain process-local. WebSocket event/connection
      limits are process-local by design.
- [ ] External push (FCM/APNs/WebPush) are unimplemented placeholders.
- [ ] Distributed presence/realtime are placeholders; jobs are at-least-once.
- [ ] No frontend/Android client in this repository.
