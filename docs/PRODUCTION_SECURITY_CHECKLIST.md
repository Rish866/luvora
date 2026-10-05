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
- [ ] Understood: these are **process-local** — add a shared backend (e.g.
      Redis) if you need cluster-wide enforcement.

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
      runtime advisories in the media pipeline: **sharp** (libvips/libheif CVEs)
      and **file-type** (ASF-parser infinite loop). Both fixes exist only in
      breaking major upgrades (`sharp@0.35`, `file-type@22`); we are on the
      latest within the current majors (`sharp@0.33.5`, `file-type@16.5.4`). The
      vulnerable HEIF/ASF code paths are **not reachable** with Luvora's strict
      allowlist (only JPEG/PNG/WebP, dual magic-byte + sharp agreement) plus the
      pixel-count cap and `failOn: "error"`. Treat the major upgrades as a
      planned, separately-tested follow-up — do NOT run `npm audit fix --force`
      as part of this pass. The other audit findings (`@vitest/mocker`,
      `esbuild`, `braces`) are **dev-only** and are not shipped in the image.

## Known limitations (acknowledge, don't paper over)
- [ ] Process-local rate limiting / metrics (no distributed enforcement).
- [ ] External push (FCM/APNs/WebPush) are unimplemented placeholders.
- [ ] Distributed presence/realtime are placeholders; jobs are at-least-once.
- [ ] No frontend/Android client in this repository.
