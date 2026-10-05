# Messaging & Inbox API (Increment 15)

The frontend contract for building a complete messaging inbox:
**conversation → last message → timestamp → unread count → mark as read**,
on top of the existing REST + WebSocket messaging. No new read-state model was
introduced — read receipts (REST and WebSocket) and unread counts all derive
from the single per-user marker in `conversation_read_state`.

- All endpoints require `Authorization: Bearer <accessToken>`.
- Envelope: `{ "success": true, "data": … }` or
  `{ "success": false, "error": { "code", "message", "details?" } }`.
- A conversation is backed 1:1 by a `match`; it is created lazily on first
  message/read. The inbox always returns a stable `conversationId`.

---

## Inbox — `GET /api/matches`

The match list is also the inbox. Each row carries the other user's identity +
profile photo, the backing `conversationId`, a last-message preview, and the
viewer's unread count. The response also includes a convenience total.

**Response** `200`:
```jsonc
{
  "matches": [
    {
      "matchId": "…uuid",
      "createdAt": "2026-…Z",
      "user": {
        "id": "…uuid",
        "displayName": "Jordan",
        "photo": { "mediaId": "…", "url": "/api/media/…/content", "thumbnailUrl": "…|null" } // or null
      },
      "conversationId": "…uuid",
      "lastMessage": {                 // null when no messages yet
        "id": "…uuid",
        "text": "see you tonight",     // "" for an attachment-only message
        "senderId": "…uuid",
        "createdAt": "2026-…Z",
        "hasAttachments": false
      },
      "unreadCount": 2
    }
  ],
  "totalUnreadCount": 5
}
```

- Matches are ordered newest-first (by match `createdAt`), unchanged from before.
- `lastMessage` exposes ONLY inbox-safe fields — never storage keys, moderation
  metadata, `client_message_id`, or `conversation_id` internals. For an
  attachment-only message `text` is `""` and `hasAttachments` is `true` so the
  client can render a placeholder (e.g. "📷 Photo").
- `totalUnreadCount` = sum of unread across all the viewer's ACTIVE,
  non-blocked matches. Computed from existing message/read state (no counter
  table / cache).

## Match detail — `GET /api/matches/:matchId`

Returns a single `MatchSummary` with the SAME inbox fields (`conversationId`,
`lastMessage`, `unreadCount`), so a thread screen opened directly by match id is
consistent with the inbox. `403 MATCH_NOT_AUTHORIZED` for a non-participant;
`404 MATCH_NOT_FOUND` for a missing or non-ACTIVE match (never leaks existence).

---

## Messages — `GET /api/matches/:matchId/messages?limit=&cursor=`

Unchanged keyset-paginated history (oldest→newest within a page; `nextCursor`
pages further back). `limit` 1–100 (default 50). Each message:
`{ id, conversationId, senderId, body, clientMessageId, createdAt, attachments[] }`.

## Send — `POST /api/matches/:matchId/messages`

Unchanged. Body: `{ body?, clientMessageId?, attachmentIds? }` (text and/or
attachments; `clientMessageId` for idempotency). Returns `201 { message }` and
broadcasts to both participants' live sockets.

---

## Read receipt — `POST /api/conversations/:conversationId/read`

Mark the WHOLE conversation read for the caller: advances the caller's read
marker to the newest message. Idempotent.

**Response** `200`:
```jsonc
{
  "conversationId": "…uuid",
  "lastReadMessageId": "…uuid",   // null if the conversation has no messages
  "unreadCount": 0
}
```

- Authorization: the caller must be an eligible participant (ACTIVE match, no
  block). A user can never mark another user's conversation read.
- Reading only affects the CALLER's unread; the partner's state is untouched.
- Mirrors the WebSocket read receipt: on success the partner's live clients
  receive a `message.read` event (see WebSocket relationship).
- Errors: `400` invalid conversation id; `401` unauthenticated;
  `403 CHAT_NOT_AUTHORIZED` (non-participant / blocked, opaque); `404` if the
  conversation / backing match is gone.

## Per-conversation unread — `GET /api/conversations/:conversationId/unread-count`

**Response** `200`: `{ "conversationId": "…", "unreadCount": 3 }`. Same
authorization as above.

---

## Unread semantics (precise)

> **Unread** = messages in the conversation **sent by the other participant**
> that are **newer than the caller's read marker** (`conversation_read_state`).

- Does NOT count the caller's own messages.
- Does NOT count messages the caller has already read (marker advanced past them).
- With no marker yet, all of the partner's messages are unread.
- Scoped to the authenticated caller; one caller's reads never change the
  other's count.

## Last-message semantics

- The most recent message in the conversation by `(created_at, id)` DESC, from
  either participant. `null` when the conversation has no messages.
- Messages are append-only (no edit/delete) in the current product, so a preview
  never shows stale/deleted content. If a message ever becomes unavailable the
  preview is derived from the latest existing row (never a leaked deleted body).

## Pagination

The inbox (`GET /api/matches`) returns the full ACTIVE match set (bounded by the
user's matches), ordered newest-first; it is not cursor-paginated in this
increment. Message history pagination is unchanged (keyset `cursor`/`limit`).

## Error behavior

Standard envelope with stable `code`s: `CHAT_NOT_AUTHORIZED` (non-participant /
blocked, opaque), `MATCH_NOT_ACTIVE`, `VALIDATION_ERROR` (bad id),
`UNAUTHENTICATED`. IDOR attempts return the generic authorization error — a
conversation id is never sufficient on its own.

## WebSocket relationship

REST and WebSocket read receipts update the **same** `conversation_read_state`
marker and are fully interchangeable:

- `POST /conversations/:id/read` (REST) → marker advanced → the partner's live
  WS clients receive `{ type: "message.read", conversationId, messageId, userId }`.
- WebSocket `message.read` → same marker advanced → the next REST unread-count /
  inbox query reflects it.

WebSocket remains authoritative for realtime delivery (`message.created`,
`message.read`, `typing`); REST provides the inbox snapshot + a read fallback
for clients that are not holding a socket. The two never produce conflicting
state.
