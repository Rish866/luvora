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

---

## Private chat (Increment 3)

Chat is available **only between the two participants of an `ACTIVE` match**.
There is exactly one conversation per match, created lazily and race-safely on
first access. Authorization always derives from the authenticated identity + the
match relationship — knowing a `matchId` or `conversationId` is never enough.

Additional error codes: `CONVERSATION_NOT_FOUND` (404), `CHAT_NOT_AUTHORIZED`
(403 — generic; also used for blocked relationships so block details never
leak), `MATCH_NOT_ACTIVE` (409), `MESSAGE_EMPTY` (400), `MESSAGE_TOO_LONG`
(400), `INVALID_CURSOR` (400), `INVALID_WEBSOCKET_MESSAGE` (400).

Message size limit: **4000 Unicode code points** (enforced in the application;
empty / whitespace-only bodies are rejected).

### REST — `*all auth required*`

#### `GET /api/matches/:matchId/messages?limit=&cursor=`
Paginated history for the match's conversation (creating the conversation if it
does not yet exist).

- `limit`: 1–100, default 50. `cursor`: opaque token from `nextCursor`.
- Messages are returned **oldest→newest** within the page; `nextCursor` pages
  further **back** into history (older messages). Ordering is deterministic on
  `(created_at, id)`.
- `403 CHAT_NOT_AUTHORIZED` for non-participants and blocked matches;
  `409 MATCH_NOT_ACTIVE` for a non-active (e.g. UNMATCHED) match;
  `400 INVALID_CURSOR` for a tampered cursor.

```jsonc
{
  "success": true,
  "data": {
    "conversationId": "UUID",
    "messages": [
      { "id": "UUID", "conversationId": "UUID", "senderId": "UUID",
        "body": "Hello 👋", "clientMessageId": null, "createdAt": "…" }
    ],
    "nextCursor": "opaque" | null
  }
}
```

#### `POST /api/matches/:matchId/messages`
Create a message. The sender is **always** the authenticated user; any
`senderId`/`id` in the body is ignored.

```jsonc
// request
{ "body": "Hello 👋", "clientMessageId": "optional-uuid" }
// 201
{ "success": true, "data": { "message": { /* ChatMessage */ } } }
```
- `400 MESSAGE_EMPTY` / `400 MESSAGE_TOO_LONG`; `403 CHAT_NOT_AUTHORIZED` for
  non-participants / blocked matches.
- **Idempotency:** repeating a send with the same `clientMessageId` (per
  conversation + sender) returns the existing message rather than creating a
  duplicate.

Both the REST `POST` and the WebSocket `message.send` go through the **same**
message service, so authorization/validation/persistence are identical.

---

## WebSocket chat gateway (Increment 3)

The gateway runs on the **same HTTP server/port** as the REST API.

```
ws(s)://<host>/ws/chat
```

### Authentication (handshake)
Authentication happens during the HTTP upgrade and is **mandatory** — an
unauthenticated upgrade is rejected with `401` before any WebSocket is
established. Provide the existing **access token** either as:

- `Authorization: Bearer <access-token>` (preferred), or
- `?access_token=<access-token>` query parameter (for browser clients that
  cannot set handshake headers).

Tokens are never logged. Refresh tokens must **not** be used here. On success
the server immediately sends `connection.ready`.

### Client → server events
```jsonc
{ "type": "message.send", "conversationId": "UUID", "body": "Hello", "clientMessageId": "optional-uuid" }
{ "type": "message.read", "conversationId": "UUID", "messageId": "UUID" }
{ "type": "typing.start", "conversationId": "UUID" }
{ "type": "typing.stop",  "conversationId": "UUID" }
```
Any client-supplied sender/user id is ignored; the server always uses the
authenticated connection identity.

### Server → client events
```jsonc
{ "type": "connection.ready", "userId": "UUID" }
{ "type": "message.created", "message": { "id": "UUID", "conversationId": "UUID",
   "senderId": "UUID", "body": "Hello", "clientMessageId": null, "createdAt": "…" } }
{ "type": "message.read", "conversationId": "UUID", "messageId": "UUID", "userId": "UUID" }
{ "type": "typing", "conversationId": "UUID", "userId": "UUID", "state": "start" | "stop" }
{ "type": "presence", "conversationId": "UUID", "userId": "UUID", "state": "online" | "offline" }
{ "type": "chat.blocked", "conversationId": "UUID" }
{ "type": "error", "code": "CHAT_NOT_AUTHORIZED", "message": "…", "clientMessageId": "…?" }
```

### Semantics & guarantees
- **Persist-then-broadcast:** a message is written to PostgreSQL before any
  `message.created` is emitted. The DB record is authoritative; `id` is
  server-generated.
- **Recipient routing:** `message.created` is delivered only to the two match
  participants' sockets — never globally. A user may have multiple sockets
  (phone/browser/tablet); all receive the event, but only one DB row is written.
- **Block enforcement:** every `message.send` (and read/typing) is
  re-authorized against the current match state, so a block takes effect
  immediately even on a pre-existing socket. When a block invalidates a match,
  connected sockets receive `chat.blocked`.
- **Read receipts:** `message.read` validates the message belongs to the
  conversation, stores a per-user "last read" marker, and notifies the partner
  with the authenticated `userId`.
- **Typing / presence** are ephemeral (never persisted) and routed only to the
  matched partner.
- **Malformed input** (bad JSON, unknown event type, invalid UUID, oversized /
  empty body) returns a structured `error` event and never crashes the server.
- **Heartbeat:** the server pings periodically and terminates unresponsive
  sockets; disconnects clean up the in-memory registry.

### Limitation
WebSocket presence/delivery state is **process-local**. A multi-instance
deployment would need a shared pub/sub (e.g. Redis); that is deferred to a later
hardening increment.

---

## Scenario library & data-driven gameplay (Increment 4)

Luvora's fantasy engine is **data-driven** (scenario content lives in the
database, not in code) and **server-authoritative**: the client submits intent
(a choice id), never state. Scenario **versions are immutable** — a running
session pins one `scenario_version_id` and is unaffected if a newer version is
later published.

New error codes: `SCENARIO_NOT_FOUND` (404), `SCENARIO_NOT_PUBLISHED` (409),
`SCENARIO_NOT_AVAILABLE` (409), `SESSION_NOT_READY` (409), `SESSION_NOT_PLAYING`
(409), `GAME_NOT_AUTHORIZED` (403), `INVALID_CHOICE` (400), `CHOICE_NOT_AVAILABLE`
(403), `CONSENT_REQUIRED` (403), `GAME_STATE_CONFLICT` (409),
`GAME_ALREADY_COMPLETED` (409).

### Scenario library — `*auth required*`

#### `GET /api/scenarios?limit=&cursor=`
Lists **published** scenarios only (keyset pagination over `(created_at, id)`,
opaque cursor). Draft/archived scenarios and internal authoring data are never
exposed.
```jsonc
{ "success": true, "data": { "scenarios": [
  { "id": "UUID", "slug": "the-midnight-masquerade", "title": "…",
    "description": "…", "category": "romance", "coverImageUrl": null,
    "tags": ["masquerade"], "estimatedMinutes": 10 } ], "nextCursor": null } }
```

#### `GET /api/scenarios/:scenarioId`
Returns one published scenario summary. `404 SCENARIO_NOT_FOUND` for unknown or
non-published scenarios.

### Gameplay — `*auth required, participant-only*`

All endpoints below authorize via the session's match participants; a
non-participant always receives `403 GAME_NOT_AUTHORIZED`. The server derives
`currentNodeId`, `turnNumber`, `scenarioVersionId`, and `sessionState` — any
such fields in a request body are ignored.

#### `POST /api/sessions/:id/scenario`
Body: `{ "scenarioId": "UUID" }`. Selects the latest **published** version of a
scenario for a session that is already `PLAYING` (i.e. both players consented).
Pins the version + start node. Idempotent (a second select returns current
state). Errors: `409 SESSION_NOT_READY` (not yet PLAYING),
`404 SCENARIO_NOT_FOUND`, `409 SCENARIO_NOT_AVAILABLE`.
Returns `201 { state: GameState }`.

#### `GET /api/sessions/:id/state`
Authoritative, DB-sourced game state (reconnect-safe):
```jsonc
{ "success": true, "data": { "state": {
  "sessionId": "UUID", "sessionState": "PLAYING",
  "scenarioVersionId": "UUID", "turnNumber": 1, "stateVersion": 2,
  "completed": false,
  "node": { "id": "UUID", "key": "dance", "type": "CHOICE", "title": "…",
    "content": "…", "isEnding": false,
    "choices": [ { "id": "UUID", "key": "flirt", "label": "…", "description": "…",
      "available": true, "requires": ["flirting"] } ] } } } }
```
`available` reflects whether every required consent category is in the **mutual**
allow-list — it never exposes the partner's individual YES/MAYBE/NO.

#### `POST /api/sessions/:id/choices/:choiceId`
Body: `{ "clientActionId": "UUID" }`. Submits a choice. The server validates the
choice belongs to the current node, re-evaluates consent requirements, advances
to the server-resolved next node in a transaction (optimistic `state_version` +
`SELECT … FOR UPDATE`), and — if the destination is an ENDING — marks the
session `COMPLETED`. Idempotent per `clientActionId`. Errors: `400 INVALID_CHOICE`,
`403 CONSENT_REQUIRED`, `409 GAME_STATE_CONFLICT`, `409 GAME_ALREADY_COMPLETED`,
`409 SESSION_NOT_PLAYING`. Returns `{ state: GameState }`.

#### `POST /api/sessions/:id/pause` · `POST /api/sessions/:id/resume`
Toggle `PLAYING ↔ PAUSED` using the existing session state machine.

### Gameplay WebSocket (`/ws/game`)
Same HTTP port as `/ws/chat`; one shared dispatcher authenticates the handshake
(access token via header or `?access_token`) and routes by path. Unauthenticated
or unknown-path upgrades are rejected.

Client → server:
```jsonc
{ "type": "game.subscribe", "sessionId": "UUID" }
{ "type": "game.choose", "sessionId": "UUID", "choiceId": "UUID", "clientActionId": "UUID" }
```
Server → client:
```jsonc
{ "type": "game.ready", "userId": "UUID" }
{ "type": "game.state", "state": { /* GameState */ } }          // on subscribe
{ "type": "game.state.changed", "state": { /* GameState */ } }  // after a choice
{ "type": "game.completed", "state": { /* GameState */ } }      // ending reached
{ "type": "game.error", "code": "…", "message": "…", "clientActionId": "…?" }
```
`game.choose` runs the same authoritative engine as the REST endpoint
(persist-then-broadcast); the resulting state is delivered to **both**
participants' sockets only. `game.subscribe` returns authoritative DB state, so a
reconnecting client recovers without replaying missed events.

---

## Secure media & attachments (Increment 5)

Images only (`image/jpeg`, `image/png`, `image/webp`). Every upload is inspected
server-side (magic bytes + decode), normalized (EXIF/GPS stripped), scanned, and
moderated before it can become `READY`+`APPROVED`. Storage keys are opaque and
never exposed; clients receive authenticated application URLs.

New error codes: `MEDIA_NOT_FOUND` (404), `MEDIA_NOT_AUTHORIZED` (403),
`MEDIA_INVALID_STATE` (409), `MEDIA_TYPE_NOT_ALLOWED` (400), `MEDIA_TOO_LARGE`
(413), `MEDIA_INVALID_CONTENT` (400), `MEDIA_MIME_MISMATCH` (400),
`MEDIA_NOT_READY` (409), `MEDIA_REJECTED` (409), `TOO_MANY_ATTACHMENTS` (400),
`ATTACHMENTS_TOO_LARGE` (413).

### Upload lifecycle (two-step) — *auth required*

#### `POST /api/media` — create upload intent
```jsonc
// request
{ "filename": "photo.jpg", "mimeType": "image/jpeg", "sizeBytes": 123456, "context": "chat" }
// 201
{ "success": true, "data": {
  "mediaId": "UUID", "status": "UPLOADING",
  "uploadUrl": "/api/media/UUID/content", "maxBytes": 10485760 } }
```
Validates the *declared* type/size cheaply and generates an opaque storage key.
`400 MEDIA_TYPE_NOT_ALLOWED`, `413 MEDIA_TOO_LARGE`.

#### `PUT /api/media/:mediaId/content` — upload bytes (raw binary)
Owner-only, asset must be `UPLOADING`. Runs the full pipeline (see below).
Returns the `MediaAssetView` with `status: READY`, `moderationStatus: APPROVED`
on success. Failure modes: `403 MEDIA_NOT_AUTHORIZED`, `409 MEDIA_INVALID_STATE`,
`400 MEDIA_INVALID_CONTENT` (not a decodable image), `400 MEDIA_MIME_MISMATCH`
(declared ≠ detected), `413 MEDIA_TOO_LARGE`, `409 MEDIA_REJECTED` (malware /
moderation / quarantine).

### Access & management — *auth + authorization required*

- `GET /api/media/:mediaId` — JSON `MediaAssetView` (owner sees moderation
  progress; others only via an authorized conversation). No storage key / sha256
  / filename exposed.
- `GET /api/media/:mediaId/content` — normalized image bytes. Headers:
  `Content-Type`, `Content-Length`, `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`. Only `READY` assets stream; others `409`.
- `GET /api/media/:mediaId/thumbnail` — thumbnail bytes (same auth).
- `DELETE /api/media/:mediaId` — owner-only soft delete; subsequent downloads
  `404`.
- `POST /api/media/:mediaId/report` — body `{ "reason": "CSAM|NONCONSENSUAL|VIOLENCE|HARASSMENT|SPAM|OTHER" }`.
  Reporter must be able to see the media; duplicate reports are throttled; a
  sensitive report quarantines the asset for review. Reporter identity is never
  exposed.

**Authorization.** `GET /api/media/:id` is NOT public. Access = the owner, OR a
participant of a conversation the asset is attached to **where the chat policy
currently permits** (ACTIVE match, no block either direction). Guessing a UUID
grants nothing; a block immediately revokes a recipient's media access.

### Pipeline (what the server does on upload)
```
ownership + state → size guard → magic-byte + decode detection →
declared-vs-detected MIME agreement → dimension / decompression-bomb limits →
SHA-256(original) → malware scan → normalize + strip EXIF/GPS + thumbnail →
content moderation → persist derived metadata + resolved statuses → store bytes
```
Only `APPROVED` ⇒ `READY`. `REJECTED` ⇒ `REJECTED`. `NEEDS_REVIEW` / scanner
`UNKNOWN` (quarantine policy) ⇒ `QUARANTINED` (not usable). The **normalized**
image is stored and served — never the raw original.

### Chat attachments
`POST /api/matches/:matchId/messages` now accepts:
```jsonc
{ "body": "optional text", "clientMessageId": "optional-uuid",
  "attachmentIds": ["media-uuid", ...] }
```
A message needs text OR ≥1 attachment. Each attachment must be owned by the
sender, `READY`+`APPROVED`, not deleted, within count/size limits. Message +
attachment rows are committed in ONE transaction (no partial state); duplicate
`clientMessageId` stays idempotent (no duplicate attachment rows). The response
and history include safe `attachments` DTOs:
```jsonc
{ "id": "media-uuid", "mimeType": "image/jpeg", "byteSize": 12345,
  "width": 1200, "height": 900, "url": "/api/media/.../content",
  "thumbnailUrl": "/api/media/.../thumbnail" }
```

### WebSocket (`/ws/chat`)
`message.send` accepts an optional `attachmentIds` array; the server validates
them (same rules) and includes safe `attachments` DTOs in the broadcast
`message.created` event. `/ws/chat` and `/ws/game` are unchanged otherwise.

---

## Admin, safety & moderation (Increment 6)

The moderator/admin control plane is **server-authoritative**: roles and account
state live only in the database and are never read from client input (body,
query, headers, or JWT claims). All `/api/admin/*` routes require authentication
AND a sufficient server-side role.

### Roles & permissions
- `USER` — normal app access only. No admin/moderator endpoints.
- `MODERATOR` — moderation queue, report review/assign/resolve, media review +
  approve/reject/quarantine.
- `ADMIN` — everything a moderator can do, plus user suspend/unsuspend/
  deactivate/reactivate, role management, and audit-log read.

New error codes: `FORBIDDEN_ROLE` (403), `ACCOUNT_SUSPENDED` (403),
`ACCOUNT_DEACTIVATED` (403), `REPORT_NOT_FOUND` (404),
`REPORT_INVALID_TRANSITION` (409), `DUPLICATE_REPORT` (409),
`INVALID_REPORT_TARGET` (404), `CANNOT_TARGET_SELF` (400),
`INVALID_MODERATION_TRANSITION` (409), `CANNOT_SUSPEND_SELF` (400),
`LAST_ADMIN` (409), `INVALID_ROLE` (400).

### Reporting — *auth required*
```
POST /api/reports/user/:userId
POST /api/reports/media/:mediaId
POST /api/reports/message/:messageId
POST /api/reports/session/:sessionId
```
Body: `{ "reason": "CSAM|NONCONSENSUAL|VIOLENCE|HARASSMENT|SPAM|HATE|SELF_HARM|OTHER", "description": "optional" }`.
The server validates the target exists AND the reporter is authorized to see it
(so reporting cannot probe for the existence of private content). Self-reporting
a user is rejected. Duplicate open reports against the same target are rejected
(`DUPLICATE_REPORT`). Rate-limited. **The reporter's identity is never exposed to
the reported user** — reports are private safety records.

### Moderation queue & reports — *moderator+*
```
GET  /api/admin/moderation/queue?limit=&cursor=&priority=&targetType=   # OPEN reports
GET  /api/admin/reports?status=&priority=&targetType=&assignedTo=&limit=&cursor=
GET  /api/admin/reports/:id
POST /api/admin/reports/:id/assign          # OPEN -> IN_REVIEW (records moderator)
POST /api/admin/reports/:id/resolve         # body { status: RESOLVED|DISMISSED, resolution? }
```
Keyset pagination with opaque cursors. Report states: `OPEN → IN_REVIEW →
RESOLVED|DISMISSED` (terminal); invalid transitions are rejected. Reports are
never deleted.

### Media moderation — *moderator+*
```
GET  /api/admin/media/:id                   # review metadata + moderation-action history
GET  /api/admin/media/:id/content           # privileged byte review (even if quarantined/rejected)
GET  /api/admin/media/:id/thumbnail
POST /api/admin/media/:id/approve           # -> APPROVED / READY
POST /api/admin/media/:id/reject            # body { reason } -> REJECTED / REJECTED
POST /api/admin/media/:id/quarantine        # body { reason } -> NEEDS_REVIEW / QUARANTINED
```
Transitions are validated against the moderation state machine and run in a
transaction (lock row → validate → update moderation+upload status → record
moderation action + audit → commit). Deleted media cannot be approved. Rejected/
quarantined media is never served through the normal `GET /api/media/:id/content`
path. The admin review byte endpoint still enforces the moderator role.

### User safety — *admin only*
```
POST /api/admin/users/:id/suspend     # body { reason, durationHours? }  (server computes expiry)
POST /api/admin/users/:id/unsuspend
POST /api/admin/users/:id/deactivate  # body { reason }
POST /api/admin/users/:id/reactivate
```
Suspend/deactivate revoke all auth sessions and close the user's live WebSocket
connections. Safeguards: an admin cannot suspend/deactivate themselves; the last
remaining admin cannot be deactivated or demoted. Suspensions with a duration
auto-lapse to ACTIVE after expiry (no scheduler needed).

### Role management — *admin only*
```
GET  /api/admin/users/:id/role
POST /api/admin/users/:id/role        # body { role: USER|MODERATOR|ADMIN }
```
Moderators cannot change roles. Demoting the last admin is rejected (`LAST_ADMIN`).
Role changes are audited and revoke the target's sessions.

### Audit logs — *admin only, read-only*
```
GET /api/admin/audit-logs?action=&actorUserId=&targetType=&targetId=&limit=&cursor=
```
Keyset-paginated. Entries are append-only — there is deliberately **no** update/
delete API. Metadata is sanitized (no tokens, passwords, auth headers, message
bodies, storage keys, or raw bytes).

### WebSocket safety
`/ws/chat` and `/ws/game` continue to work unchanged for active users. The
handshake rejects suspended/deactivated accounts; every inbound event
re-checks live account state; and suspending/deactivating a user force-closes
their open sockets (close code 4403). An already-authenticated socket cannot
outlive a suspension.

### Production admin provisioning
There is **no** admin-bootstrap endpoint, secret header, or magic account in the
application. The first administrator is provisioned out-of-band by an operator
with database access, e.g.:
```sql
UPDATE users SET role = 'ADMIN' WHERE email = 'ops@yourdomain' AND deleted_at IS NULL;
```
Thereafter admins manage roles through the audited `POST /api/admin/users/:id/role`.
