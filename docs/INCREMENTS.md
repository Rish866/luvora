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

## ⏳ Increment 3 — Private chat + WebSockets

Authenticated WebSocket gateway, per-match conversations, messages, typing,
read receipts, presence, reconnection with sequence numbers.

## ⏳ Increment 4 — Data-driven fantasy engine

JSON scenario schema + validator, 5 non-graphic scenarios, branching engine,
relationship progression, two-player simultaneous-choice resolution over WS.

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
