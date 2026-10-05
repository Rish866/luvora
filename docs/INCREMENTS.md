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

## ⏳ Increment 5 — Media + moderation

Private object storage, signed URLs, upload pipeline, moderation state machine
+ pluggable provider (mock adapter until credentials supplied).

## ⏳ Increment 6 — Admin & safety

RBAC admin API, reports, moderation actions, audit log, account deletion,
anti-abuse hooks.

## ⏳ Increment 7 — Android client (React Native)

Onboarding/age gate, the five sections, consent + gameplay UI, push, offline UX.

## ⏳ Increment 8 — Hardening

Full security test matrix, load testing, OpenAPI/WS docs, deployment runbooks,
Android release build.
