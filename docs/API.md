# REST API (Increment 1)

All responses use a consistent envelope:

```jsonc
// success
{ "success": true, "data": { /* ... */ } }
// failure
{ "success": false, "error": { "code": "SESSION_NOT_AUTHORIZED", "message": "..." } }
```

Authenticated endpoints require `Authorization: Bearer <accessToken>`.

Error codes: `VALIDATION_ERROR`, `UNAUTHENTICATED`, `UNAUTHORIZED`, `NOT_FOUND`,
`CONFLICT`, `RATE_LIMITED`, `AGE_RESTRICTED`, `SESSION_NOT_AUTHORIZED`,
`INVALID_STATE_TRANSITION`, `INTERNAL`.

## Health

| Method | Path      | Auth | Description                     |
|--------|-----------|------|---------------------------------|
| GET    | `/health` | no   | Liveness.                       |
| GET    | `/ready`  | no   | Readiness (pings the database). |

## Auth

### `POST /api/auth/register`
```json
{
  "email": "you@example.com",
  "password": "at-least-8-chars",
  "displayName": "Ava",
  "dateOfBirth": "1996-04-12",
  "ageConfirmed": true
}
```
- `201` → `{ userId, accessToken, refreshToken, accessExpiresIn }`
- `403 AGE_RESTRICTED` if `dateOfBirth` is under 18 (even if `ageConfirmed` true).
- `400 VALIDATION_ERROR` if `ageConfirmed` is not `true`.
- `409 CONFLICT` if the email is already registered.

### `POST /api/auth/login`
```json
{ "email": "you@example.com", "password": "..." }
```
- `200` → tokens. `401 UNAUTHENTICATED` on bad credentials.

### `POST /api/auth/refresh`
```json
{ "refreshToken": "..." }
```
- `200` → new `{ accessToken, refreshToken, accessExpiresIn }` (rotation).
- `401` if invalid/expired. **Reuse of an already-rotated token revokes the
  whole family** and returns `401`.

### `POST /api/auth/logout`
```json
{ "refreshToken": "..." }
```
- `200` → `{ loggedOut: true }`; the refresh token is revoked.

### `GET /api/auth/me`  *(auth required)*
- `200` → `{ id, email, age, ageConfirmed, emailVerified }` (no sensitive fields).

## Fantasy sessions  *(all auth required)*

### `POST /api/sessions/invite`
```json
{ "matchId": "<uuid>", "scenarioId": "midnight-date", "scenarioVersion": "v1" }
```
- Caller must belong to an **ACTIVE** match. Invitee is the other member.
- `201` → `{ sessionId, state: "INVITED" }`.
- `403` if the caller is not part of the match. `409` if the match is inactive.

### `POST /api/sessions/:id/accept`
- Only the invited player may accept. `200` → `{ sessionId, state: "CONSENT" }`.
- `403` if the caller is the initiator or not a participant.

### `POST /api/sessions/:id/decline`
- Either participant aborts before play. `200` → `state: "ABANDONED"`.

### `POST /api/sessions/:id/consent`
```json
{
  "responses": [
    { "category": "flirting", "response": "YES" },
    { "category": "teasing",  "response": "NO" }
  ],
  "agreeToParticipate": true
}
```
- Stores the caller's **private** answers. When **both** players have submitted
  answers *and* set `agreeToParticipate: true`, the session advances to
  `PLAYING` and the response includes `allowedCategories` (mutual-YES only).
- Response (never includes the partner's answers):
```jsonc
{
  "sessionId": "...",
  "state": "CONSENT" | "PLAYING",
  "yourResponses": { "flirting": "YES", "teasing": "NO" },
  "youConfirmed": true,
  "partnerConfirmed": false,       // boolean only
  "allowedCategories": null,        // or ["flirting", ...] once both confirm
  "categories": [ /* catalogue */ ]
}
```
- `403 SESSION_NOT_AUTHORIZED` if the caller is not a participant.
- `400 VALIDATION_ERROR` for unknown categories.

### `GET /api/sessions/:id/consent`
- Returns the same consent view for polling/resume. Participant-only.

### `POST /api/sessions/:id/leave`
- Leave an in-progress session. Never penalized. `200` → `state: "ABANDONED"`.

Valid consent categories (Increment 1): `romantic_conversation`, `flirting`,
`teasing`, `intense_romance`, `jealousy_themes`, `roleplay`, `power_dynamics`,
`public_setting`, `mystery`, `costume_roleplay`.

---

## Discovery & matching (Increment 2) — *all auth required*

Additional error codes: `USER_NOT_FOUND` (404), `CANNOT_INTERACT_WITH_SELF`
(400), `INTERACTION_NOT_ALLOWED` (403, deliberately generic — never reveals who
blocked whom), `MATCH_NOT_FOUND` (404), `MATCH_NOT_AUTHORIZED` (403).

### `GET /api/discovery?limit=&cursor=`
Returns eligible candidates for the authenticated viewer.

- `limit`: 1–50, default 20. Out-of-range → `400 VALIDATION_ERROR`.
- `cursor`: opaque keyset token from a previous page's `nextCursor`. A tampered
  cursor → `400 VALIDATION_ERROR`.
- Excludes (entirely in SQL): the viewer; users the viewer already liked or
  passed; blocks in **either** direction; users already matched with the viewer;
  disabled / soft-deleted / non-discoverable accounts.
- Ordering is deterministic on `(users.created_at, users.id)`, so pagination is
  stable (not random).

Response:
```jsonc
{
  "success": true,
  "data": {
    "candidates": [
      {
        "id": "UUID",
        "displayName": "Ava",
        "bio": "…",
        "interests": ["music"],
        "age": 30,          // null if the candidate hides their age
        "photo": { "id": "UUID", "storageKey": "…" } | null
      }
    ],
    "nextCursor": "opaque-base64url" | null   // null when no further pages
  }
}
```
Candidate objects contain **only** these fields — never email, DOB, auth, or
consent data.

### `POST /api/discovery/:userId/like`
Records a LIKE decision for the target and, if the target already likes the
caller, creates the mutual match (server-side, race-safe).

- `201`/`200` → `{ "action": "LIKE", "userId", "matched": bool, "matchId": uuid|null }`
- `400 CANNOT_INTERACT_WITH_SELF`; `404 USER_NOT_FOUND`;
  `403 INTERACTION_NOT_ALLOWED` if blocked in either direction;
  `400 VALIDATION_ERROR` for a malformed `userId`.
- Idempotent: repeating a like does not create duplicate rows or duplicate
  matches.

### `POST /api/discovery/:userId/pass`
Records a PASS decision; the target no longer appears in the caller's feed.

- `200` → `{ "action": "PASS", "userId", "matched": false, "matchId": null }`
- A pass never creates a match. Idempotent. A prior LIKE on the same target is
  converted to a PASS (one decision per actor→target; see "Decision semantics").

### `POST /api/users/:userId/block`  /  `DELETE /api/users/:userId/block`
Block (idempotent) or unblock (idempotent) another user.

- Block → `200 { "blocked": true, "userId" }`. It removes the user from both
  users' discovery feeds, rejects new likes in either direction, and sets any
  existing match for the pair to `BLOCKED` (removing it from active match
  lists).
- Unblock → `200 { "blocked": false, "userId" }`. It does **not** recreate a
  match, restore old likes, or undo historical decisions.
- `400 CANNOT_INTERACT_WITH_SELF`; `404 USER_NOT_FOUND` (block);
  `400 VALIDATION_ERROR` for a malformed `userId`.

### `GET /api/matches`
Lists the authenticated user's **ACTIVE** matches, newest first.
```jsonc
{
  "success": true,
  "data": {
    "matches": [
      { "matchId": "UUID",
        "user": { "id": "UUID", "displayName": "Ava", "photo": null },
        "createdAt": "…" }
    ]
  }
}
```
Returns only matches involving the caller; `BLOCKED`/inactive matches are
omitted; no private auth/consent data is included.

### `GET /api/matches/:matchId`
Returns a single match **only if the caller is one of its two participants**.

- `200` → `{ "match": { … } }` (same shape as a list item).
- `404 MATCH_NOT_FOUND` if it does not exist (or is not ACTIVE).
- `403 MATCH_NOT_AUTHORIZED` if it exists but the caller is not a participant —
  so match-ID enumeration cannot reveal another user's relationship.

### Decision semantics (LIKE / PASS)
A discovery decision is **one row per `(actor, target)`** (the `likes` table,
distinguished by `is_pass`). LIKE and PASS are mutually exclusive states of that
one decision: re-deciding **updates** the row rather than creating a
contradictory second one. There is therefore never a simultaneous like-and-pass
for the same pair.

### Pagination
Keyset (cursor) pagination over the deterministic `(created_at, id)` order. The
cursor is an opaque base64url token encoding only that ordering key (a public
user id + its created_at). `nextCursor` is `null` on the final page.
