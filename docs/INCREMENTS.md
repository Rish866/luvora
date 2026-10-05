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

## ⏳ Increment 9 — Android client (React Native)

Onboarding/age gate, the five sections, consent + gameplay UI, push, offline UX.

## ⏳ Increment 10 — Hardening

Full security test matrix, load testing, OpenAPI/WS docs, deployment runbooks,
Android release build.
