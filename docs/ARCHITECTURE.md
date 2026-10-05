# Architecture

```
Android client (RN)                     [future increment]
      │  HTTPS (REST) + WSS (realtime)
      ▼
┌─────────────────────────────────────────────┐
│ API / Realtime server (Node + TypeScript)    │
│                                               │
│  Auth ─ Discovery ─ Matching ─ Chat           │
│  Fantasy engine ─ Session engine ─ Consent    │
│  Moderation ─ Notifications ─ Admin           │
└─────────────────────────────────────────────┘
      │                         │
      ▼                         ▼
  PostgreSQL              Object storage (private media)
```

The API servers are **stateless** (JWT access tokens, no server-side session
affinity), so they scale horizontally behind a load balancer. Realtime state
that must be shared across nodes (presence, pub/sub for session events) will use
Redis in a later increment; the single-node path works without it.

## Current (Increment 1) backend layout

```
apps/backend/src
├── config.ts              Validated env config (fail-fast)
├── logger.ts              Structured pino logger (secret redaction)
├── app.ts                 Express app assembly (importable by tests)
├── server.ts              HTTP listener + graceful shutdown
├── db/
│   ├── pool.ts            PG pool, query(), withTransaction()
│   ├── migrate.ts         Forward-only SQL migration runner
│   └── seed.ts            Dev seed data (demo adults + a match)
├── http/
│   ├── errors.ts          AppError + typed error factory
│   ├── errorHandler.ts    Central handler; never leaks internals
│   ├── respond.ts         Standard success/failure envelope
│   ├── authMiddleware.ts  requireAuth (verifies token + live user)
│   ├── rateLimiter.ts     Rate limiter factory (off in tests)
│   └── asyncHandler.ts    Async route error forwarding
├── auth/                  Password, tokens, age gate, auth service + routes
├── users/                 User repository
└── fantasy/               Session + consent repository, service, routes

database/migrations/       Forward-only .sql migrations (applied in order)
```

`packages/shared/` holds the enums and pure logic that the backend, client, and
admin all depend on — crucially the **session state machine** and **consent
resolver**, so there is a single source of truth for safety-critical rules.

## Server authority

The server is the only component permitted to:

- advance a session's state (validated against `SESSION_TRANSITIONS`);
- decide which consent categories are mutually allowed;
- determine whether both players have confirmed participation.

Clients may *request* actions, but the server validates every one against the
authenticated user's actual membership in the match/session. IDs supplied by the
client are never trusted as proof of access (and are non-enumerable UUIDs).

## Consent privacy (safety-critical)

`shared/src/consent.ts#resolveCompatibleCategories` computes the shared
allow-list from both players' private answers. The API only ever returns:

- the acting player's **own** answers, and
- a boolean `partnerConfirmed`, and
- (once both confirm) the mutual allow-list.

It never returns the partner's per-category answers. This is covered by an
explicit test (`consent.integration.test.ts` → "never reveals the partner's
answers").
