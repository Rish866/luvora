# Threat model (Increment 11)

A pragmatic STRIDE-style threat model for the Luvora backend. It documents the
assets, trust boundaries, the threats we actively mitigate, and — honestly — the
threats that are only partially addressed or out of scope.

## Assets

- **User credentials & sessions** — passwords (bcrypt hashes only), JWT access
  tokens, opaque refresh tokens (SHA-256 hash stored).
- **Personal / sensitive content** — profiles, chat messages, media, fantasy
  session consent + gameplay state. This is an 18+ product; consent data is
  especially sensitive.
- **Moderation & safety data** — reports, moderation actions, audit logs.
- **Operational integrity** — the durable job queue, security/operational
  events, the database itself.

## Trust boundaries

1. **Client ↔ API** (public internet). Everything from the client is untrusted:
   bodies, query params, headers, WebSocket frames, declared MIME/size.
2. **API ↔ database** (private). PostgreSQL is trusted but reached only via
   parameterized queries.
3. **API ↔ reverse proxy / TLS terminator**. `trust proxy` is bounded by
   `TRUST_PROXY_HOPS` so `X-Forwarded-For` cannot be spoofed by clients.
4. **API ↔ external providers** (push, media scan/moderation). Currently TEST/
   DISABLED providers; real providers would introduce an outbound boundary.

## STRIDE summary

### Spoofing (identity)
- JWT access tokens verified on every request; refresh tokens are opaque and
  only their SHA-256 hash is stored. Refresh **rotation with reuse detection**
  revokes the whole token family on replay (recorded as a `REFRESH_TOKEN_REUSE`
  security event).
- WebSocket upgrades are authenticated once (Bearer header or `?access_token`);
  the connection's verified userId is authoritative — client-supplied ids are
  never trusted for authorization.
- **Login brute force / credential stuffing**: dual-dimension (IP + account)
  temporary throttle that runs before the password hash comparison.

### Tampering
- All SQL is parameterized (no string-built queries). Verified by a repo scan.
- Media is re-encoded server-side; declared vs detected MIME must agree; EXIF/
  GPS metadata is stripped.
- Request bodies/URLs are size-bounded; oversized input is rejected early.

### Repudiation
- Sensitive moderation/admin mutations are **audit-logged** (append-only, never
  pruned). Security-relevant automated events (brute-force lockout, throttle,
  token reuse) are recorded in `security_events` with a correlation id.

### Information disclosure
- The error handler returns a standard envelope and NEVER leaks stack traces,
  SQL, driver messages, or connection strings; unknown errors become an opaque
  500.
- DTOs omit internal fields (storage keys, hashes, raw tokens, password hashes).
- `security_events` stores the client source only as a **salted, truncated
  fingerprint** — never the raw IP — so the table cannot be used to deanonymise
  or track users. The salt derives from an existing secret and is never logged.
- Strict CORS allowlist (no wildcard with credentials) limits cross-origin
  reads; `Referrer-Policy: no-referrer` prevents URL leakage.

### Denial of service
- Process-local abuse control (`AbuseGuard`) with **bounded memory** (LRU +
  sweep) on login and write/action surfaces.
- WebSocket per-user connection cap + inbound frame-size limit + event throttle.
- Media decompression-bomb defence (pixel-count cap + sharp input limits).
- Request body/URL size limits.
- The durable job queue has backpressure/queue-depth guards (Increment 9/10).

### Elevation of privilege
- Role (USER/MODERATOR/ADMIN) comes only from the authenticated DB record,
  never from client input. Admin/moderator routes enforce RBAC server-side.
- IDOR defences: participants-only checks on matches/sessions/conversations;
  non-enumerable UUID primary keys.

## Explicitly partial / out-of-scope (honest limitations)

- **Distributed enforcement**: rate limiting / abuse control is **process-local**.
  With multiple API instances, each enforces its own limits — this is NOT global
  throttling. A shared backend (e.g. Redis) is required for cluster-wide
  enforcement; the `AbuseBackend` interface marks the seam. Not implemented.
- **DDoS / volumetric attacks**: must be handled at the edge (CDN/WAF/LB). The
  application-layer limits here are not a substitute.
- **External push security** (FCM/APNs/WebPush): unimplemented placeholders;
  no real outbound delivery in this repo.
- **Secrets management**: secrets come from the environment. Integrating a
  secrets manager (Vault/SSM/etc.) is a deployment concern, not implemented
  here beyond the production fail-fast that rejects weak/dev secrets.
- **At-least-once jobs**: job execution is at-least-once; exactly-once external
  side effects are NOT claimed.
- **No frontend/Android client** exists in this repository.
