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

## Known gaps (planned for later increments)
- Email/phone verification flow (fields exist; sending not wired).
- Multi-instance WebSocket presence/delivery (process-local today; needs shared
  pub/sub such as Redis — deferred to the hardening increment).
- Scenario authoring/admin tooling (the data model + versioning support it; the
  admin API/RBAC arrives in a later increment).
- Media signed-URL authorization + moderation pipeline.
- Admin RBAC + audit logging.
- Full automated security test matrix and load testing.
