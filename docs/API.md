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
