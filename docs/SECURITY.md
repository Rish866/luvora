# Security notes (Increment 1)

## Authentication & sessions
- Passwords hashed with bcrypt (`BCRYPT_ROUNDS`, default 12). Plaintext never
  stored or logged.
- Short-lived JWT **access** tokens (default 15 min).
- Opaque high-entropy **refresh** tokens; only a SHA-256 hash is stored, so a DB
  leak yields no usable tokens.
- Refresh **rotation with reuse detection**: using an already-rotated token
  revokes the entire token family (theft containment). Verified by test.
- Logout and per-user revocation supported.

## Age gate (18+)
- Enforced server-side from `dateOfBirth`, independent of the client checkbox.
- Also enforced by a PostgreSQL `CHECK` constraint on `users`.
- Architected so a stronger third-party age-assurance provider can be slotted in
  later without schema churn (fields already model attestation time).

## Authorization / IDOR
- Every session operation verifies the acting user is actually a participant;
  client-supplied IDs are never trusted as proof of access.
- Primary keys are non-enumerable UUIDs.
- Covered by tests: a non-participant guessing a session id gets `403`; only the
  invited player can accept; non-members cannot invite within a match.

## Consent privacy
- A player's private NO/MAYBE answers are never returned to the partner.
- Only the server-computed mutual allow-list is shared, and only after both
  confirm. Covered by an explicit test.

## Transport & HTTP
- `helmet` secure headers; strict CORS allow-list (empty by default).
- JSON body size limited (1 MB).
- Global + stricter auth-endpoint rate limiting (brute-force protection).
- Central error handler never leaks stack traces, SQL, or driver details.

## Logging
- Structured pino logs with redaction of `authorization`, `cookie`,
  `password`, `passwordHash`, `token`, `refreshToken`.

## Secrets
- All secrets come from env (`apps/backend/.env.*`), which is git-ignored.
  `.env.example` documents required keys with placeholder values only.
- `npm audit` reports some advisories in the dev/test toolchain (vite/esbuild
  via vitest, etc.); these are not shipped in the production runtime bundle.
  Track and update in the hardening increment.

## Chat & WebSocket security (Increment 3)
- **WebSocket authentication at the handshake:** the HTTP upgrade is rejected
  (`401`) unless a valid, non-revoked access token is presented (reusing the
  existing `verifyAccessToken` + live-user check). No unauthenticated socket is
  ever left open. Tokens are never logged.
- **Authorization on every action:** a single helper (`chatAuthorization`)
  verifies participant membership + `ACTIVE` match + no block (either
  direction) for history, send, read, and typing. Block is re-checked on every
  `message.send`, so a stale socket cannot bypass a block applied after connect.
- **Sender spoofing impossible:** the message sender is always the authenticated
  connection identity; client-supplied `senderId`/`id`/`userId` are ignored.
- **IDOR:** knowing a `matchId`/`conversationId` grants nothing; a non-participant
  gets the generic `CHAT_NOT_AUTHORIZED` (so block details never leak).
- **Persist-then-broadcast:** messages are written to PostgreSQL before any
  broadcast; the DB id is authoritative. `message.created` is routed only to the
  two participants' sockets — never a global broadcast.
- **Input validation:** malformed JSON, unknown event types, invalid UUIDs, and
  empty/oversized bodies yield a structured `error` event and never crash the
  process. REST + WS share one validated message service.
- **Rate limiting:** REST send reuses the project limiter; the WS gateway adds a
  per-connection sliding-window throttle.
- **Privacy:** message payloads expose only `id`, `conversationId`, `senderId`,
  `body`, `clientMessageId`, `createdAt`. Presence is partner-scoped (not global)
  and ephemeral. Message bodies are not logged.
- **Parameterized SQL** throughout the chat module; cursors are opaque and
  always passed as parameters.

## Fantasy engine security (Increment 4)
- **Server-authoritative gameplay:** clients submit only a `choiceId` (intent).
  The server resolves the next node, turn, and completion from the DB; request
  fields like `nextNodeId`/`turnNumber`/`scenarioVersionId` are never read, so a
  tampering client cannot jump to an arbitrary node or ending (tested).
- **Immutable versions:** a session pins one `scenario_version_id`; publishing a
  new version never mutates a running session. Referenced content is protected
  by `ON DELETE RESTRICT`.
- **Participant authorization (IDOR):** every gameplay endpoint and WS event is
  authorized against the session's match participants; a non-participant gets
  the generic `GAME_NOT_AUTHORIZED`. Knowing a session/scenario/choice id is
  never sufficient.
- **Choice integrity:** a submitted choice must belong to the session's CURRENT
  node (re-checked under the row lock) — choices from other nodes/scenarios/
  sessions are rejected (`INVALID_CHOICE`).
- **Consent re-evaluation:** consent requirements are re-checked at choice time
  using the ONE shared resolver (`resolveCompatibleCategories`). A choice is
  allowed only if every required category is in the mutual allow-list; the
  partner's individual responses are never exposed (only a per-choice
  `available` boolean).
- **Transactional, concurrency-safe, idempotent:** choice processing runs in a
  transaction with `SELECT … FOR UPDATE` + an optimistic `state_version` guard,
  so concurrent submissions advance the session exactly one turn. A
  `client_action_id` (UNIQUE per session+user) makes retries idempotent — no
  double-advance (tested, incl. concurrent duplicates).
- **Persist-then-broadcast:** game state is committed before any WS broadcast,
  which targets only the two participants (never global).
- **Reconnect:** `GET /api/sessions/:id/state` and `game.subscribe` return
  authoritative DB state, so clients recover without replaying events.
- **Input validation:** scenario/session/choice/action ids are UUID-validated;
  malformed WS frames and unknown event types return structured errors without
  crashing. All SQL parameterized; dynamic fragments are `$N` placeholders only.

## Media security (Increment 5)
- **Never trust the client:** declared MIME, filename, extension, Content-Length,
  and dimensions are all ignored for decisions. The server detects the real type
  via magic bytes (`file-type`) AND an independent `sharp` decode that must agree
  (defeats MIME/extension spoofing and polyglots), computes dimensions + SHA-256,
  and bounds pixels (decompression-bomb guard).
- **Privacy:** images are re-encoded (normalized); EXIF/GPS/XMP/ICC metadata is
  dropped (verified by a test that asserts the served output has no EXIF). The
  normalized image is stored/served — never the raw original. DTOs never expose
  storage keys, sha256, filenames, or detected-vs-declared internals.
- **Opaque storage + no path traversal:** storage keys are random
  (`media/<uuid>/original`), never derived from filenames; the local provider
  validates keys and refuses anything escaping its base dir.
- **Server-authoritative state:** clients cannot set `status`/`moderation_status`
  /dimensions. Only `READY`+`APPROVED` assets are usable; `REJECTED` and
  `QUARANTINED` (NEEDS_REVIEW / scanner UNKNOWN) are never downloadable or
  attachable.
- **Malware + moderation are real extension points** (`MediaScanner`,
  `MediaModerationProvider`). The bundled `TestMediaScanner` /
  `TestMediaModerationProvider` are deterministic DEV stubs and are **not** real
  protection — production wires ClamAV / a content-safety service without
  touching business logic. INFECTED ⇒ quarantine/reject; UNKNOWN ⇒ configurable
  (defaults to quarantine).
- **Authorization / IDOR:** `GET /api/media/:id` is authenticated and
  authorized; access = owner OR a participant of an attached conversation whose
  chat policy currently permits it. There is **no media path that bypasses chat
  blocking** — a block immediately revokes a recipient's media access (tested).
- **Transaction safety:** message + attachment rows commit atomically; a failed
  attachment validation rolls back the whole message (no partial state); WS
  broadcast only after commit; duplicate `clientMessageId` stays idempotent.
- **Delivery headers:** `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`; SVG/HTML are
  not allowed, so no inline-script rendering risk.
- **Abuse limits:** upload-intent / content / report endpoints are rate-limited;
  bytes are bounded by the raw-body limit (no unbounded buffering); attachments
  per message and total bytes are capped. All media SQL is parameterized.

## Admin / safety / moderation security (Increment 6)
- **Server-authoritative RBAC:** `role` and `account_status` live only in the DB.
  `requireAuth` loads them fresh on every request and populates `req.userRole`;
  `requireRole`/`requireModerator`/`requireAdmin` gate privileged routes. The role
  is NEVER read from the body, query, headers, or client-supplied JWT claims — a
  forged role field is ignored (tested).
- **Account-state enforcement everywhere:** a suspended/deactivated account is
  rejected at login, refresh, every authenticated HTTP request, the WebSocket
  handshake, AND on every inbound WS event — so a safety action takes effect
  immediately rather than waiting for token expiry. Expired suspensions
  auto-lapse to ACTIVE.
- **Session revocation on suspend/deactivate:** all `auth_sessions` are revoked
  (refresh tokens stop working) and all live `/ws/chat` + `/ws/game` sockets are
  force-closed (code 4403). Role changes also revoke sessions.
- **Admin safeguards:** cannot suspend/deactivate self; the last admin cannot be
  deactivated or demoted; moderators cannot change roles or run admin-only
  actions; invalid target ids never escalate privilege; safety actions are
  idempotent-friendly and recorded.
- **Report privacy:** reporter identity is never surfaced to the reported user;
  report targets are validated against the reporter's own visibility so reporting
  can't probe for the existence of private content; duplicate open reports are
  constrained.
- **Moderation transactions:** media moderation locks the row (`FOR UPDATE`),
  validates the transition, updates moderation+upload status consistently, and
  records a moderation action + audit entry atomically; concurrent decisions are
  serialized with no corruption (tested).
- **Append-only audit:** audit + moderation-action tables have no update/delete
  path in the application; audit metadata is sanitized (forbidden keys like
  password/token/authorization/body/storage_key are stripped; values bounded).
- **Block integrity preserved:** moderation/safety actions do not restore
  blocked user-to-user access; the Increment 5 media authorization (block-aware)
  is unchanged (tested).
- **Parameterized SQL** throughout; dynamic admin filters build only `$N`
  placeholders and fixed, allow-listed column/identifier names.
- **No admin backdoor:** the application contains no bootstrap endpoint, secret
  header, or magic account. The first admin is provisioned by an operator via a
  direct DB update (see docs/API.md "Production admin provisioning").

## Notifications & presence security (Increment 7)
- **Authoritative store, best-effort transport:** notifications live in
  PostgreSQL; the WebSocket `notification.created`/`presence.changed` events are
  an optimization only. A dropped or spoofed socket event cannot create, hide, or
  alter a notification — the REST feed/count/read-state remain the source of
  truth.
- **Minimal payloads (no sensitive data at rest or in transit):** stored
  notifications and their events carry only safe display fields plus an
  `entity_type`/`entity_id` *reference*. They never contain the chat message
  body, consent answers, media storage keys, the reporter/moderator identity, or
  the suspension reason (tested — message/fantasy/safety notifications are
  asserted not to leak these). The client re-fetches the referenced entity
  through the normal, re-authorized APIs.
- **Feed & read-state IDOR-safe:** every notification query/mutation is scoped to
  the authenticated user. Marking another user's notification read returns
  `404 NOTIFICATION_NOT_FOUND` (ownership is never confirmed via a different
  status), and `read-all` only touches the caller's rows (tested).
- **Preferences with a non-suppressible safety channel:** users may disable
  non-critical categories, but **SAFETY** cannot be disabled
  (`CRITICAL_PREFERENCE`) and the service bypasses the preference check for it —
  so a user can never silence suspension/safety notices, even by writing a
  disabled row directly in the DB (tested).
- **Deterministic dedup prevents notification storms / probing:** a unique
  partial index on `(user_id, dedupe_key)` plus `ON CONFLICT DO NOTHING` makes
  idempotent and concurrent triggers (resent messages, reciprocal-like races)
  collapse to a single notification.
- **Privacy-aware presence:** presence (both the API and the `presence.changed`
  fan-out) is visible only to `ACTIVE`-match partners with no block in either
  direction — the same relationship chat trusts. A non-observer gets a generic
  `403 PRESENCE_NOT_AUTHORIZED` that reveals neither account existence nor online
  status (tested for strangers and blocked matches). Presence exposes only
  `ONLINE`/`OFFLINE` + last-seen; socket/device counts are never surfaced.
- **Minimal persisted presence state:** only `users.last_seen_at` is stored, and
  only on the `ONLINE→OFFLINE` transition — there is no stale "online" flag that
  could survive a crash and no per-heartbeat write amplification.
- **Safety actions flip presence:** suspending a user force-closes their sockets
  (Increment 6), which drives them `OFFLINE` through the same registry path.
- **Parameterized SQL:** the notification repository builds only `$N`
  placeholders and fixed, allow-listed SQL fragments (the keyset/unread clauses);
  all user values pass as bound parameters.

## Notification delivery & presence security (Increment 8)
- **Device tokens are credentials.** The raw push token is stored only to call
  the provider; it is **never** returned by any API (user list, registration
  response, or the admin diagnostics view all expose only a short
  non-reversible fingerprint + metadata), and it is **never** logged (the only
  token-adjacent log field is `token_fingerprint`). Uniqueness/dedup use a
  SHA-256 hash, not the raw value.
- **Ownership, never client-supplied identity.** Device registration always
  binds to the authenticated caller; a `userId` in the body is ignored. Listing
  and revoking are scoped to the owner; an IDOR attempt returns an opaque
  `404 DEVICE_NOT_FOUND` so device ids cannot be probed. Roles are still read
  live from the DB, never from client input.
- **Minimal push payloads.** A push carries only `{type, notificationId,
  category, entityType, entityId}` — no title/body text, message content,
  consent answers, media storage keys, moderation details, suspension reason, or
  tokens (asserted by tests). The recipient re-fetches the real content through
  the authenticated feed.
- **Best-effort delivery never weakens persistence or safety.** Push/WebSocket
  delivery failures never roll back a notification and never throw into the
  caller. Account-state protections are preserved: the notification service
  still suppresses notifications for non-ACTIVE recipients (so a suspended user
  is not pushed to while inactive), while SAFETY notices are created before
  suspension exactly as in Increment 6/7.
- **SAFETY push is non-suppressible.** Push for the SAFETY category cannot be
  disabled (`CRITICAL_PREFERENCE`) and the service bypasses the push-preference
  check for it — even a directly-inserted disabled row cannot silence it
  (tested).
- **Idempotent, race-safe delivery.** Delivery rows are unique per
  `(notification, device, channel)` via a DB index + `ON CONFLICT DO NOTHING`;
  concurrent dispatch produces exactly one row (tested). Permanent (invalid
  token) failures revoke the device and never retry; temporary failures retry
  under a bounded cap (max 5) — no infinite loops.
- **Sanitized provider errors.** Only a short, token-free, uppercased error
  code is persisted (`last_error_code`); full provider responses and credentials
  are never stored. Provider credentials are read from config/secret manager and
  never committed.
- **Presence privacy preserved + crash-safe.** The heartbeat/TTL reaper flips a
  user OFFLINE when their connection goes stale, but presence visibility is
  unchanged: only ACTIVE-match, non-blocked observers see it, strangers get a
  generic `PRESENCE_NOT_AUTHORIZED`, and no IP / device / socket-count /
  connection-id / backend-instance is ever exposed.
- **No fake production providers.** `FcmPushProvider`/`ApnsPushProvider` and the
  distributed presence/bus classes are interface placeholders that fail safe or
  degrade to the local implementation; they contain no SDK, credentials, or
  network calls and never pretend to deliver.
- **Parameterized SQL** throughout the delivery/device repositories (bound `$N`
  parameters only; no interpolation of user data).

## Background job security (Increment 9)
- **Server-controlled jobs only.** There is no API path for a client to enqueue
  a job or choose a job type/payload — only trusted server code calls the job
  service. Job types are a fixed enum.
- **No secrets in payloads.** Enqueued payloads carry only ids/flags (e.g.
  `{ notificationId }`); they never contain tokens, passwords, JWTs, refresh
  tokens, raw push tokens, message bodies, consent values, or media storage
  keys. The push-delivery handler re-loads everything it needs by id.
- **Redacted diagnostics.** Admin job endpoints return only a `payloadSummary`
  with sensitive keys stripped (token/password/secret/authorization/refresh/
  body/consent/storage/credential/email) and values bounded; the raw payload is
  never serialized to a client. Job diagnostics are ADMIN-only (moderators and
  normal users get 403; unauthenticated 401).
- **Sanitized errors.** Provider/handler error messages are reduced to a short,
  uppercase, token-free code plus a bounded message before being persisted or
  logged — full provider responses are never stored.
- **Safe logging.** Worker logs include job id / type / worker id / attempt /
  duration / sanitized error code only — never payloads, tokens, bodies, or
  credentials.
- **Parameterized SQL.** The job repository builds only `$N` placeholders and
  fixed, allow-listed SQL fragments (status/type filters, keyset); every
  user/caller value is a bound parameter. Concurrency uses PostgreSQL locking
  (`FOR UPDATE SKIP LOCKED`), not in-memory guarantees.
- **No privilege path via jobs.** Jobs cannot bypass RBAC/account-state: the
  push-delivery handler re-checks the recipient's account state (routine push is
  withheld from a non-ACTIVE account; SAFETY is the deliberate exception) and the
  push preference (SAFETY bypasses it and is never suppressible).
- **At-least-once, honestly.** Execution is at-least-once; handlers are
  idempotent and the `notification_deliveries` unique constraint remains the
  authoritative guard against duplicate database deliveries. Duplicate external
  push on a crash-after-send is possible and is not claimed to be exactly-once.

## Observability & operational security (Increment 10)
- **Correlation ids are untrusted + bounded.** An inbound `X-Correlation-Id` is
  accepted only if it matches a strict charset (alphanumerics + `._:-`) and is
  ≤ 128 chars; anything else (incl. newlines/control chars — log-injection
  attempts) is rejected and a fresh random id is generated. The id is never used
  for authorization.
- **Telemetry is best-effort, never a reliability dependency.** A metrics,
  logging, or operational-event failure never fails or alters a request —
  recording is wrapped and swallowed. Observability can degrade without taking
  the API down.
- **No sensitive data in logs/metrics/events.** The structured logger drops
  forbidden fields (tokens/passwords/authorization/bodies/consent/storage keys)
  and serializes errors to a bounded name+message (never a raw Error object);
  pino redaction is a second layer. Metrics labels are a bounded, server-
  controlled set (route templates with `:id`, status class, channel, job type)
  with a hard per-metric series cap, so an attacker cannot explode cardinality
  or cause unbounded memory growth, and `/metrics` emits only registered metric
  names — no PII, tokens, SQL, or payloads. Operational-event metadata is
  sanitized (flat safe scalars; sensitive keys dropped; key/value bounded).
- **`/metrics` is not public by default.** It is gated by `METRICS_ENABLED`
  (disabled ⇒ 404) and `METRICS_REQUIRE_AUTH` (default true ⇒ requires an ADMIN
  access token).
- **Health/readiness never leak internals.** No connection strings, SQL,
  filesystem paths, credentials, or stack traces appear in `/health` or
  `/ready`; the DB-health snapshot exposes only pool counts + utilization.
- **Admin job operations respect existing authorization.** Retry/cancel/dead-
  letter/operational-event endpoints require ADMIN (moderators and users get
  403; unauthenticated 401), are IDOR-opaque (`JOB_NOT_FOUND`), and never return
  a raw job payload (redacted `payloadSummary` only). Every operational action
  writes an append-only audit record AND a durable operational event.
- **Safe, honest job mutation.** Retry only requeues a DEAD job (never reruns a
  SUCCEEDED job or duplicates a RUNNING one), preserving idempotency; cancel
  refuses a RUNNING job rather than claiming to have killed an in-flight
  external call. Queue backpressure never silently drops SAFETY/critical jobs.
- **Parameterized SQL.** The operational-event repository builds only `$N`
  placeholders and fixed, allow-listed fragments; all values are bound.

## Known gaps (planned for later increments)
- Email/phone verification flow (fields exist; sending not wired).
- **Distributed metrics aggregation** is NOT implemented — metrics are
  process-local; aggregating across multiple server/worker processes needs a
  future scrape/aggregation layer (e.g. a Prometheus server scraping each
  `/metrics`). No APM vendor (Datadog/New Relic) is integrated.
- **Real push delivery** (FCM / APNs / Web Push) — the provider abstraction,
  device registry, delivery tracking, durable job-driven delivery, retry, and
  token revocation all ship, but the concrete FCM/APNs/Web-Push adapters are
  placeholders (no SDK, no credentials, no network). Only the TEST/DISABLED
  providers run today.
- **Exactly-once external push** is NOT provided — job execution is at-least-once
  (see above). No Redis / BullMQ / Kafka / RabbitMQ; multi-worker scaling is
  bounded by PostgreSQL row-locking against one database.
- **Distributed presence and cross-instance realtime** — the `PresenceBackend`
  and `RealtimeBus` abstractions ship, but the shared-store (e.g. Redis)
  implementations are placeholders that degrade to the in-process versions.
  Multi-instance deployment requires wiring those. Redis is never a required
  dependency and is not used by any test.
- A moderation/admin UI (this increment is backend/API only).
- **Production media providers:** real S3/R2 storage adapters, a real malware
  scanner (ClamAV/cloud), and a real content-safety moderation provider — the
  interfaces exist; only local/test implementations ship today. Signed-URL
  issuance is stubbed in the local provider (the app serves bytes through its own
  authenticated endpoint).
- **Fantasy-session user media** remains deferred (no gameplay attachment point).
- No MFA for admin accounts yet (would layer on the existing auth system).
- Full load testing.

---

## Production security hardening (Increment 11)

### Abuse control & brute force
- A single process-local primitive, `AbuseGuard`, backs all abuse-sensitive
  surfaces: sliding-window counting keyed by an opaque `scope:key`, **bounded
  memory** (LRU eviction + periodic sweep — no unbounded Map), penalty blocks,
  and an injectable clock for deterministic tests. It has its own
  `ABUSE_GUARD_ENABLED` switch so throttling is exercised even under test.
- **Login** is protected by a dual-dimension (client IP + target account)
  TEMPORARY throttle — deliberately NOT a permanent lockout, which could be
  weaponised for DoS against a victim account. The gate runs BEFORE the bcrypt
  comparison, removing hashing as an amplification vector; a successful login
  clears both dimensions.
- Applied to write/action endpoints too (discovery like/pass, block, chat send,
  fantasy invite), keyed by user so it is effective regardless of the legacy
  limiter's test behaviour.
- **Honest limitation:** this is **process-local**. With multiple API instances,
  each enforces its own limits — it is NOT global/distributed throttling. The
  `AbuseBackend` interface marks where a shared backend (e.g. Redis) would plug
  in; only the in-memory backend is implemented.

### CORS, headers, request limits
- Strict CORS allowlist (`CORS_ALLOWED_ORIGINS`): normalized, credentials
  allowed, never a wildcard. Disallowed origins receive no CORS headers.
- Centralized security headers: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a minimal
  `Permissions-Policy`, an API CSP (`default-src 'none'`), no `X-Powered-By`,
  and opt-in HSTS.
- Request input limits: configurable JSON body size and URL length (both →
  `413 PAYLOAD_TOO_LARGE`); `trust proxy` bounded by `TRUST_PROXY_HOPS` so
  `X-Forwarded-For` cannot be forged.

### WebSocket & media
- WS: per-user concurrent-connection cap (close code `4429`), inbound
  frame-size limit (`maxPayload`), and a config-driven per-connection event
  throttle, all with rejection metrics.
- Media: explicit decompression-bomb / oversized-dimension reject
  (`MEDIA_MAX_PIXELS`) with a precise error + metric, layered on the existing
  byte / per-dimension / dual-MIME-detection checks and EXIF stripping.

### Config fail-fast
- In `NODE_ENV=production` the app refuses to boot with weak/dev JWT secrets
  (< 32 chars or dev-looking), equal access/refresh secrets, `BCRYPT_ROUNDS < 10`,
  an empty or wildcard CORS allowlist, or `DEVELOPER_MODE=true`. It logs the
  offending variable NAMES and a safe reason — never a secret value.

### Durable security events
- `security_events` records LOW-VOLUME, significant events only (brute-force
  lockout, login throttle, refresh-token reuse). High-frequency counters stay
  in-process (AbuseGuard) to avoid self-DoS on the database.
- The client source is stored ONLY as a **salted, truncated 16-char
  fingerprint** (salt derived from an existing secret, never logged) — the raw
  IP is never persisted or returned. Metadata is sanitized (sensitive keys
  dropped, values bounded). Recording is best-effort and never breaks a request.
- Pruned by the existing `BACKGROUND_JOB_CLEANUP` job
  (`SECURITY_EVENT_RETENTION_DAYS`); audit logs remain append-only. Readable via
  admin-only `GET /api/admin/security-events`.

### Deployment
- Production multi-stage, non-root `Dockerfile`; `scripts/backup-db.sh` /
  `scripts/restore-db.sh` (credentials only via `DATABASE_URL`); and the
  `THREAT_MODEL`, `DEPLOYMENT`, `DISASTER_RECOVERY`, and
  `PRODUCTION_SECURITY_CHECKLIST` docs.

---

## Distributed abuse control & dependency remediation (Increment 12)

### Distributed abuse backend
- The abuse abstraction now has two interchangeable backends behind one async
  `AbuseBackend` interface: `InMemoryAbuseBackend` (process-local, default) and
  `RedisAbuseBackend` (distributed). Selected by `ABUSE_BACKEND`. Application
  code depends only on `AbuseGuard` → `AbuseBackend`, never on Redis directly.
- **Atomicity:** the Redis backend performs check-and-increment in a single
  server-side Lua script, so concurrent requests across multiple instances
  cannot race past the limit. Proven by tests that fire 20 concurrent requests
  across two independent clients/processes against a shared Redis and observe
  **exactly** the limit allowed.
- **Login brute force is now distributed:** with `ABUSE_BACKEND=redis`, the
  per-IP and per-account failure limits are enforced across ALL instances — an
  attacker alternating requests between instances cannot bypass them. Verified
  by a two-instance test and an end-to-end HTTP smoke.
- **Key privacy:** the guard HMAC-fingerprints every identifier (IP / email /
  user id) BEFORE it becomes a backend key, so no raw PII is ever stored in
  Redis. Keys are namespaced + length-bounded; the fingerprint secret and the
  Redis URL are never logged.
- **Fail policy:** `ABUSE_FAIL_POLICY=closed` (default, required in production)
  denies security-critical checks when Redis is unavailable and flips `/ready`
  to 503 — the app never silently downgrades distributed protection to
  process-local. `open` trades enforcement for availability and is forbidden in
  production with the Redis backend. A probe failure never causes a permanent
  lockout.
- **Honest limitation:** WebSocket per-connection *event* throttling and
  per-user *connection* caps remain process-local by design — routing every
  high-frequency ephemeral WS event through Redis would add a network round-trip
  per message for little security gain. The security-significant surfaces
  (login, registration, discovery/chat/invite actions, reports, devices) use the
  shared abstraction and are distributed when Redis is configured.

### Dependency security remediation
- `sharp` upgraded `0.33.5 → 0.35.5` (patched libvips/libheif CVEs) and
  `file-type` `16.5.4 → 21.3.4` (fixes the ASF-parser infinite-loop advisory).
  `file-type` v21 is ESM-only and is loaded via a dynamic import from the
  CommonJS build (works on the Node 22 runtime via `require(esm)`).
- **`npm audit --omit=dev` → 0 vulnerabilities** (the production image installs
  only prod deps). The remaining `npm audit` findings are all in dev-only
  tooling (vitest/esbuild/vite/ts-node-dev) that is never shipped in the image.
- The media pipeline's accepted formats are unchanged (JPEG/PNG/WebP only); the
  upgrade did NOT enable HEIF/AVIF. All media security tests (dual-MIME
  detection, pixel caps, EXIF stripping, thumbnails, malformed rejection) pass.

See `docs/REDIS_OPERATIONS.md` for the operator guide (topology, security,
failure behaviour, monitoring, capacity, DR interaction).