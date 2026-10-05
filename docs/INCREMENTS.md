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

## ⏳ Increment 2 — Discovery & matching

Like/pass, server-side mutual match creation (race-safe), block, discovery feed
excluding blocked/passed users, match list.

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
