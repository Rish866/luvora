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

## Known gaps (planned for later increments)
- Email/phone verification flow (fields exist; sending not wired).
- WebSocket auth/authorization (arrives with chat/gameplay).
- Media signed-URL authorization + moderation pipeline.
- Admin RBAC + audit logging.
- Full automated security test matrix and load testing.
