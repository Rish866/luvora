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

## Notifications & presence (Increment 7)

In-app notifications are **PostgreSQL-authoritative**. The WebSocket
`notification.created` and `presence.changed` events (delivered over the
existing `/ws/chat` and `/ws/game` connections) are a best-effort real-time
optimization — a client that misses them can always reconstruct exact state
from the REST endpoints below. There is **no** push delivery (no FCM/APNs/
web-push) in this increment.

All endpoints require authentication and operate only on the caller's own data.

### Notification DTO

A notification is returned as a safe, display-only shape — it never contains a
chat message body, consent answers, media storage keys, a reporter/moderator
identity, or a suspension reason:

```json
{
  "id": "uuid",
  "type": "MESSAGE_RECEIVED",
  "category": "MESSAGES",
  "title": "New message",
  "body": "You have a new message.",
  "entityType": "conversation",
  "entityId": "uuid",
  "readAt": null,
  "createdAt": "2026-10-05T12:00:00.000Z"
}
```

`type` ∈ `MATCH_CREATED` · `MESSAGE_RECEIVED` · `FANTASY_INVITE` ·
`FANTASY_ACCEPTED` · `FANTASY_STARTED` · `FANTASY_COMPLETED` · `SESSION_PAUSED` ·
`SESSION_RESUMED` · `SAFETY_ACTION` · `SYSTEM`. `category` ∈ `MATCHES` ·
`MESSAGES` · `FANTASY` · `SYSTEM` · `SAFETY`. `entityType`/`entityId` only
*reference* a related object; the client re-fetches and re-authorizes it through
the normal APIs.

### Feed & read state — *auth required*

```
GET  /api/notifications?unread=&limit=&cursor=
GET  /api/notifications/unread-count
POST /api/notifications/:id/read
POST /api/notifications/read-all
```

- `GET /api/notifications` — keyset-paginated, newest first. `unread=true`
  returns only unread. Expired notifications are excluded. Response:
  `{ notifications: NotificationView[], nextCursor: string | null }`. A malformed
  `cursor` is a `400`.
- `GET /api/notifications/unread-count` — `{ count }` (excludes expired).
- `POST /api/notifications/:id/read` — idempotent. Marking a notification that
  does not belong to the caller returns `404 NOTIFICATION_NOT_FOUND` (ownership
  is never revealed via a different status).
- `POST /api/notifications/read-all` — marks all of the caller's unread
  notifications read; affects no one else.

### Preferences — *auth required*

```
GET /api/notifications/preferences
PUT /api/notifications/preferences      { "category": "MATCHES", "enabled": false }
```

- `GET` returns every category with its effective enabled flag (a user with no
  stored rows sees all categories enabled by default).
- `PUT` sets one category's flag. Disabling a category suppresses future
  notifications of that category. The critical **SAFETY** category cannot be
  disabled — attempting to do so returns `400 CRITICAL_PREFERENCE`, and the
  service bypasses the preference check for SAFETY regardless of any stored row.

### Presence — *auth required, matched + not-blocked only*

```
GET /api/users/:userId/presence
```

Returns `{ status: "ONLINE" }`, or `{ status: "OFFLINE", lastSeenAt: string|null }`.
Visible only to users who share an `ACTIVE` match with the target **and** have no
block in either direction (the same trust relationship chat uses); a caller may
always query their own presence. Any other caller receives
`403 PRESENCE_NOT_AUTHORIZED` — a generic error that reveals neither account
existence nor online status. Presence exposes only `ONLINE`/`OFFLINE`
(+ last-seen); socket/device counts are never surfaced. A non-UUID `:userId` is a
`400`.

### Real-time events (over `/ws/chat` and `/ws/game`)

These user-scoped events are delivered to **all** of a user's authenticated
sockets across both channels; they are additive and do not change existing chat/
game protocols.

- `notification.created` → `{ type, notification: NotificationView }` — mirrors a
  freshly persisted notification (same safe DTO; no body leak).
- `presence.changed` → `{ type, userId, status, lastSeenAt? }` — emitted to the
  target's authorized observers (matched, non-blocked) who are themselves
  connected. `ONLINE` fires on a user's first socket; `OFFLINE` (with
  `lastSeenAt`) on their last socket closing. Strangers and blocked users never
  receive these events.

### Presence model & limitations

Presence is maintained by an in-process, ref-counted `PresenceRegistry` that
**both** gateways notify on connect/disconnect: a user is `ONLINE` while holding
any socket on either channel and `OFFLINE` only when the final one closes.
`users.last_seen_at` is persisted **only** on the `ONLINE→OFFLINE` transition.
Suspending a user force-closes their sockets, which flips them `OFFLINE` through
the same path. **Limitation:** this is process-local — across multiple backend
instances, presence would require a shared store / pub-sub (e.g. Redis), which is
not implemented in this increment.

## Notification delivery & devices (Increment 8)

Builds on Increment 7. PostgreSQL notifications remain authoritative; both the
WebSocket event and push delivery are **best-effort**. There is **no** real push
delivery in this increment — FCM/APNs/Web Push are interface placeholders; only
the TEST (dev/test) and DISABLED (default) providers actually run.

All endpoints require authentication and operate only on the caller's own data.

### Device registration — *auth required, rate-limited*

```
POST   /api/notifications/devices        { platform, provider, token, label? }
GET    /api/notifications/devices
DELETE /api/notifications/devices/:id
```

- `platform` ∈ `WEB` · `ANDROID` · `IOS`; `provider` ∈ `FCM` · `APNS` ·
  `WEB_PUSH` · `TEST` · `DISABLED`. `token` is an opaque provider credential
  (8–4096 chars).
- **Register** is idempotent: re-registering the same token for the caller
  updates it in place (one active row). The caller **always** owns the
  registration — a `userId` in the body is ignored.
- The response/list DTO exposes only safe metadata — **never the raw token**:
  ```json
  {
    "id": "uuid",
    "platform": "ANDROID",
    "provider": "FCM",
    "tokenFingerprint": "a1b2c3d4e5f6",
    "label": "Pixel 8",
    "active": true,
    "createdAt": "…",
    "lastSeenAt": "…",
    "revokedAt": null
  }
  ```
- **Delete** revokes the caller's device. Revoking a device that does not exist
  or belongs to another user returns `404 DEVICE_NOT_FOUND` (opaque — a device
  id cannot be probed via IDOR).

### Push preferences

The existing preferences endpoint accepts a `pushEnabled` toggle, **distinct**
from `enabled` (which controls whether the in-app notification is created):

```
PUT /api/notifications/preferences   { "category": "MESSAGES", "pushEnabled": false }
```

Disabling push for a category suppresses **PUSH delivery only** — the in-app
notification is still created and still appears in the feed. The critical
**SAFETY** category cannot be disabled for push either (`400 CRITICAL_PREFERENCE`).
The preferences view now returns both flags per category: `{ category, enabled,
pushEnabled }`.

### Delivery pipeline & semantics

When a notification is created, the service runs a best-effort pipeline:
realtime `notification.created` → record the realtime attempt → push to the
recipient's active devices (honouring the push preference; SAFETY always). It
never throws, so a provider outage cannot roll back the notification.

- **Minimal push payload** — carries only opaque references, never content:
  ```json
  { "type": "MESSAGE_RECEIVED", "notificationId": "uuid",
    "category": "MESSAGES", "entityType": "conversation", "entityId": "uuid" }
  ```
  No title/body text, message content, consent answers, media keys, moderation
  details, suspension reason, or tokens. The client re-fetches via the
  authenticated feed.
- **Idempotent** — delivery rows are unique per `(notification, device,
  channel)`; reprocessing the same notification never duplicates a delivery.
- **Retries** — a temporary provider failure (timeout/unavailable) is retried up
  to 5 attempts by `retryFailedDeliveries()` (a callable a future worker invokes;
  no cron is introduced). A permanent failure (invalid/unregistered token)
  revokes the device and is never retried.

### Admin device diagnostics — *admin only, audited*

```
GET /api/admin/users/:id/devices
```

Returns each device's safe metadata plus its last delivery status/error/time —
**never** the raw token. The inspection is recorded in the audit log. Moderators
have no device-inspection endpoint.

### Presence heartbeat / TTL

Presence now has a heartbeat/TTL model: each WebSocket connection refreshes a
per-connection TTL on every ping-pong and on inbound activity. A periodic reaper
reclaims connections whose TTL lapsed (e.g. a crashed process that never sent a
clean disconnect), flipping the user `OFFLINE`, persisting `last_seen_at`, and
emitting `presence.changed` to authorized observers — the same privacy rules as
Increment 7 (matched + not blocked). Configurable via `PRESENCE_HEARTBEAT_SECONDS`
/ `PRESENCE_TTL_SECONDS`.

### Scaling model & limitations (honest)

Presence (`PresenceBackend`) and the realtime bus (`RealtimeBus`) are factored
behind interfaces so a distributed implementation (e.g. Redis TTL keys + pub/sub)
can be dropped in. **Those distributed implementations are not built**: selecting
`PRESENCE_BACKEND=distributed` or `REALTIME_BUS=distributed` degrades safely to
the in-process implementation and logs a warning. Redis is never required.
Likewise, `FcmPushProvider` / `ApnsPushProvider` are placeholders with no SDK or
credentials and do not deliver. The system is fully functional single-instance
with in-app + WebSocket notifications and the TEST/DISABLED push providers.

## Background jobs & worker (Increment 9)

Asynchronous work (notification push delivery, cleanup, presence reconciliation)
runs on a durable, PostgreSQL-backed job queue processed by a worker — no Redis
or external broker. PostgreSQL is the source of truth for job state; execution
is **at-least-once** (handlers are idempotent). There is no client API to
enqueue jobs; only trusted server code enqueues.

### Running the worker

The worker runs independently of the API server:

```
npm run worker        # dedicated worker process (recommended)
```

The API server does NOT require a worker — the queue persists in PostgreSQL.
Optionally, set `JOB_WORKER_ENABLED=true` to also run an embedded worker inside
the API process (off by default; the normal API behaviour is unchanged).

### Delivery flow (notification → durable job → worker → provider)

```
domain event → notificationService
             → persist notification + enqueue NOTIFICATION_PUSH_DELIVERY
               (SAME transaction — outbox)                → API responds
                                                            │
worker: claim (FOR UPDATE SKIP LOCKED) → handler → deliveryService
      → PushProvider → notification_deliveries (idempotent)
      → success | retry (backoff) | dead-letter
```

A notification is never left without its enqueued delivery job (they commit
together). The notification API succeeds even when the push provider is down —
the job retries later. SAFETY delivery jobs are enqueued at high priority.

### Retry / lease / dead-letter semantics

- **Lease:** a claimed job is `RUNNING` with a `leased_until`; the worker
  heartbeats to extend it. If a worker crashes, the lease expires and another
  worker reclaims the job (attempt count preserved) — nothing stays stuck.
- **Retry:** temporary failures → `RETRY_WAIT` with exponential backoff + jitter,
  bounded by `max_attempts` (default 5).
- **Permanent failure / exhausted attempts:** `DEAD` (dead-letter), retained for
  inspection; never retried further.
- A permanently invalid push token revokes its device (via the delivery
  pipeline); the delivery job itself then succeeds (nothing left to deliver).

### Admin diagnostics — *admin only, read-only*

```
GET /api/admin/jobs?status=&jobType=&limit=&cursor=
GET /api/admin/jobs/:id
GET /api/admin/jobs/metrics
GET /api/admin/jobs/worker
```

- Keyset-paginated job list, filterable by status / type. A missing job id
  returns `JOB_NOT_FOUND`.
- Each job DTO exposes only a **redacted `payloadSummary`** (safe scalar keys —
  ids/flags); the raw payload is never returned, and keys that look sensitive
  (token/password/secret/etc.) are dropped.
- `metrics` returns queue counts by status and type plus in-process counters
  (`jobs_enqueued` / `_claimed` / `_succeeded` / `_retried` / `_dead` /
  `_reclaimed`) and average execution durations.
- `worker` returns the health of the embedded worker in THIS process
  (`{ workerId, running, stopping, concurrency, activeJobs, lastPollAt,
  lastSuccessAt, lastErrorCode }`) or `null` when none runs here.
- Normal users and moderators get `403`; unauthenticated get `401`.

### Honest limitations

Execution is at-least-once, not exactly-once; a job may run more than once, so
handlers are idempotent. An external push provider could still receive a
duplicate request if a crash occurs after provider acceptance but before the DB
records success — Luvora does not claim exactly-once external push delivery.
Multiple workers scale only as far as PostgreSQL row-locking against the same
database allows; there is no Redis/broker and no cross-datacentre coordination.

## Observability & operational controls (Increment 10)

A lightweight, PostgreSQL/Node-based observability layer: correlation ids,
structured logging, in-process metrics, improved health/readiness, worker/queue
health, and admin job operations. No Redis / Prometheus server / APM vendor.

### Correlation ids

Every HTTP response carries an `X-Correlation-Id` header. A safe inbound
`X-Correlation-Id` (alphanumerics + `._:-`, ≤ 128 chars) is honoured; a missing,
oversized, or malformed value is replaced by a fresh random id. The id flows
through logs, operational events, and error handling. It is **never** a trusted
security identifier — authorization always uses the authenticated user.

### Health & readiness

```
GET /health   → 200 { status: "ok", uptimeSeconds }
GET /ready    → 200 { status: "ready", checks: { database, migrations, worker } }
              → 503 { status: "not_ready", checks: {...} } when a critical dep is down
```

`/health` is cheap liveness and does NOT fail because an optional component
(worker/push/distributed backend) is unavailable. `/ready` verifies PostgreSQL
reachability + schema; a disabled embedded worker reports `"worker":"disabled"`
and does NOT make the API not-ready (the worker may run as a separate process).
Neither endpoint leaks connection strings, SQL, filesystem paths, credentials,
or stack traces.

### Metrics — `GET /metrics`

Prometheus text exposition format. Access is configurable:

- `METRICS_ENABLED=false` → `404 METRICS_DISABLED`.
- `METRICS_REQUIRE_AUTH=true` (default) → requires an **ADMIN** access token
  (`401 METRICS_UNAUTHORIZED` otherwise).

Exposed metric families (process-local; see limitation below): HTTP
(`http_requests_total`, `http_errors_total`, `http_request_duration_ms`), DB
(`db_queries_total`, `db_query_errors_total`, `db_query_duration_ms`), WebSocket
(`websocket_connections_total`, `_disconnects_total`, `_messages_total`,
`_errors_total`), notifications (`notifications_created_total`,
`notifications_deduplicated_total`, `notification_push_jobs_enqueued_total`,
`notification_push_sent_total`, `_failed_total`, `_revoked_total`), and jobs
(`jobs_enqueued_total`, `_claimed_total`, `_succeeded_total`, `_retried_total`,
`_dead_total`, `_reclaimed_total`, `jobs_execution_duration_ms`,
`jobs_queue_wait_duration_ms`). **Labels are bounded**: routes use the Express
template (UUIDs collapse to `:id`), status is a class (`2xx`..`5xx`), channels
are `chat`/`game`, job labels come from fixed enums — and a hard per-metric
series cap prevents unbounded cardinality. The output contains no PII, tokens,
SQL, or payloads.

### Worker health + queue pressure — `GET /api/admin/jobs/worker` *(admin)*

Returns the embedded worker's health (or a `DISABLED` view that still carries
queue stats when no worker runs in this process): `state`
(`RUNNING`/`STOPPING`/`STOPPED`/`DISABLED`/`UNHEALTHY`), `activeJobs`,
`concurrency`, `lastPollAt`, `lastSuccessAt`, `consecutiveErrors`, `queueDepth`,
`oldestPendingAgeSeconds`, `staleRunningCount`, `deadJobCount`, and
`queuePressure` (`OK`/`WARNING`/`CRITICAL`) derived from
`JOB_QUEUE_WARNING_DEPTH` / `JOB_QUEUE_CRITICAL_DEPTH` / `JOB_QUEUE_MAX_AGE_SECONDS`.
A disabled worker is never reported UNHEALTHY.

### Admin job operations *(admin only, audited, IDOR-safe)*

```
GET  /api/admin/jobs/dead                 # dead-letter diagnostics (redacted)
POST /api/admin/jobs/:id/retry   { reason? }   # requeue a DEAD job
POST /api/admin/jobs/:id/cancel  { reason? }   # cancel a queued job
GET  /api/admin/operational-events?eventType=&severity=&limit=&cursor=
GET  /api/admin/security-events?eventType=&category=&severity=&limit=&cursor=
```

- **Security events** (Increment 11, admin only) are the durable record of
  low-volume, significant security events: brute-force lockouts, login
  throttles, and refresh-token reuse. Keyset-paginated and filterable by
  `eventType`/`category`/`severity`. The client source is exposed ONLY as a
  salted fingerprint — the raw IP is never stored or returned — so this endpoint
  cannot be used to deanonymise or track users. Non-admins get `403`.

- **Retry** requeues a **DEAD** job back to `PENDING` (attempts reset, lease/
  error cleared, immediately available). SUCCEEDED/RUNNING jobs are refused
  (`JOB_NOT_RETRYABLE`). Idempotency is preserved — the job's own idempotency key
  still prevents a duplicate LIVE copy. Records an audit log + a
  `JOB_MANUALLY_REQUEUED` operational event (no raw payload).
- **Cancel** marks a `PENDING`/`RETRY_WAIT` job `CANCELLED`. A **RUNNING** job is
  refused (`JOB_NOT_CANCELLABLE`): the handler may already be executing an
  external call that cannot be aborted — the API does not pretend to kill it.
  Records an audit log + a `JOB_CANCELLED` operational event.
- **Dead-letter listing** returns `DEAD` jobs with the same redacted
  `payloadSummary` as other job diagnostics — never the raw payload.
- Non-admins get `403`; unauthenticated get `401`.

New error codes: `JOB_NOT_RETRYABLE`, `JOB_NOT_CANCELLABLE`, `METRICS_DISABLED`,
`METRICS_UNAUTHORIZED`, `OPERATION_NOT_ALLOWED`, `SERVICE_NOT_READY`.

### Honest limitations

Metrics are **process-local**: with multiple server/worker processes the values
are per-process and are NOT aggregated across them — a future scrape/aggregation
layer (e.g. a Prometheus server scraping each `/metrics`) would do that. Worker
and job state is PostgreSQL-backed and shared; the operational-event table is
durable. External push remains provider-dependent (TEST/DISABLED only). Job
execution is at-least-once — exactly-once external side effects are not claimed.
