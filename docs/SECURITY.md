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

## Known gaps (planned for later increments)
- Email/phone verification flow (fields exist; sending not wired).
- **Push-notification delivery** (FCM / APNs / web-push) is **not** implemented —
  only in-app PostgreSQL notifications plus the optional WebSocket event ship. A
  push provider would be added behind the notification service as a new delivery
  channel (abstraction noted, not built).
- Multi-instance WebSocket delivery **and distributed presence** (both
  process-local today; need a shared store / pub-sub such as Redis — deferred to
  the hardening increment).
- A moderation/admin UI (this increment is backend/API only).
- **Production media providers:** real S3/R2 storage adapters, a real malware
  scanner (ClamAV/cloud), and a real content-safety moderation provider — the
  interfaces exist; only local/test implementations ship today. Signed-URL
  issuance is stubbed in the local provider (the app serves bytes through its own
  authenticated endpoint).
- **Fantasy-session user media** remains deferred (no gameplay attachment point).
- No MFA for admin accounts yet (would layer on the existing auth system).
- Full load testing.
