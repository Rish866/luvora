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
**Increment 5 (secure media, attachments & moderation)**, and
**Increment 6 (admin + safety + moderation operations)**. All are working,
tested slices (not mocked screens).

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

- ✅ **225 passing tests** (188 prior + 37 new) against a real PostgreSQL, including
      RBAC, report privacy, concurrent moderation, suspension/session-revocation,
      WebSocket safety, admin safeguards, audit immutability, and block integration.

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

**Implemented (Increments 1–6, backend):** auth + 18+ age gate; consent + session
state machine; discovery/matching/blocking; private chat (REST + `/ws/chat`);
the data-driven fantasy engine + scenario library + gameplay (`/ws/game`); secure
media uploads, chat attachments, and the moderation/safety pipeline; and the
admin control plane — RBAC, safety reports, moderation queue + media moderation,
user suspension/role management with session revocation, and audit logging.

**Intentionally deferred** (later increments): production media providers
(S3/R2 storage, real malware scanner, real content-safety moderation — the
interfaces exist, only local/test adapters ship); fantasy-session user media;
multi-instance WebSocket scaling (process-local today); a moderation/admin UI;
admin MFA; push notifications; recommendations; payments; production
infrastructure; and all frontend/Android UI. See
[`docs/INCREMENTS.md`](docs/INCREMENTS.md).
