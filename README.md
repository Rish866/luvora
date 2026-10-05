# Luvora — Private Interactive Fantasy Platform (18+)

> **Adults only (18+).** Luvora is a server-authoritative multiplayer platform
> where two **consenting adults** who have mutually matched can privately chat
> and play branching, **non-graphic** romance/fantasy visual-novel scenarios
> together. Consent and safety are enforced in the architecture — not treated as
> a cosmetic checkbox.

All interactive scenarios involve two consenting adults. Luvora does **not**
contain, describe, or generate explicit sexual content. All romance is
non-graphic and non-explicit.

---

## Implementation status

This repository contains **Increment 1 (backend foundation)**,
**Increment 2 (discovery & matching)**, **Increment 3 (private chat +
WebSockets)**, **Increment 4 (data-driven fantasy engine)**,
**Increment 5 (secure media, attachments & moderation)**,
**Increment 6 (admin + safety + moderation operations)**,
**Increment 7 (notifications + presence infrastructure)**,
**Increment 8 (production notification delivery + distributed presence
infrastructure)**, **Increment 9 (reliable background jobs + worker
infrastructure)**, and **Increment 10 (observability, reliability &
operational controls)**. All are working, tested slices (not mocked screens).

**Increment 1 — foundation:**
- ✅ Auth: register / login / refresh / logout / logout-all / `me`
- ✅ Secure password hashing (bcrypt) and JWT access + rotating refresh tokens
      with reuse/theft detection and revocation
- ✅ **Server-side 18+ age gate** (derived from date of birth; also a DB `CHECK`)
- ✅ PostgreSQL schema + migrations for the core models
- ✅ **Server-authoritative consent + session state machine**, with the privacy
      guarantee that a player's private `NO`/`MAYBE` answers are never revealed
      to the other player
- ✅ Request validation, rate limiting, secure headers, consistent error
      envelope, structured logging, health/readiness endpoints

**Increment 2 — discovery & matching:**
- ✅ Discovery feed (`GET /api/discovery`) — DB-driven, keyset-paginated,
      excludes self / already-decided / blocked (both ways) / matched / ineligible
- ✅ Like & Pass (`POST /api/discovery/:userId/{like,pass}`) — one decision per
      pair, idempotent, LIKE↔PASS converts in place
- ✅ **Race-safe server-side mutual matching** (reciprocal likes → exactly one match)
- ✅ Block / Unblock (`/api/users/:userId/block`) — removes from discovery both
      ways, blocks new likes, invalidates existing match; unblock never recreates
- ✅ Match list & detail (`/api/matches`) — participant-only, IDOR-safe
- ✅ Discovery-safe DTOs — no auth/consent/private fields ever leak

**Increment 3 — private chat + WebSockets:**
- ✅ One conversation per `ACTIVE` match (lazy, race-safe); append-only messages
- ✅ REST history + send (`/api/matches/:matchId/messages`) — keyset pagination,
      4000-code-point limit, empty/oversized rejection, `clientMessageId` idempotency
- ✅ **WebSocket gateway** at `/ws/chat` on the same port — handshake auth via the
      existing access token; `connection.ready`, `message.send`/`message.created`,
      `message.read`, `typing`, `chat.blocked`, `error`
- ✅ Single message service shared by REST + WS; **persist-then-broadcast**;
      sender identity is always the authenticated connection (no spoofing)
- ✅ **Block re-checked on every send** — stale sockets cannot bypass a block
- ✅ Multi-socket-per-user delivery; recipient-only routing (never global);
      heartbeat + registry cleanup; graceful shutdown
- ✅ Discriminated-union protocol types in `packages/shared`

**Increment 4 — data-driven fantasy engine:**
- ✅ Data-driven scenario library (`scenarios → versions → nodes → choices →
      requirements`); content is data, not code; **immutable versions** pinned per session
- ✅ Scenario library API (`GET /api/scenarios[/:id]`) — published-only, paginated
- ✅ Server-authoritative gameplay (`POST /api/sessions/:id/scenario`,
      `GET /api/sessions/:id/state`, `POST /api/sessions/:id/choices/:choiceId`,
      pause/resume) — client submits only a choice id; server resolves node/turn/ending
- ✅ **Consent re-evaluated at choice time** (shared resolver); partner responses never exposed
- ✅ **Transactional + optimistic-concurrency + idempotent** turns
      (`SELECT … FOR UPDATE` + `state_version` + `clientActionId`)
- ✅ **Gameplay WebSocket** `/ws/game` on the same port (shared dispatcher, coexists
      with `/ws/chat`): `game.subscribe`/`game.state`, `game.choose` →
      `game.state.changed`/`game.completed`; persist-then-broadcast; reconnect-safe
- ✅ ~5 seeded non-graphic demo scenarios (branching, consent-gated, multiple endings)

**Increment 5 — secure media, attachments & moderation:**
- ✅ Provider-independent storage (`MediaStorage` + `LocalMediaStorage`; S3/R2 future)
- ✅ Two-step upload (`POST /api/media` → `PUT /api/media/:id/content`) with a real
      pipeline: magic-byte + `sharp` detection, declared-vs-detected MIME check,
      dimension/decompression-bomb limits, SHA-256, **EXIF/GPS strip**, thumbnail
- ✅ Media + moderation **state machines** (server-controlled); malware & content-
      safety **abstractions** with deterministic dev stubs (NOT production protection)
- ✅ Chat **attachments** (`attachmentIds` on REST + `/ws/chat`), validated + linked
      **transactionally**, safe DTOs in history & broadcasts; attachment-only messages
- ✅ Centralized media **authorization** reusing the chat policy — a block immediately
      revokes recipient media access (no bypass); private delivery headers
- ✅ Report (controlled reasons, reporter never exposed), owner soft-delete, orphan cleanup

**Increment 6 — admin + safety + moderation operations:**
- ✅ **Server-authoritative RBAC** (`USER`/`MODERATOR`/`ADMIN`); role read live from
      the DB, never from client input (forged role fields ignored)
- ✅ Account state (`ACTIVE`/`SUSPENDED`/`DEACTIVATED`) enforced at login, refresh,
      every request, WS handshake + every WS event; suspend **revokes sessions +
      force-closes live sockets**; suspensions auto-lapse
- ✅ Unified safety **reports** (`/api/reports/...`) — target-validated, self-report
      blocked, duplicate-constrained, reporter identity private
- ✅ **Moderation queue** + report assign/resolve; **media moderation**
      (approve/reject/quarantine) with transactional state transitions + review endpoint
- ✅ Admin **user safety** (suspend/unsuspend/deactivate/reactivate) + **role
      management** with safeguards (no self-suspend; last-admin protected)
- ✅ **Append-only audit log** (admin read-only, sanitized metadata, no edit/delete API)
- ✅ No admin backdoor — first admin provisioned via a DB update (documented)

**Increment 7 — notifications + presence infrastructure:**
- ✅ **PostgreSQL-authoritative notifications** — a normalized `notifications`
      table drives feed, unread count, read/read-all; the WebSocket
      `notification.created` event is a best-effort real-time optimization, never
      the source of truth
- ✅ Notification types (`MATCH_CREATED`, `MESSAGE_RECEIVED`, `FANTASY_INVITE`/
      `ACCEPTED`/`STARTED`/`COMPLETED`, `SESSION_PAUSED`/`RESUMED`, `SAFETY_ACTION`,
      `SYSTEM`) wired into the match, chat, fantasy, and safety flows
- ✅ **Minimal, privacy-safe payloads** — the persistent notification never stores
      the message body, consent answers, media storage keys, reporter/moderator
      identity, or the suspension reason; the client DTO exposes only safe fields
- ✅ **Deterministic dedup** — a unique partial index on
      `(user_id, dedupe_key)` + `ON CONFLICT DO NOTHING` makes repeated/idempotent
      triggers (e.g. a resent message or a reciprocal-like race) produce at most one
      notification per logical event
- ✅ **Per-category preferences** (`notification_preferences`) — missing row defaults
      to enabled; disabling a category suppresses its notifications; the critical
      **SAFETY** category cannot be disabled and bypasses the preference check
- ✅ Feed API (`/api/notifications`, keyset-paginated), `unread-count`,
      `:id/read`, `read-all`, and `preferences` (GET/PUT) — all auth-scoped and
      IDOR-safe (a user can only read/mutate their own notifications)
- ✅ Expiry + operational **cleanup** — non-critical notifications get a 90-day
      `expires_at` (SAFETY never expires); expired rows are excluded from feed/count
      and removed by a cleanup job
- ✅ **Process-local presence** (`PresenceRegistry`) — ref-counted across BOTH
      `/ws/chat` and `/ws/game`, so a user is `ONLINE` while holding ANY socket and
      only `OFFLINE` when the final socket closes; `users.last_seen_at` is persisted
      **only** on the `ONLINE→OFFLINE` transition (no per-heartbeat writes)
- ✅ **Privacy-aware presence** — `GET /api/users/:id/presence` and the
      `presence.changed` fan-out are visible **only** to `ACTIVE`-match partners with
      no block in either direction (reuses the chat trust relationship); strangers get
      a generic `403` that reveals neither existence nor online state
- ✅ Suspension force-closes a user's sockets, which flips them `OFFLINE` through the
      same registry path

- ✅ Notification dedup/expiry/preferences, SAFETY bypass, feed IDOR, presence
      accounting across channels, last-seen-on-final-close, presence visibility
      privacy, and real-time `notification.created` / `presence.changed` delivery
      to authorized observers only.

**Increment 8 — production notification delivery + distributed presence infra:**
- ✅ **Device registration** (`/api/notifications/devices`) — register (idempotent,
      owner-bound; body `userId` ignored), list, revoke (owner-only, IDOR-safe).
      Raw push tokens are **never** returned or logged — only a short fingerprint
      + metadata; uniqueness/dedup use a SHA-256 hash (migration `0008`)
- ✅ **Per-(notification, device, channel) delivery tracking** with a status
      machine (`PENDING→SENT→DELIVERED` / `FAILED` / `REVOKED`), **idempotent** via
      a DB unique index + `ON CONFLICT`, **bounded retry** (max 5) for temporary
      failures, and **automatic device revocation** on a permanent invalid-token
      failure
- ✅ **Push provider abstraction** (`PushProvider`): `TestPushProvider`
      (deterministic, used in tests + live smoke) and `DisabledPushProvider` (the
      safe default). `FcmPushProvider` / `ApnsPushProvider` are **interface
      placeholders** — no SDK, no credentials, no network, no fake delivery
- ✅ **Minimal push payload** — only `{type, notificationId, category,
      entityType, entityId}`; never message bodies, consent, media keys,
      moderation internals, suspension reason, or tokens
- ✅ **Push preferences** distinct from notification existence — disabling push
      keeps the in-app notification; **SAFETY** push cannot be disabled
- ✅ **Distributed presence abstraction** (`PresenceBackend`): the registry is now
      `LocalPresenceBackend` with per-connection ref-counting **plus heartbeat/TTL
      reaping** (a crashed process no longer leaves a user ONLINE forever);
      `DistributedPresenceBackend` is a documented placeholder
- ✅ **Realtime bus abstraction** (`RealtimeBus`): events are published to a bus
      and fanned out by a per-process sink; `LocalRealtimeBus` is the default,
      `DistributedRealtimeBus` a placeholder. Envelopes carry a deterministic
      `eventId` so duplicate deliveries never double-send or create duplicate DB rows
- ✅ **Admin device diagnostics** (`GET /api/admin/users/:id/devices`, audited) —
      metadata + last delivery status only, never the raw token
- ✅ Mutual-match path hardened with a transaction-scoped advisory lock so
      concurrent reciprocal likes deterministically yield exactly one match

- ✅ **297 passing tests** (261 prior + 36 new) against a real PostgreSQL,
      run repeatedly, covering device registration/IDOR/token-privacy, push
      delivery/dedup/retry/revocation, push preferences + SAFETY bypass, presence
      TTL/heartbeat, the realtime bus + a two-instance simulation, and the
      distributed-abstraction contracts. **164 live end-to-end smoke checks**
      (135 prior + 29 new) pass using the TEST push provider (no real credentials).

**Increment 9 — reliable background jobs + worker infrastructure:**
- ✅ **Durable PostgreSQL job queue** (migration `0009`, table `background_jobs`)
      with an explicit status machine (`PENDING / RUNNING / RETRY_WAIT /
      SUCCEEDED / DEAD / CANCELLED`), priority, attempts, availability, lease,
      and sanitized error metadata — no Redis / BullMQ / Kafka / RabbitMQ
- ✅ **Concurrent-safe claiming** via `FOR UPDATE SKIP LOCKED`; the claim commits
      before any external work (no transaction held across a provider call)
- ✅ **Leases + crash recovery** — a crashed worker's expired lease is reclaimed
      (RUNNING→RETRY_WAIT, attempt count preserved); a repeatedly-crashing job is
      dead-lettered. No job stays permanently stuck
- ✅ **Bounded exponential backoff + jitter** for temporary failures; permanent
      failures dead-letter immediately. No retry storms
- ✅ **Worker runtime** (`npm run worker`, independent of the API): bounded
      concurrency, lease heartbeats, periodic stale-lease reaper, structured
      logs, in-process metrics, and **graceful SIGTERM/SIGINT shutdown**
- ✅ **Transactional outbox** — a notification INSERT and its
      `NOTIFICATION_PUSH_DELIVERY` job commit together; the worker performs push
      via the (idempotent) Increment 8 pipeline. The notification API never fails
      because push is unavailable
- ✅ **Durable maintenance jobs** (run with no HTTP request): notification
      cleanup, delivery/device pruning, presence TTL reconciliation (multi-
      connection semantics preserved), and job retention
- ✅ **Admin diagnostics** (`/api/admin/jobs[/:id|/metrics|/worker]`, ADMIN-only)
      — redacted payload summaries only, never raw payloads/secrets
- ✅ Idempotency keys collapse duplicate enqueues; SAFETY delivery is
      high-priority; handlers are idempotent (at-least-once execution)

- ✅ **358 passing tests** (297 prior + 61 new) against a real PostgreSQL,
      run 3× consecutively — covering repository/claim/lease/reclaim, concurrent
      multi-worker consumption, crash recovery, retry/backoff/dead-letter,
      the transactional outbox, maintenance handlers, and admin + security.
      **182 live end-to-end smoke checks** pass (3× consecutively) against the
      running server **plus a real separate worker process**, using the TEST push
      provider (no real credentials).

**Increment 10 — observability, reliability & operational controls:**
- ✅ **Correlation ids / request context** (`AsyncLocalStorage`) — every request
      gets a safe, bounded `X-Correlation-Id` (honoured inbound or generated),
      propagated through logs, operational events, and errors
- ✅ **Structured logging** — config-driven level, auto-attached context, SAFE
      error serialization, and redaction of tokens/passwords/bodies/consent/
      storage keys (tested: secrets never appear in log output)
- ✅ **In-process metrics** with BOUNDED labels + a per-metric series cap: HTTP
      (route-template/method/status-class + duration), DB, WebSocket,
      notification, and job metrics; Prometheus text at `GET /metrics`
      (configurable: `METRICS_ENABLED` / `METRICS_REQUIRE_AUTH` → ADMIN)
- ✅ **Health / readiness** — `/health` cheap liveness (never fails on a disabled
      worker/push); `/ready` structured `{database, migrations, worker}` with a
      503 when a critical dependency is down; no connection strings/SQL/paths leak
- ✅ **Worker health + queue pressure** (`GET /api/admin/jobs/worker`) — derived
      state (`RUNNING`/`STOPPING`/`STOPPED`/`DISABLED`/`UNHEALTHY`), queue depth,
      oldest-pending age, stale/dead counts, and OK/WARNING/CRITICAL pressure
- ✅ **Admin job operations** (ADMIN-only, audited, IDOR-safe): requeue a DEAD
      job, cancel a queued job (honestly refuses a RUNNING one), dead-letter
      diagnostics, and an operational-event log — each action writes an audit
      record + a durable operational event (migration `0010`, `operational_events`)
- ✅ Queue backpressure / starvation thresholds; operational-event retention via
      the existing durable cleanup job (SEPARATE from append-only audit logs)

- ✅ **415 passing tests** (358 prior + 57 new) against a real PostgreSQL, run 3×
      consecutively — metrics/cardinality, correlation/logging/sanitization,
      health/readiness/DB-health, operational events, admin retry/cancel/dead-
      letter + RBAC, and failure injection (crash→reclaim→complete; worker-
      unavailable→queued→processed; temp-fail→retry→recover). **221 live smoke
      checks** (182 prior + 39 new) pass 3× consecutively against the running
      server + a real separate worker.

> **Honesty note (Increments 7–10).** There is **no** real push delivery — FCM,
> APNs, and Web Push are interface placeholders only (no SDK, no credentials, no
> network calls); the TEST/DISABLED providers are the only ones that run.
> Presence and the realtime bus are still **process-local**: selecting a
> `distributed` backend degrades to the in-process implementation and logs a
> warning. Background-job execution is **at-least-once** (not exactly-once;
> handlers are idempotent). **Metrics are process-local** — not aggregated across
> multiple processes (a future scrape layer would do that); no APM vendor is
> integrated. **Redis is never a required dependency** and is not used by any
> test. Wiring real Redis presence/pub-sub, a distributed broker/metrics
> aggregation, and real push SDKs is deliberate future work.

See [`docs/INCREMENTS.md`](docs/INCREMENTS.md) for the roadmap and what is
**intentionally deferred** to later increments.

---

## Repository structure

```
luvora/
├── apps/
│   └── backend/            Node.js + TypeScript API server (Increment 1)
│       ├── src/
│       │   ├── auth/       Auth service, routes, tokens, password, age gate
│       │   ├── db/         PG pool, migration runner, seed
│       │   ├── fantasy/    Consent + session engine (service, routes, repo)
│       │   ├── http/       Error handling, middleware, rate limiter, helpers
│       │   ├── users/      User repository
│       │   ├── app.ts      Express app (importable by tests)
│       │   └── server.ts   HTTP listener + graceful shutdown
│       ├── scripts/verify.ts   Ephemeral-Postgres verification runner
│       └── test/           Unit + integration tests
├── packages/
│   └── shared/             Shared TS types: enums, state machine, consent rules
├── database/
│   └── migrations/         Forward-only SQL migrations
├── docker/
│   └── docker-compose.yml  Local PostgreSQL for development
├── docs/                   Architecture, API, DB, security, setup, roadmap
├── scripts/                Dev helper scripts
├── package.json            npm workspaces root
└── README.md
```

> `apps/mobile` and `apps/admin` are planned for later increments and are not
> part of this foundation commit.

---

## Prerequisites

- Node.js ≥ 20 (developed on Node 22)
- One of:
  - **Docker** (recommended) for local PostgreSQL, or
  - a native PostgreSQL ≥ 13.

## Environment variables

Copy the example and fill in real values locally (never commit secrets):

```bash
cp apps/backend/.env.example apps/backend/.env.development
```

Key variables (see `apps/backend/.env.example` for the full list):

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Token signing secrets (use `openssl rand -base64 48`) |
| `BCRYPT_ROUNDS` | bcrypt cost factor (default 12) |
| `RATE_LIMIT_*` | Rate-limiting window and caps |
| `DEVELOPER_MODE` | Must be `false` in production |

## PostgreSQL setup (Docker)

```bash
docker compose -f docker/docker-compose.yml up -d
# Postgres at postgres://app:app@localhost:5432/luvora_dev
```

## Installation

```bash
npm install
```

## Database migration

```bash
npm run -w @luvora/backend migrate:up
npm run -w @luvora/backend seed     # optional demo adults + a match
```

## Running the backend

```bash
npm run -w @luvora/backend dev            # auto-reload (ts-node-dev)
# or production build:
npm run build && npm run -w @luvora/backend start
```

- Liveness: `GET http://localhost:4000/health`
- Readiness (pings DB): `GET http://localhost:4000/ready`

## Running tests

**With Docker Postgres:**

```bash
bash scripts/test-with-docker.sh
```

**In an environment without a stable Docker daemon** (boots an ephemeral native
PostgreSQL for the test run):

```bash
npm run verify
```

---

## API basics

Standard envelope:

```jsonc
{ "success": true,  "data":  { /* ... */ } }
{ "success": false, "error": { "code": "SESSION_NOT_AUTHORIZED", "message": "..." } }
```

Representative endpoints (full reference in [`docs/API.md`](docs/API.md)):

- `POST /api/auth/register` — rejects under-18 by date of birth (`403 AGE_RESTRICTED`)
- `POST /api/auth/login` / `refresh` / `logout`
- `GET  /api/auth/me` *(auth required)*
- `POST /api/sessions/invite` / `:id/accept` / `:id/consent` / `:id/leave`

---

## Security notes

- Passwords are bcrypt-hashed; refresh tokens are stored only as SHA-256 hashes.
- Refresh rotation revokes the whole token family on reuse (theft containment).
- Every session action verifies the caller is actually a participant
  (IDOR-resistant; non-enumerable UUID keys).
- A player's private consent answers are never exposed to the partner — only the
  server-computed mutual allow-list is shared, and only after both confirm.
- No secrets are committed; `.env*` is git-ignored and only `.env.example`
  (placeholders) is tracked.

See [`docs/SECURITY.md`](docs/SECURITY.md) for details and known gaps.

---

## What is implemented vs. deferred

**Implemented (Increments 1–9, backend):** auth + 18+ age gate; consent + session
state machine; discovery/matching/blocking; private chat (REST + `/ws/chat`);
the data-driven fantasy engine + scenario library + gameplay (`/ws/game`); secure
media uploads, chat attachments, and the moderation/safety pipeline; the admin
control plane — RBAC, safety reports, moderation queue + media moderation, user
suspension/role management with session revocation, and audit logging; in-app
notifications + presence (feed/unread/read-state, per-category preferences,
dedup, expiry/cleanup, privacy-aware presence, real-time WebSocket events); the
notification **delivery layer** — device registration, per-channel delivery
tracking with idempotency/bounded-retry/token-revocation, a push-provider
abstraction, push preferences, a heartbeat/TTL presence model, and
presence/realtime-bus abstractions for future horizontal scale; and a **durable
PostgreSQL job queue + worker** — leasing, crash recovery, bounded backoff
retries, dead-lettering, a transactional outbox for notification delivery,
maintenance/reconciliation jobs, graceful shutdown, and admin job diagnostics;
and an **observability & operational layer** — correlation ids, structured
logging, in-process metrics (`/metrics`), health/readiness, worker/queue health,
admin job retry/cancel/dead-letter operations, and durable operational events.

**Intentionally deferred** (later increments): production media providers
(S3/R2 storage, real malware scanner, real content-safety moderation — the
interfaces exist, only local/test adapters ship); fantasy-session user media;
**real push delivery** (FCM / APNs / Web Push are interface placeholders — no
SDK, no credentials, no network; only the TEST/DISABLED providers run);
**distributed presence and cross-instance realtime** (the `PresenceBackend` /
`RealtimeBus` abstractions ship, but the shared-store/pub-sub — e.g. Redis —
implementations are placeholders that degrade to in-process; Redis is never
required); **exactly-once / brokered job processing** (the job queue is durable
and at-least-once on PostgreSQL — no Redis/BullMQ/Kafka/RabbitMQ, and
multi-worker scaling is bounded by PostgreSQL row-locking on one database);
**distributed metrics aggregation / APM** (metrics are process-local — no
Prometheus server, Datadog, or New Relic integrated); a moderation/admin UI;
admin MFA; recommendations; payments; production infrastructure; and all
frontend/Android UI. See [`docs/INCREMENTS.md`](docs/INCREMENTS.md).
