# Build roadmap (incremental)

This platform is being built incrementally so each layer is **verified working**
before the next is added. Below is the plan and current status.

## ✅ Increment 1 — Backend foundation (DONE)

- Monorepo scaffold (npm workspaces): `apps/backend/`, `packages/shared/`,
  `database/`, `docker/`, `docs/`, `scripts/`.
- PostgreSQL schema + forward migration runner (core models).
- Local Postgres via Docker (`docker/docker-compose.yml`).
- Auth: register / login / logout, bcrypt hashing, JWT access tokens,
  opaque refresh tokens with **rotation + reuse/theft detection**, session
  revocation, request validation (zod), rate limiting, brute-force limits.
- **Server-side 18+ age gate** — enforced from date of birth, not just a
  client checkbox; also enforced by a DB `CHECK` constraint.
- **Server-authoritative consent + session state machine**:
  - strict transition table (`shared/src/stateMachine.ts`);
  - consent compatibility resolver where a category is allowed only if BOTH
    players said YES;
  - **privacy invariant**: a player's private NO/MAYBE answers are never
    exposed to the partner — only the computed allow-list is shared.
- Health/readiness endpoints, structured logging, consistent error envelope.
- 27 passing tests (unit + integration) run against a real PostgreSQL,
  including consent-privacy and IDOR-authorization security tests.

## ✅ Increment 2 — Discovery & matching (DONE)

- **Discovery feed** (`GET /api/discovery`) — database-driven, keyset
  (cursor) pagination with a deterministic `(created_at, id)` order. Excludes,
  entirely in SQL: self, already-liked, already-passed, blocks in **both**
  directions, existing matches, and ineligible (disabled/deleted/non-
  discoverable) accounts. Returns a discovery-safe DTO only.
- **Like / Pass** (`POST /api/discovery/:userId/{like,pass}`) — one decision
  per `(actor, target)` via upsert; LIKE↔PASS converts in place (no
  contradictory rows); idempotent.
- **Mutual matching** — a match is created **only by the server** on reciprocal
  likes, inside a transaction with `ON CONFLICT` on the canonical pair, so
  concurrent reciprocal likes yield **exactly one** match (race-safe).
- **Block / Unblock** (`POST`/`DELETE /api/users/:userId/block`) — idempotent;
  block removes the pair from discovery both ways, rejects new likes, and sets
  any existing match to `BLOCKED`. Unblock never recreates a match or restores
  old likes.
- **Match list + detail** (`GET /api/matches`, `GET /api/matches/:matchId`) —
  participant-only; detail enforces authorization so match-ID enumeration can't
  reveal another user's relationship.
- Reuses Increment 1 auth, age gate, error envelope, and the existing
  `likes`/`matches`/`blocks` schema. New migration `0002` adds only supporting
  **indexes** (no table redesign).
- 45 new tests (incl. a concurrent-reciprocal-like race test and privacy
  assertions). **Total: 72 passing** against real PostgreSQL. Live HTTP smoke:
  43/43.

## ✅ Increment 3 — Private chat + WebSockets (DONE)

- **One conversation per `ACTIVE` match**, created lazily and race-safely
  (`UNIQUE(match_id)` + `ON CONFLICT`). Append-only `messages`; compact per-user
  `conversation_read_state`. Migration `0003_chat.sql`.
- **REST** (`GET`/`POST /api/matches/:matchId/messages`): keyset-paginated
  history (oldest→newest), send with server-generated id, 4000-code-point limit,
  empty/oversized rejection, `clientMessageId` idempotency.
- **WebSocket gateway** on the same HTTP port at `/ws/chat`, authenticated at
  the handshake via the existing access token (header or `?access_token`).
  Events: `connection.ready`, `message.send`/`message.created`,
  `message.read`, `typing.start`/`typing.stop` → `typing`, `error`,
  `chat.blocked`. Discriminated-union protocol types live in
  `packages/shared/src/chat.ts`.
- **Single message service** shared by REST + WS, so authorization, validation,
  and persist-then-broadcast behave identically. Sender identity always comes
  from the authenticated connection; client-supplied ids are ignored.
- **Central authorization helper** (participant + ACTIVE match + no block in
  either direction) reused by history, send, read, typing. Block is
  **re-checked on every send**, so a block takes effect immediately on existing
  sockets; `chat.blocked` is pushed to live connections.
- Multi-socket-per-user delivery, in-memory connection registry keyed by
  verified user id, heartbeat/dead-socket cleanup, graceful shutdown closes
  WS + HTTP + pool. Presence/typing are ephemeral (not persisted); WebSocket
  state is **process-local** (shared pub/sub deferred to Increment 8).
- 36 new tests (19 chat REST + 17 real WebSocket). **Total: 108 passing**
  against real PostgreSQL. Live smoke: 58/58 (incl. a real two-socket WS flow).

## ✅ Increment 4 — Data-driven fantasy engine (DONE)

- **Data-driven scenario library** (migration `0004_fantasy_engine.sql`):
  `scenarios → scenario_versions → scenario_nodes → scenario_choices →
  scenario_choice_requirements`. Content is data, not code.
- **Immutable scenario versions:** a session pins one `scenario_version_id`;
  publishing a new version never mutates a running session. Referenced content
  is `ON DELETE RESTRICT`.
- **Scenario library API** (`GET /api/scenarios`, `GET /api/scenarios/:id`):
  published-only, keyset-paginated, draft/authoring data never exposed.
- **Server-authoritative gameplay** on `fantasy_sessions` (extended with
  `scenario_version_id`, `current_node_id`, `turn_number`, `state_version`,
  `started_at`, `completed_at`): select scenario → START node → choose → branch
  → ending → COMPLETED. Clients submit only a choice id; the server resolves the
  next node, turn, and completion.
- **Consent re-evaluation at choice time** via the single shared resolver;
  per-choice `available` only — partner responses never exposed.
- **Transactional, concurrency-safe, idempotent:** `SELECT … FOR UPDATE` +
  optimistic `state_version` so concurrent submissions advance exactly one turn;
  `session_actions` + `client_action_id` make retries idempotent.
- **Gameplay WebSocket** `/ws/game` on the same port via a shared upgrade
  dispatcher (coexists with `/ws/chat`): `game.ready`, `game.subscribe` →
  `game.state`, `game.choose` → `game.state.changed` / `game.completed`,
  `game.error`. Persist-then-broadcast to both participants; `subscribe` returns
  authoritative DB state (reconnect-safe).
- ~5 seeded non-graphic demo scenarios (linear, branching, consent-gated,
  multiple endings) seeded idempotently.
- 32 new tests (23 engine + 9 game WS) incl. branching, endings, consent gating,
  idempotency, concurrency, and IDOR. **Total: 140 passing** against real
  PostgreSQL. Live smoke: 75/75 (incl. a real `/ws/game` two-socket flow).

## ✅ Increment 5 — Secure media, attachments & moderation (DONE)

- **Provider-independent storage** (`MediaStorage` interface + `LocalMediaStorage`;
  S3/R2 adapters are a future drop-in). No cloud credentials in dev/test.
- **Two-step upload** (`POST /api/media` intent → `PUT /api/media/:id/content`)
  with a real pipeline: magic-byte + `sharp` decode detection, declared-vs-
  detected MIME agreement, dimension/decompression-bomb limits, SHA-256,
  malware scan, **EXIF/GPS-stripping normalization**, thumbnail generation,
  content moderation. Only `READY`+`APPROVED` becomes usable.
- **Media + moderation state machines** (`UPLOADING…READY/QUARANTINED/REJECTED/
  DELETED`; `PENDING/APPROVED/REJECTED/NEEDS_REVIEW`), server-controlled.
- **Scanner & moderation abstractions** (`MediaScanner`,
  `MediaModerationProvider`) with deterministic DEV stubs clearly documented as
  NOT production protection; INFECTED⇒quarantine, UNKNOWN⇒configurable.
- **Chat attachments**: `attachmentIds` on message send (REST + `/ws/chat`),
  validated + linked transactionally, safe `attachments` DTOs in history and the
  `message.created` broadcast. Attachment-only messages allowed.
- **Centralized media authorization** reusing the chat policy — owner or a
  participant of an attached conversation with an ACTIVE, non-blocked match. A
  block immediately revokes recipient media access (no bypass).
- **Report** endpoint (controlled reasons, duplicate-throttled, reporter never
  exposed, sensitive reports quarantine). **Delete** = owner-only soft delete.
  **Orphan cleanup** function for abandoned uploads (scheduler-callable).
- Migration `0005_media.sql` (`media_assets`, `message_attachments`,
  `media_reports`). Private delivery headers (`no-store`, `nosniff`).
- 48 new tests (media upload/privacy/malware/moderation/IDOR/delete/report/
  cleanup + chat attachments + WS attachments). **Total: 188 passing** against
  real PostgreSQL. Live smoke: 85/85 (incl. a real end-to-end media flow:
  upload → attach → WS receive → authorized download → IDOR → block).

**Deferred:** production S3/R2 + ClamAV + content-safety adapters (interfaces
exist); fantasy-session user media (no gameplay attachment point yet).

## ✅ Increment 6 — Admin + safety + moderation operations (DONE)

- **Server-authoritative RBAC** (`USER`/`MODERATOR`/`ADMIN`) via migration
  `0006`; role read live from the DB on every request, never from client input.
  `requireRole`/`requireModerator`/`requireAdmin` gate `/api/admin/*`.
- **Account state** (`ACTIVE`/`SUSPENDED`/`DEACTIVATED`, optional expiry)
  enforced at login, refresh, every authenticated request, the WS handshake, and
  every inbound WS event. Suspend/deactivate **revoke sessions + force-close live
  sockets**; expired suspensions auto-lapse.
- **Unified safety reports** (`/api/reports/{user,media,message,session}/:id`):
  target-visibility-validated, self-report blocked, duplicate-constrained,
  rate-limited, reporter identity private. Moderator review queue + assign +
  resolve with a state machine.
- **Media moderation** (`/api/admin/media/:id` + approve/reject/quarantine):
  transactional transitions against the Increment 5 state machine, privileged
  byte-review endpoint, rejected/quarantined media never user-servable.
- **User safety** (admin): suspend/unsuspend/deactivate/reactivate with
  safeguards (no self-suspend, last-admin protection) and **role management**.
- **Append-only audit + moderation-action ledgers**; audit read API (admin
  only), sanitized metadata, no update/delete path.
- Block integrity and all Increment 1–5 behavior preserved.
- 37 new tests (RBAC, reports, moderation queue, media moderation incl.
  concurrency, suspension/session-revocation, WS safety, admin safeguards,
  audit, block integration). **Total: 225 passing** against real PostgreSQL.
  Live smoke: 102/102.

**Deferred:** a moderation/admin UI; admin MFA; production media provider
adapters (interfaces exist); fantasy-session user media.

## ✅ Increment 7 — Notifications + presence infrastructure (DONE)

- **PostgreSQL-authoritative notifications** (migration
  `0007_notifications_presence.sql`): a normalized `notifications` table
  (type, category, title, short body, nullable `entity_type`/`entity_id`,
  `read_at`, `dedupe_key`, `expires_at`) is the single source of truth for the
  feed, unread count, and read state. The WebSocket `notification.created` event
  is a best-effort real-time optimization carrying the same safe DTO — never
  authoritative.
- **Event coverage** wired into existing flows (no systems rebuilt):
  `MATCH_CREATED` (on a new mutual match, once per user), `MESSAGE_RECEIVED`
  (recipient only), `FANTASY_INVITE`/`FANTASY_ACCEPTED`/`FANTASY_COMPLETED`,
  and `SAFETY_ACTION` (suspend/unsuspend/reactivate). `FANTASY_STARTED`,
  `SESSION_PAUSED`/`RESUMED`, and `SYSTEM` types exist in the shared contract for
  forward use.
- **Minimal, privacy-safe payloads:** the stored notification never contains the
  chat message body, consent answers, media storage keys, the reporter/moderator
  identity, or the suspension reason. The client DTO exposes only
  `{id, type, category, title, body, entityType, entityId, readAt, createdAt}`.
- **Deterministic dedup:** a unique partial index on `(user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL` plus `ON CONFLICT DO NOTHING` guarantees at most
  one notification per logical event — covering idempotent message resends and
  concurrent reciprocal-like / concurrent-create races.
- **Per-category preferences** (`notification_preferences(user_id, category,
  enabled)`): a missing row defaults to **enabled** (no init race); disabling a
  category suppresses future notifications of that category. The **SAFETY**
  category is critical — it cannot be disabled (`CRITICAL_PREFERENCE`) and the
  service bypasses the preference check for it entirely.
- **Feed API:** `GET /api/notifications` (keyset-paginated, `unread=true`
  filter, expiry-filtered), `GET /api/notifications/unread-count`,
  `POST /api/notifications/:id/read` (idempotent, ownership-checked →
  `NOTIFICATION_NOT_FOUND` on another user's row), `POST
  /api/notifications/read-all`, and `GET`/`PUT /api/notifications/preferences`.
  Everything is auth-scoped and IDOR-safe.
- **Retention + cleanup:** non-critical notifications get a 90-day `expires_at`
  (SAFETY never expires); expired rows are excluded from feed/count and removed
  by a scheduler-callable cleanup function.
- **Process-local presence** (`PresenceRegistry`): a ref-counted registry that
  **both** gateways (`/ws/chat` and `/ws/game`) notify on connect/disconnect, so
  a user is `ONLINE` while holding ANY socket and `OFFLINE` only when the final
  socket closes. `users.last_seen_at` is written **only** on the
  `ONLINE→OFFLINE` transition (no per-heartbeat writes). Suspension force-closes
  sockets, which flips the user `OFFLINE` through the same path.
- **Privacy-aware presence:** `GET /api/users/:id/presence` and the
  `presence.changed` fan-out are visible only to `ACTIVE`-match partners with no
  block in either direction (the same relationship chat trusts). A non-observer
  receives a generic `PRESENCE_NOT_AUTHORIZED` (403) that reveals neither
  account existence nor online status. Presence exposes only
  `ONLINE`/`OFFLINE` (+ `lastSeenAt` when offline) — never socket/device counts.
- 36 new tests (24 notification + 12 presence/real-time WS): dedup, expiry,
  preferences, SAFETY bypass, feed/read-state IDOR, chat/match/fantasy/safety
  integration, presence accounting across channels, last-seen-on-final-close,
  visibility privacy, and authorized-only `notification.created` /
  `presence.changed` delivery. **Total: 261 passing** against real PostgreSQL.
  Live smoke: 135/135 (incl. a real multi-socket presence + notification WS flow).

**Honesty note / deferred:** presence is **process-local** — multi-instance
(distributed) presence needs a shared store / pub-sub (e.g. Redis) and is **not**
implemented. There is **no** push delivery (no FCM / APNs / web-push); only in-app
notifications ship. A push provider would be added behind the notification service
as a new delivery channel (abstraction noted, not built). → **Addressed in
Increment 8** (the delivery/presence/bus abstractions now exist; the real Redis /
FCM / APNs adapters remain future work).

## ✅ Increment 8 — Notification delivery + distributed presence infrastructure (DONE)

Backend-only. Adds the production-shaped **delivery layer** and the
**abstractions** needed for horizontal scale, without making Redis/FCM/APNs
mandatory. PostgreSQL stays authoritative; WebSocket and push are both
best-effort.

- **Migration `0008_notification_delivery.sql`** (additive, backward-compatible):
  - `notification_devices` — registered push targets owned by a user (platform
    `WEB`/`ANDROID`/`IOS`, provider `FCM`/`APNS`/`WEB_PUSH`/`TEST`/`DISABLED`,
    the raw `token`, a `token_hash`, a short `token_fingerprint`, label,
    timestamps, `revoked_at`). A **partial unique index** on
    `(user_id, token_hash) WHERE revoked_at IS NULL` makes registration
    idempotent and lets a revoked token re-register.
  - `notification_deliveries` — one row per `(notification, device, channel)`
    with a status machine (`PENDING→SENT→DELIVERED` / `FAILED` / `REVOKED`),
    `attempt_count`, sanitized `last_error_code`, `provider_message_id`. A
    **unique index** on `(notification_id, channel, COALESCE(device_id, …))`
    guarantees idempotent, race-safe delivery via `ON CONFLICT DO NOTHING`.
  - `notification_preferences.push_enabled` — a PUSH toggle **distinct** from
    whether the in-app notification exists.
- **Device registration API** (`/api/notifications/devices`, auth-scoped,
  rate-limited): register (idempotent; the caller always owns it — body
  `userId` is ignored), list (safe metadata only — **never the raw token**),
  and revoke (owner-only; IDOR → opaque `DEVICE_NOT_FOUND`).
- **Push provider abstraction** (`PushProvider`): `TestPushProvider`
  (deterministic, in-process, used by tests + the live smoke run) and
  `DisabledPushProvider` (the safe default — no delivery). `FcmPushProvider` /
  `ApnsPushProvider` are **architectural placeholders**: they fail safely with a
  "not configured" error and contain **no** real SDK integration or credentials.
- **Delivery dispatcher**: after a notification is persisted, best-effort
  push to the recipient's active devices (and a recorded REALTIME attempt).
  **Idempotent** (DB-unique delivery rows), **bounded retry** for temporary
  failures (max 5 attempts), and **automatic device revocation** on a permanent
  (invalid-token) failure. Never throws into the caller — a provider outage
  cannot roll back the notification.
- **Minimal push payload**: carries only `{type, notificationId, category,
  entityType, entityId}` — **no** title/body text, message content, consent,
  media keys, moderation details, suspension reason, or tokens. The recipient
  re-fetches via the authenticated feed.
- **Push preferences**: disabling push for a category suppresses PUSH only; the
  in-app notification is still created. **SAFETY** push cannot be disabled and
  always delivers.
- **Distributed presence abstraction** (`PresenceBackend`): the Increment 7
  registry is refactored into `LocalPresenceBackend` (default) with per-connection
  ref-counting across both channels **plus a heartbeat/TTL model** so a crashed
  process no longer leaves a user ONLINE forever (a periodic reaper reclaims
  stale connections and emits OFFLINE + persists last-seen).
  `DistributedPresenceBackend` is a documented placeholder that degrades to local
  until a shared-store client is wired.
- **Realtime bus abstraction** (`RealtimeBus`): user-scoped events are now
  published to a bus and fanned out by a per-process sink to the sockets THIS
  instance holds. `LocalRealtimeBus` (in-process emitter) is the default;
  `DistributedRealtimeBus` is a documented placeholder for cross-instance
  pub/sub. Envelopes carry a deterministic `eventId` so duplicate deliveries are
  dropped and never create duplicate DB notifications.
- **Cleanup** extended for revoked devices + terminal delivery records
  (30-day retention); notifications keep their existing retention.
- **Admin diagnostics**: `GET /api/admin/users/:id/devices` (admin-only,
  audited) exposes device metadata + last delivery status — **never** the raw
  token.
- **Concurrency hardening**: the mutual-match path now takes a transaction-scoped
  advisory lock on the canonical pair, so concurrent reciprocal likes
  deterministically yield exactly one match (closing a pre-existing READ
  COMMITTED visibility race).
- 36 new tests (9 device + 15 delivery + 10 distributed-abstraction + 2
  presence/delivery integration). **Total: 297 passing** against real
  PostgreSQL, run repeatedly. Live smoke: **164/164** (135 prior + 29 new),
  using the TEST push provider (no real credentials).

**Honesty note / deferred:** **no** real push delivery ships — FCM, APNs, and
Web Push are interface placeholders only (no SDKs, no credentials, no network
calls); the TEST/DISABLED providers are the only ones that run. Presence and the
realtime bus are still **process-local**: `distributed` selections degrade to the
local implementation and log a warning. **Redis is never a required dependency**
and is not used by any test. Wiring real Redis presence/pub-sub and real push
SDKs is future work.

## ✅ Increment 9 — Reliable background jobs + worker infrastructure (DONE)

Backend-only. Replaces fragile fire-and-forget async work (Increment 8's
`void deliver(...)` / manual retry calls) with a durable, PostgreSQL-backed job
queue + worker. No Redis / BullMQ / Kafka / RabbitMQ / Prisma.

- **Migration `0009_background_jobs.sql`** (additive): a `background_jobs` table
  with an explicit status machine (`PENDING / RUNNING / RETRY_WAIT / SUCCEEDED /
  DEAD / CANCELLED`, CHECK-constrained), `payload jsonb` (server-controlled,
  ids/flags only), `idempotency_key`, `priority`, `attempt_count` / `max_attempts`,
  `available_at`, lease (`leased_until` + `worker_id`), sanitized error metadata,
  and `failed_at` / `completed_at`. Indexes: a partial unique idempotency index
  on `(job_type, idempotency_key)` for non-terminal jobs, a partial claimable
  index `(priority, available_at)`, a running-lease index for reclaim, plus
  type/status/created and terminal-retention indexes.
- **Durable queue semantics**: `claimNext` uses `FOR UPDATE SKIP LOCKED` so
  concurrent workers never claim the same row; the claim commits BEFORE any
  external work (no transaction held across a provider call). Jobs hold a
  **lease**; an expired lease is reclaimed (RUNNING→RETRY_WAIT, attempt_count
  preserved) so a crashed worker never leaves a job stuck. **At-least-once**
  execution — handlers are idempotent.
- **Retry/backoff**: temporary failures retry with exponential backoff + full
  jitter, clamped to `[base, max]`, bounded by `max_attempts`; permanent failures
  dead-letter immediately. No retry storms, no infinite loops.
- **Handler registry** (no giant switch): `NotificationPushDeliveryHandler`,
  `NotificationCleanupHandler`, `PresenceReconciliationHandler`,
  `BackgroundJobCleanupHandler` — each independently testable.
- **Worker runtime** (`npm run worker`, runs independently of the API):
  bounded-concurrency polling, lease heartbeats for long jobs, success / retry /
  dead-letter recording, a periodic stale-lease reaper, structured logs
  (`job.claimed` / `job.succeeded` / `job.retry_scheduled` / `job.dead` /
  `job.reclaimed` / `worker.started|stopping|stopped`), lightweight in-process
  metrics, and **graceful shutdown** (stop claiming → finish in-flight within a
  grace period → remaining leases expire and are reclaimed).
- **Transactional outbox**: a notification INSERT and its
  `NOTIFICATION_PUSH_DELIVERY` job commit in the SAME transaction, so a committed
  notification is never left without its delivery job. SAFETY delivery is
  enqueued at high priority. The notification API never fails because push is
  unavailable; push now happens in the worker, reusing the Increment 8 delivery
  pipeline (whose `notification_deliveries` unique constraint keeps delivery
  idempotent — a replayed job does not double-send a device that already
  succeeded).
- **Cleanup / reconciliation jobs** run without an HTTP request: expired
  non-critical notifications (never SAFETY), terminal delivery records +
  long-revoked devices, stale presence TTL reconciliation (multi-connection
  semantics preserved), and background-job retention.
- **Admin diagnostics** (ADMIN-only, no raw payloads): `GET /api/admin/jobs`
  (filter + paginate), `GET /api/admin/jobs/:id`, `GET /api/admin/jobs/metrics`,
  `GET /api/admin/jobs/worker` — payloads shown only as a redacted summary.
- 61 new tests (repository/concurrency/crash-recovery, worker lifecycle +
  multi-worker + graceful shutdown, notification outbox integration, maintenance
  handlers, admin + security). **Total: 358 passing** against real PostgreSQL,
  across 3 consecutive clean runs. Live smoke: **182/182** (incl. a real
  separate worker process), 3 consecutive clean runs.

**Honesty note / deferred:** execution is **at-least-once**, not exactly-once —
a job may run more than once (handlers are idempotent); an external push provider
could still receive a duplicate request if a crash occurs after provider
acceptance but before DB acknowledgement. No Redis / BullMQ / Kafka. Distributed
workers are supported only to the extent PostgreSQL row-locking allows (same DB).
Real FCM/APNs delivery remains a placeholder (TEST/DISABLED providers only).

## ✅ Increment 10 — Observability, reliability & operational controls (DONE)

Backend-only. Makes the backend operationally understandable and safe to run:
correlation IDs, structured logging, in-process metrics, improved health/
readiness, worker/queue health, admin job operations, and durable operational
events — all PostgreSQL/Node-based (no Redis/Prometheus-server/Datadog/etc.).

- **Migration `0010_observability_operations.sql`** (additive): a low-volume
  `operational_events` table (type, CHECK-constrained severity, actor,
  correlation id, job id, entity ref, sanitized `metadata jsonb`, timestamps) +
  retention indexes. High-frequency telemetry stays IN-PROCESS — no per-request
  DB row.
- **Correlation / request context** (`AsyncLocalStorage`): every request gets a
  correlation id (safe inbound `X-Correlation-Id` honoured; oversized/malformed
  → fresh random id; always echoed in the response header) propagated through
  logs, operational events, and errors. Never a trusted security identifier.
- **Structured logging** (`observability/logger.ts`): config-driven level
  (`LOG_LEVEL`), auto-attached service/environment/correlation/user/job fields,
  SAFE error serialization (name + bounded message, never a raw Error), and
  defense-in-depth field redaction (tokens/passwords/bodies/consent/storage keys
  dropped). Best-effort — a logging failure never breaks a request.
- **In-process metrics** (`observability/metrics.ts`): counters + histograms
  with BOUNDED labels and a hard per-metric series cap (cardinality guard).
  HTTP (`http_requests_total` / `http_errors_total` / `http_request_duration_ms`
  with normalized route templates — UUIDs collapse to `:id`), DB
  (`db_queries_total` / `_errors_total` / `_duration_ms`), WebSocket (connections
  / disconnects / messages / errors by bounded channel+close-code), notifications
  (created / deduplicated / push sent / failed / revoked by category/provider),
  and jobs (enqueued / claimed / succeeded / retried / dead / reclaimed +
  execution & queue-wait histograms by type). Prometheus text at `GET /metrics`
  (configurable: `METRICS_ENABLED`, `METRICS_REQUIRE_AUTH` → ADMIN token).
- **Health / readiness**: `/health` is cheap liveness (+uptime; never fails
  because the worker/push is disabled). `/ready` is a structured report
  (`database` / `migrations` / `worker`) returning 503 when a critical
  dependency is down — never leaking connection strings/SQL/paths/credentials. A
  safe DB-health snapshot exposes pool total/idle/waiting/utilization only.
- **Worker health + queue pressure**: `GET /api/admin/jobs/worker` reports
  state (`RUNNING`/`STOPPING`/`STOPPED`/`DISABLED`/`UNHEALTHY`), active jobs,
  last poll/success, consecutive errors, queue depth, oldest-pending age, stale-
  running count, dead count, and a `queuePressure` level (OK/WARNING/CRITICAL)
  from configurable thresholds. A disabled worker is never UNHEALTHY.
- **Admin job operations** (ADMIN-only, audited, IDOR-safe): `POST
  /api/admin/jobs/:id/retry` (requeue a DEAD job only — resets attempts; refuses
  SUCCEEDED/RUNNING), `POST /api/admin/jobs/:id/cancel` (cancels PENDING/
  RETRY_WAIT; honestly refuses a RUNNING job rather than claiming it was killed),
  `GET /api/admin/jobs/dead` (dead-letter diagnostics, redacted payloads), and
  `GET /api/admin/operational-events`. Each operational action writes an audit
  record AND a durable operational event (no raw payload).
- **Queue backpressure / starvation detection**: configurable warning/critical
  depth + max-age thresholds surfaced via worker health + metrics. SAFETY/
  critical jobs are never casually rejected (the Increment 9 backpressure guard
  already bypasses idempotent/critical enqueues).
- **Operational-event retention**: pruned by the existing
  `BACKGROUND_JOB_CLEANUP` durable job (configurable
  `OPERATIONAL_EVENT_RETENTION_DAYS`) — a SEPARATE policy from audit logs, which
  are append-only and never deleted here.
- 57 new tests (metrics/cardinality, correlation/logging/sanitization, health/
  readiness/DB-health, operational events, admin retry/cancel/dead-letter +
  RBAC, and failure injection: crash→reclaim→complete, worker-unavailable→
  queued→processed, temp-fail→retry→recover). **Total: 415 passing** against
  real PostgreSQL across 3 consecutive runs. Live smoke: **221** (182 prior +
  39 new) across 3 consecutive runs, using a real separate worker process.

**Honest limitations:** metrics are **process-local** — with multiple server/
worker processes the values are per-process and are NOT aggregated across them
(a future scrape/aggregation layer would do that). Worker/job state is
PostgreSQL-backed; external push is still provider-dependent (TEST/DISABLED
providers only); job execution remains at-least-once (exactly-once external side
effects are not claimed). No Redis/Kafka/Prometheus-server/Datadog introduced.

## ✅ Increment 11 — Production security hardening & deployment readiness

Hardening the existing backend for production operation (no new mandatory
infrastructure — no Redis/Kafka/Prometheus-server introduced):

- **Abuse control primitive (`AbuseGuard`)**: a single process-local, bounded
  (LRU + periodic sweep), injectable-clock sliding-window limiter behind every
  abuse-sensitive surface. It has its OWN enable switch (`ABUSE_GUARD_ENABLED`,
  default on) independent of the legacy `rateLimitEnabled`, so throttling is
  actually exercised under test. Applied to login (brute force) and the
  write/action surfaces (discovery like/pass, block, chat send, fantasy invite).
- **Login brute-force / credential-stuffing protection**: dual-dimension (client
  IP + target account) temporary throttle — NOT a permanent lockout (which could
  be weaponised for DoS against a victim). The gate runs BEFORE the bcrypt
  comparison, removing hashing as an amplification vector. A successful login
  clears the counters.
- **Strict CORS allowlist** (`CORS_ALLOWED_ORIGINS`, legacy `CORS_ORIGINS`
  alias): normalized (lowercased, trailing-slash-trimmed, deduped), credentials
  allowed, never a wildcard. Disallowed origins receive no CORS headers.
- **Security headers** (centralized): `X-Content-Type-Options`, `X-Frame-Options:
  DENY`, `Referrer-Policy: no-referrer`, a minimal `Permissions-Policy`, an
  API-appropriate CSP (`default-src 'none'`), no `X-Powered-By`, and opt-in HSTS.
- **Request input limits**: configurable JSON body limit (→ `413
  PAYLOAD_TOO_LARGE`) and a URL-length guard; `trust proxy` driven by
  `TRUST_PROXY_HOPS` so `X-Forwarded-For` cannot be forged.
- **WebSocket hardening**: per-user concurrent-connection cap (close `4429`),
  inbound frame-size limit (`maxPayload`), and the per-connection event throttle
  wired to config with rejection metrics.
- **Media hardening**: explicit decompression-bomb / oversized-dimension reject
  (`MEDIA_MAX_PIXELS`) with a precise error + metric, on top of the existing
  byte/dimension/dual-MIME checks.
- **Config fail-fast**: production refuses to boot with weak/dev JWT secrets,
  equal access/refresh secrets, weak bcrypt rounds, empty/wildcard CORS, or
  `DEVELOPER_MODE=true` — and never prints a secret value.
- **Durable security events** (`security_events` table): low-volume, significant
  events only (brute-force lockout, login throttle, refresh-token reuse). The
  client source is stored ONLY as a salted, truncated fingerprint — never the
  raw IP. Pruned by the existing `BACKGROUND_JOB_CLEANUP` job
  (`SECURITY_EVENT_RETENTION_DAYS`); audit logs remain a separate, append-only
  policy. Readable via admin-only `GET /api/admin/security-events`.
- **Deployment artefacts**: a production multi-stage, non-root `Dockerfile`
  (API + worker from one image), `scripts/backup-db.sh` / `scripts/restore-db.sh`
  (pg_dump/pg_restore, credentials only via `DATABASE_URL`), and docs:
  `THREAT_MODEL.md`, `DEPLOYMENT.md`, `DISASTER_RECOVERY.md`,
  `PRODUCTION_SECURITY_CHECKLIST.md`.
- **64 new tests** (AbuseGuard unit incl. concurrency/eviction, brute-force,
  CORS/headers/request-limits, WS caps + frame limit, media dimension guard,
  security-events + admin endpoint, config fail-fast via subprocess). **Total:
  479 passing** against real PostgreSQL. Live smoke: **249** (221 prior + 28
  new) with a real separate worker process.

**Honest limitations:** rate limiting / abuse control and metrics are
**process-local** — with multiple API instances each process enforces its own
limits; this is NOT global/distributed enforcement (a shared backend such as
Redis would be required, and the `AbuseBackend` seam marks where it plugs in).
External push remains provider-dependent (FCM/APNs/WebPush are unimplemented
placeholders; TEST/DISABLED only). Distributed presence/realtime remain
placeholders. Job execution remains at-least-once (no exactly-once external side
effects). There is no frontend/Android client in this repository.

## ✅ Increment 12 — Distributed abuse infrastructure & dependency remediation

Addressing the two limitations called out at the end of Increment 11
(process-local rate limiting; runtime `file-type`/`sharp` advisories):

- **Distributed abuse backend.** The abuse abstraction gained a second,
  interchangeable backend behind one async `AbuseBackend` interface:
  `InMemoryAbuseBackend` (process-local, default) and `RedisAbuseBackend`
  (distributed), selected by `ABUSE_BACKEND`. Application code depends only on
  `AbuseGuard`, never on Redis directly. The Redis backend uses an atomic
  server-side Lua script for sliding-window check-and-increment plus TTL penalty
  blocks, so limits hold cluster-wide and cannot be raced.
- **Distributed login brute force.** With Redis, the per-IP and per-account
  failure limits are enforced across all instances — alternating requests
  between instances no longer bypasses them.
- **Key privacy.** Identifiers (IP/email/user id) are HMAC-fingerprinted before
  becoming keys, so no raw PII is stored in Redis; keys are namespaced +
  length-bounded; the fingerprint secret and Redis URL are never logged.
- **Fail policy.** `ABUSE_FAIL_POLICY=closed` (default, production-required)
  denies security-critical checks and flips `/ready` to 503 when Redis is down —
  no silent downgrade to process-local. `open` is forbidden in prod+redis.
  Redis readiness + an admin diagnostic (`GET /api/admin/abuse-backend`) expose
  only safe status, never connection details. Graceful connect/close wired into
  server lifecycle; bounded reconnect; connection reuse.
- **Dependency remediation.** `sharp` 0.33.5→0.35.5 (patched libvips/libheif),
  `file-type` 16→21.3.4 (ESM-only; loaded via dynamic import on Node 22's
  `require(esm)`). **`npm audit --omit=dev` → 0 vulnerabilities.** Accepted media
  formats unchanged (JPEG/PNG/WebP; HEIF/AVIF NOT enabled). Added `ioredis` as
  the (abstracted) Redis client.
- **No schema change.** Redis fully owns the ephemeral distributed abuse state;
  Increment 12 requires no database migration (no `0012`). PostgreSQL remains
  the sole source of truth; Redis is disposable.
- **Tests.** +33 net new automated tests (async backend mechanics, real Redis
  integration incl. a genuine two-OS-process multi-instance proof, distributed
  login, fail-open/closed, config fail-fast). **Total: 512 passing**, run 3×
  consecutively in BOTH memory and Redis modes (`verify` / `verify:redis`),
  no flakes. Live smoke: **255** (memory) + a dedicated **13**-check distributed
  Redis smoke (`scripts/smoke-redis.sh`), each 3× clean. Production Docker image
  rebuilt + validated (non-root, prod-deps-only, boots, file-type/sharp/ioredis
  load, graceful SIGTERM, fail-closed readiness when Redis is down).

**Honest limitations:** rate limiting is distributed ONLY when
`ABUSE_BACKEND=redis` is configured; the default remains process-local (and is
documented as such). WebSocket per-connection event throttles and per-user
connection caps are intentionally process-local (avoiding a Redis round-trip per
high-frequency ephemeral event). External push (FCM/APNs/WebPush) and
distributed presence/realtime remain unimplemented placeholders; job execution
is at-least-once. There is still no frontend/Android client in this repository.
Dev-only `npm audit` advisories (vitest/esbuild toolchain) remain but are not
shipped in the production image.

## ⏳ Increment 13 — Android client (React Native)

Onboarding/age gate, the five sections, consent + gameplay UI, push, offline UX.
Full load testing, OpenAPI/WS schema docs, and an Android release build remain
future work.
