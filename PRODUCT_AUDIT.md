# Luvora Backend — Product Completion & Frontend-Contract Audit (Increment 13)

> Factual audit of what the Luvora backend actually implements, read from the
> source (not filenames/comments), to determine the **minimum backend work
> required before frontend development can begin**.
>
> **Stack:** Node.js + TypeScript + Express, **PostgreSQL via `pg` with plain SQL
> migrations** (`database/migrations/0001…0011`). No Prisma, no ORM. ioredis
> powers the optional distributed abuse backend (Increment 12).
>
> **Baseline:** forked from `feat/distributed-abuse-dependency-security`
> (`c3eb638`); **512/512 tests pass**, 38 test files, 0 skipped; migrations
> `0001`–`0011`. This increment is an **audit only** — no product features are
> implemented.

---

## 1. Executive Summary

Luvora's backend is a mature, security-hardened API covering identity,
discovery, matching, messaging, safety, a consent-gated fantasy engine,
notifications, and presence, with consistent response/error envelopes, solid
authentication, and IDOR-safe object-level authorization throughout. 512
automated tests pass.

Two concrete contract gaps nonetheless **block** the consumer frontend:

1. **No self-profile API** — the authenticated user cannot read or update their
   own profile (display name, bio, interests, fantasy preferences, privacy
   flags) and cannot manage profile photos. Onboarding and profile/settings
   screens cannot be built.
2. **No consumable profile-photo mechanism** — discovery/match responses return
   an opaque `photo.storageKey` with no endpoint to fetch bytes; the legacy
   `photos` table that discovery reads is **never written by any code**, so
   avatars are always absent. The discovery grid and match list cannot render
   photos.

Everything else needed for an MVP frontend is present and usable. The
recommended fix (§21) is one small, scoped increment (self-profile + profile
photos via the existing `media_assets` pipeline).

---

## 2. Product Readiness Classification

**PARTIALLY-FRONTEND-READY** (at the time of the Increment 13 audit).

> **Increment 14 update:** both P0 blockers are now **RESOLVED** — a self-profile
> API (`GET`/`PATCH /api/profile`) and a profile-photo contract (upload via the
> `media_assets` pipeline with `context='profile'`, associate/list/primary/
> reorder/delete via `/api/profile/photos`, and avatar bytes served through the
> authenticated `/api/media/:id/content` with a discovery/match visibility
> rule) ship in Increment 14. Discovery/match responses now return a consumable
> photo reference (`mediaId` + authenticated `url`/`thumbnailUrl`), never a raw
> storage key. See `docs/PROFILE_API.md`. The backend is now
> **MVP-FRONTEND-READY** for the core consumer journeys; remaining items are P1/P2.

The platform/safety/messaging/consent machinery is production-grade and
consumable. At the time of the audit the consumer frontend could not start
because a user could not see/edit their profile or render any avatar — resolved
by Increment 14 (self-profile + profile photos).

---

## 3. Implemented Product Capabilities

- **Identity & auth:** register (server-side 18+ gate + attestation), login,
  refresh-token rotation with reuse detection, logout, `GET /api/auth/me`
  (identity only). JWT access + opaque hashed refresh tokens; per-IP/per-account
  brute-force throttle (Redis-distributable).
- **Account lifecycle (admin-driven):** suspend / unsuspend / deactivate /
  reactivate / role, enforced on every authenticated request.
- **Discovery:** keyset-paginated feed with full eligibility filtering; like /
  pass (idempotent upsert); reciprocal like → race-safe match.
- **Matching:** list + participant-only detail with non-leaking 404/403.
- **Messaging:** per-match auto-created conversation; send (text/attachments);
  keyset history; read markers + typing + live delivery over WebSocket;
  re-authorized on every operation.
- **Safety:** block/unblock (match → BLOCKED, live sockets kicked); report
  user/media/message/session (reporter hidden, dedup, rate-limited); full
  moderation + audit control plane.
- **Media:** two-step upload → server-side byte inspection + EXIF strip + caps +
  thumbnail + moderation hooks; owner delete; report; conversation-scoped access.
- **Fantasy/consent:** invite → accept → private mutual-consent → PLAYING →
  data-driven scenario gameplay (atomic, idempotent, optimistic concurrency) →
  COMPLETED; pause/resume/leave/decline; read-only scenario library.
- **Notifications & presence:** feed + unread count + read/read-all + prefs
  (un-silenceable SAFETY); device registration (tokens never echoed); presence
  (matched + unblocked only).
- **Platform:** health/readiness, admin-auth metrics, durable job queue + admin
  control, security/abuse diagnostics, distributed abuse backend, Docker,
  backup/DR.

---

## 4. Complete API Inventory

Auth: **none** (public) · **JWT** (any authed user) · **mod** (moderator+) ·
**admin**. Status: COMPLETE / PARTIAL / MISSING / DEAD. FE = frontend-consumable
for the core product without undocumented behavior.

### Identity
| Method | Endpoint | Auth | Status | FE |
|---|---|---|---|---|
| POST | /api/auth/register | none | COMPLETE | ✅ |
| POST | /api/auth/login | none | COMPLETE | ✅ |
| POST | /api/auth/refresh | none | COMPLETE | ✅ |
| POST | /api/auth/logout | none¹ | COMPLETE | ✅ |
| GET | /api/auth/me | JWT | PARTIAL² | ⚠️ |

¹ refresh token in body. ² identity only (id/email/age/flags) — no profile.

### Profile — **MISSING** (P0-1)
| Method | Endpoint | Status |
|---|---|---|
| GET | /api/profile (self) | **MISSING** |
| PATCH | /api/profile (self) | **MISSING** |
| * | profile photo add/list/delete/reorder/primary | **MISSING** |

### Discovery & Matching
| Method | Endpoint | Auth | Status | FE |
|---|---|---|---|---|
| GET | /api/discovery?limit=&cursor= | JWT | COMPLETE | ⚠️ photo bytes (P0-2) |
| POST | /api/discovery/:userId/like | JWT | COMPLETE | ✅ |
| POST | /api/discovery/:userId/pass | JWT | COMPLETE | ✅ |
| GET | /api/matches | JWT | COMPLETE | ⚠️ photo bytes (P0-2) |
| GET | /api/matches/:matchId | JWT | COMPLETE | ✅ |

### Messaging
| Method | Endpoint | Auth | Status | FE |
|---|---|---|---|---|
| GET | /api/matches/:matchId/messages?limit=&cursor= | JWT | COMPLETE | ✅ |
| POST | /api/matches/:matchId/messages | JWT | COMPLETE | ✅ |
| WS | /ws/chat (message.send/created, message.read, typing) | JWT | COMPLETE | ✅³ |

³ read-marker + typing are WS-only; no REST read endpoint, no per-conversation unread (P1).

### Safety
| Method | Endpoint | Auth | Status | FE |
|---|---|---|---|---|
| POST | /api/users/:userId/block | JWT | COMPLETE | ✅ |
| DELETE | /api/users/:userId/block | JWT | COMPLETE | ✅ |
| POST | /api/reports/user/:userId | JWT | COMPLETE | ✅ |
| POST | /api/reports/media/:mediaId | JWT | COMPLETE | ✅ |
| POST | /api/reports/message/:messageId | JWT | COMPLETE | ✅ |
| POST | /api/reports/session/:sessionId | JWT | COMPLETE | ✅ |

### Media
| Method | Endpoint | Auth | Status | FE |
|---|---|---|---|---|
| POST | /api/media (intent) | JWT | COMPLETE | ✅ (chat/session) |
| PUT | /api/media/:mediaId/content | JWT | COMPLETE | ✅ |
| GET | /api/media/:mediaId | JWT | COMPLETE | ✅ |
| GET | /api/media/:mediaId/content | JWT | COMPLETE | ✅ attachment-scoped |
| GET | /api/media/:mediaId/thumbnail | JWT | COMPLETE | ✅ |
| DELETE | /api/media/:mediaId | JWT | COMPLETE | ✅ |
| POST | /api/media/:mediaId/report | JWT | COMPLETE | ✅ |

### Fantasy / Consent / Gameplay / Scenarios
| Method | Endpoint | Auth | Status | FE |
|---|---|---|---|---|
| POST | /api/sessions/invite | JWT | COMPLETE | ✅ |
| POST | /api/sessions/:id/accept | JWT (invitee) | COMPLETE | ✅ |
| POST | /api/sessions/:id/decline | JWT | COMPLETE | ✅ |
| POST | /api/sessions/:id/consent | JWT | COMPLETE | ✅ |
| GET | /api/sessions/:id/consent | JWT | COMPLETE | ✅ |
| POST | /api/sessions/:id/leave | JWT | COMPLETE | ✅ |
| GET | /api/sessions/:id/state | JWT | COMPLETE | ✅ |
| POST | /api/sessions/:id/scenario | JWT | COMPLETE | ✅ |
| POST | /api/sessions/:id/choices/:choiceId | JWT | COMPLETE | ✅ |
| POST | /api/sessions/:id/pause | JWT | COMPLETE | ✅ |
| POST | /api/sessions/:id/resume | JWT | COMPLETE | ✅ |
| WS | /ws/game | JWT | COMPLETE | ✅ |
| GET | /api/scenarios?limit=&cursor= | JWT | COMPLETE | ✅ |
| GET | /api/scenarios/:scenarioId | JWT | COMPLETE | ✅ |

No `GET /api/sessions` list (P2 — client uses the invite notification's `entityId`).

### Notifications & Presence
| Method | Endpoint | Auth | Status | FE |
|---|---|---|---|---|
| GET | /api/notifications?limit=&unread=&cursor= | JWT | COMPLETE | ✅ |
| GET | /api/notifications/unread-count | JWT | COMPLETE | ✅ |
| GET | /api/notifications/preferences | JWT | COMPLETE | ✅ |
| PUT | /api/notifications/preferences | JWT | COMPLETE | ✅ |
| POST | /api/notifications/read-all | JWT | COMPLETE | ✅ |
| POST | /api/notifications/:id/read | JWT | COMPLETE | ✅ |
| POST | /api/notifications/devices | JWT | COMPLETE | ✅ |
| GET | /api/notifications/devices | JWT | COMPLETE | ✅ |
| DELETE | /api/notifications/devices/:id | JWT | COMPLETE | ✅ |
| GET | /api/users/:userId/presence | JWT | COMPLETE | ✅ |

### Platform / Admin (not consumer surface)
| Method | Endpoint | Auth | Status |
|---|---|---|---|
| GET | /health, /ready | none | COMPLETE |
| GET | /metrics | admin-token | COMPLETE |
| GET/POST | /api/admin/reports, /moderation/queue, /reports/:id[/assign\|/resolve] | mod | COMPLETE |
| GET/POST | /api/admin/media/:id[/content\|/thumbnail\|/approve\|/reject\|/quarantine] | mod | COMPLETE |
| POST | /api/admin/users/:id/{suspend,unsuspend,deactivate,reactivate,role} | admin | COMPLETE |
| GET | /api/admin/users/:id/{role,devices} | admin | COMPLETE |
| GET/POST | /api/admin/jobs[...], /operational-events, /security-events, /abuse-backend, /audit-logs | admin | COMPLETE |

**Totals:** ~62 HTTP endpoints + 2 WS channels. COMPLETE: 60 · PARTIAL: 2
(`/api/auth/me`, read-receipt-over-WS-only) · MISSING: the profile group ·
DEAD(HTTP): 0. **Security concerns: 0** blocking; 2 low/informational (§14).

---

## 5. Consent State Machine

Session states (DB CHECK + `SessionState` enum):
`WAITING, INVITED, ACCEPTED, CONSENT, PLAYING, PAUSED, COMPLETED, ABANDONED, REPORTED`.
Transitions are server-authoritative (`packages/shared/src/stateMachine.ts`); a
client may only *request* a transition.

| From | To | Actor | Trigger | Authz | Validation | Persistence | Idempotent | Events |
|---|---|---|---|---|---|---|---|---|
| (none) | INVITED | either match member → initiator | POST /sessions/invite | match member + match ACTIVE | matchId/scenarioId | txn: session + 2 players | No (rate-limited) | notify invitee FANTASY_INVITE |
| INVITED | ACCEPTED→CONSENT | **invitee only** | /accept | participant + invitee | — | two `setState` (not one txn) | No | notify initiator FANTASY_ACCEPTED |
| non-terminal | ABANDONED | either | /decline | participant | — | one `setState` | No | — |
| CONSENT | CONSENT | either | /consent | participant + state=CONSENT | categories valid; `agreeToParticipate` | txn upsert responses + status | Yes (upsert) | — |
| CONSENT | PLAYING | server (2nd confirm) | /consent, GET /consent | both CONFIRMED | — | `setState` gated state=CONSENT | guarded | — |
| PLAYING | PLAYING (scenario) | either | /scenario | participant + PLAYING | published scenario+start node | txn + `state_version` guard | Yes | WS game.state.changed |
| PLAYING | PLAYING / COMPLETED | either | /choices/:choiceId | participant + PLAYING | choice on current node; required categories in allow-list | txn FOR UPDATE + version guard + `session_actions` ledger | **Yes** (`clientActionId` UNIQUE) | WS state/completed; notify both on COMPLETED |
| PLAYING | PAUSED | either | /pause | participant | — | one `setState` | No | WS game.state.changed |
| PAUSED | PLAYING | either | /resume | participant | — | one `setState` | No | WS game.state.changed |
| PLAYING/PAUSED | ABANDONED | either | /leave | participant | — | one `setState` | No | — |

**Consent privacy:** per-category answers (YES/MAYBE/NO) are stored privately in
`consent_responses` and **never serialized to the partner**. The partner sees
only `partnerConfirmed` (boolean) and, once both confirm, the mutual **YES/YES**
allow-list. `MAYBE` never qualifies ("stricter party wins"). `getConsentView`
returns the caller's own answers only. No expiration/revocation of consent is
implemented (a submitted answer can be re-submitted/overwritten while in CONSENT;
after PLAYING there is no withdraw-consent action — leaving is the exit).

**Can the frontend reliably understand consent/session state?** Yes, via
`GET /api/sessions/:id/consent` (`ConsentView`: `state`, `yourResponses`,
`youConfirmed`, `partnerConfirmed`, `allowedCategories`, `categories`) and
`GET /api/sessions/:id/state` (gameplay `GameStateView`). Mapping to the brief's
abstract states:
- **current state** — ✅ explicit `state` field.
- **available actions** — ✅ derivable from `state` + the published transition
  table (also encoded in choice `available` flags for gameplay).
- **pending request** — ✅ state INVITED (+ FANTASY_INVITE notification).
- **accepted/matched** — ✅ ACCEPTED/CONSENT; matching is a separate concept
  (`matched` on the like result + `/api/matches`).
- **rejected/declined** — ✅ ABANDONED (decline/leave both map here).
- **revoked/withdrawn** — ⚠️ no dedicated "consent withdrawn" state; a user
  leaves (→ABANDONED). Acceptable for MVP; not a frontend blocker.
- **blocked** — represented at the match level (match→BLOCKED), not re-reflected
  into an in-flight session (see §14 S-1).

Reserved-but-unwired: `WAITING` (sessions insert directly as INVITED) and
`REPORTED` (reporting a session files a report but never sets this state).

---

## 6. Discovery & Matching

**Flow:** `GET /api/discovery` → `discoveryService.getFeed` →
`discoveryRepository.queryFeed` (single SQL) → `toCandidate` serializer →
`{ candidates: DiscoveryCandidate[], nextCursor }`.

**Eligibility (all in SQL):** excludes self; `deleted_at IS NULL` and
`is_disabled = false` (suspension is modeled via `is_disabled`); requires
`profiles.discoverable = true`; excludes any candidate the viewer has already
liked **or** passed (`likes` NOT EXISTS, either `is_pass`); excludes blocks in
**either** direction; excludes any existing match for the canonical pair
(regardless of state). **No age-range / interest / distance / orientation
filtering exists** — age is only *displayed* (gated by `age_visible`).

**Sorting/ranking:** deterministic keyset `ORDER BY u.created_at ASC, u.id ASC`
(oldest accounts first) — **not** randomized or scored. Backed by a partial
index. **Pagination:** opaque base64 keyset cursor (`{c,i}`), limit 1–50
(default 20), lossless `created_at::text` boundary; `nextCursor` non-null only
when the page filled.

**Like / Pass:** `POST /api/discovery/:userId/like|pass`. Target validated
(self → 400; missing/disabled → 404, not leaking ineligible accounts). Decisions
are upserts into `likes` (`UNIQUE(liker_id, likee_id)`) → **duplicate-proof and
idempotent**; a pass overwrites a prior like and vice-versa. A reciprocal
standing like creates the match inside one transaction guarded by a
pair-scoped advisory lock + `ON CONFLICT (user_a,user_b) DO NOTHING` →
**race-safe**, exactly-once match-created notification. Result:
`{ action, userId, matched, matchId }`.

**Matched users remain discoverable?** No — excluded by the `matches` NOT EXISTS
clause. **Blocked excluded?** Yes, either direction. **Inactive/deleted
excluded?** Yes (`is_disabled=false`, `deleted_at IS NULL`). **Already-seen
handled?** Yes (any prior like/pass excludes).

**Response shape (`DiscoveryCandidate`):** `{ id, displayName, bio, interests[],
age|null, photo: { id, storageKey } | null }`.

### Can a frontend build a complete discovery screen? **PARTIAL.**
Text fields, actions, and paging are fully usable. **Blocker: profile photo is
not displayable** — `photo.storageKey` is opaque with no byte-serving endpoint,
and the `photos` table is never populated (always `null`). Minimum missing
contract: a way to fetch an approved profile-photo image for a discovery
candidate (P0-2). (Not a blocker, P2: discovery has no filter parameters.)

---

## 7. Messaging

**Conversation creation:** implicit — one conversation per match, auto-created
on first access/send (`conversations.match_id` unique). **Participants:** the
two match members. There is **no standalone conversation-list endpoint**; the
conversation list is `GET /api/matches` (ACTIVE matches, newest first).

**Send:** `POST /api/matches/:matchId/messages` (+ `/ws/chat message.send`).
Authorized via the match (participant + ACTIVE + no block, re-checked every
time). Sender id is always the authenticated user (client-supplied ids ignored).
Body must be non-empty **or** carry attachments; ≤4000 code points; attachments
must be owner-owned + READY + APPROVED (enforced in the same transaction).
**Idempotency:** optional `clientMessageId`. **Realtime:** persisted-then-
broadcast to both participants' sockets. **Recipient notified** (never the
sender; body never included).

**Retrieve:** `GET /api/matches/:matchId/messages?limit=&cursor=` — keyset,
newest→oldest internally, returned oldest→newest per page; attachments batch-
loaded (no N+1). **Read/unread:** `message.read` marker exists **over WebSocket
only**; `setReadMarker` persists `last_read_message_id` per (conversation,user),
but there is **no REST endpoint** and message DTOs/match summaries expose no read
state or per-conversation unread count. **Block/consent/deleted enforcement:**
every send/history/read re-authorizes against the ACTIVE match + block; a BLOCKED
match returns the generic `CHAT_NOT_AUTHORIZED`.

### Can the frontend build inbox + conversation + composer? **PARTIAL.**
Inbox (via `/api/matches`), open conversation, load/paginate history, send, and
live receive are all usable. Concrete P1 (not hard blockers):
- no REST read-receipt (WS-only) → either require a WS connection to mark read,
  or add a REST endpoint;
- no per-conversation unread count / last-message preview for an inbox badge
  (the global `/api/notifications/unread-count` partially substitutes).
Avatars in the inbox hit the same P0-2 photo gap.

---

## 8. Profile

**Lifecycle today:** Registration (`register`) creates the `users` row and a
`profiles` row with **display_name only** (all other fields default), in one
transaction. After that there is **no read, no update, no photo management, and
no account/profile deletion** by the user. Admin deactivate/soft-delete cascades
`profiles`/`photos` via FK.

**`profiles` field-by-field:**
| Field | User-writable | User-readable | In discovery | Notes |
|---|---|---|---|---|
| display_name | at register only | ✗ (not even via /me) | ✅ candidate+match | editable only via a missing endpoint |
| bio | ✗ | ✗ | ✅ candidate | unreachable |
| interests[] | ✗ | ✗ | ✅ candidate | unreachable |
| fantasy_preferences[] | ✗ | ✗ | ✗ | **dead** (no reader/writer/serializer) |
| age_visible | ✗ | ✗ | gates candidate `age` | unreachable toggle |
| online_status_visible | ✗ | ✗ | — | **dead** (presence doesn't consult it) |
| read_receipts_enabled | ✗ | ✗ | — | **dead** (chat doesn't consult it) |
| discoverable | ✗ | ✗ | gates feed inclusion | unreachable toggle |
| created_at/updated_at | n/a | ✗ | ✗ | timestamps |

Age/date_of_birth live on `users` (derived age exposed via `/me` and, gated,
in discovery). "Profile completion" is not modeled.

**Conclusion:** the entire editable profile surface + privacy controls are
**unreachable via the API** (P0-1). Several privacy flags are also currently
inert (`online_status_visible`, `read_receipts_enabled`, `fantasy_preferences`)
— they should be wired or explicitly deferred when the profile API is added.

---

## 9. Media

**Flow:** `POST /api/media` (intent: filename, mimeType, sizeBytes, context) →
`PUT /api/media/:id/content` (raw bytes, size-bounded) → server-side inspection:
dual MIME detection (file-type magic bytes **and** sharp must agree), EXIF/metadata
stripped on re-encode, pixel-count + dimension + byte caps, thumbnail generated,
malware-scan + moderation hooks; status machine
`UPLOADING→…→READY|QUARANTINED|REJECTED`. **Ownership:** `media_assets.owner_id`;
delete is owner-only (soft). **Retrieval:** `GET /:id` (metadata; owner sees any
non-deleted state, others via authorizeView), `GET /:id/content` + `/thumbnail`
(bytes; must be READY). **Authorization (`authorizeView`):** owner always; else
the viewer must reach it **through a message attachment in a shared ACTIVE-match
conversation with no block**.

**`storageKey` safety:** the opaque object-storage key is **never returned by the
media endpoints** (those serve bytes directly behind authorization). It IS
returned — unusably — by discovery/match (the separate `photos` table). It is not
a secret per se, but it is **not frontend-usable**: there is no key→bytes route.
No signed URLs are implemented (explicitly deferred). `media_assets.context`
supports `'profile'`, but nothing creates or serves a profile photo, and
discovery reads the unrelated, never-written `photos` table.

### Can a frontend upload/display/reorder/replace/delete PROFILE photos? **NO.**
- Upload — the generic pipeline exists, but there is no profile-photo
  association, no `context='profile'` creation path, and no ordering/primary.
- Display — no endpoint serves a profile photo to a discovery candidate/match
  viewer (P0-2).
- Reorder / primary / replace / delete-as-profile — no API.

Minimum required contract (for Increment 14, **not implemented here**): create a
profile photo via the existing media pipeline with `context='profile'`; associate
it to the profile (primary + ordering); and a view path that serves an approved
profile photo to any authenticated user entitled to see that user (discovery
candidate or match). Chat attachments already work and are unaffected.

---

## 10. Block / Report / Safety

**Block** (`POST/DELETE /api/users/:userId/block`, idempotent): inserts a
`blocks` row and sets the pair's match to `BLOCKED` in one transaction; surfaces
the conversation id to kick live chat sockets. Effects:
- discovery — excluded either direction ✅
- matching — existing match → BLOCKED; new matches impossible while blocked ✅
- conversations/messaging — re-authorized per message → cut off ✅
- media — attachment access requires ACTIVE match + no block → cut off ✅
- presence — matched+unblocked rule → hidden ✅
- realtime chat — live sockets notified/kicked ✅
- **fantasy gameplay — NOT cut off** (§14 S-1) ⚠️
- profile viewing — n/a today (no profile endpoint)
- unblock — deletes the block row only; does **not** restore the match, likes,
  or discovery visibility (the BLOCKED match row still excludes the user).

**Report** (`POST /api/reports/{user|media|message|session}/:id`): any authed
user; target validated; reporter identity never exposed; duplicate reports
deduped (`DUPLICATE_REPORT`); rate-limited. Media reports can quarantine on first
sensitive report. Reports flow to the moderation queue; status lifecycle
OPEN→REVIEWING→RESOLVED/DISMISSED handled by moderators; audit-logged. Evidence:
the reported entity id is stored; moderators can view reported media bytes.

**Gaps (actual):** only S-1 (gameplay continues after block) and S-2 (session
report never sets REPORTED) — both low/informational (§14). The user-facing
safety contract is complete for the frontend.

---

## 11. Notifications

**Implemented (fully usable now):** per-user in-app feed (keyset-paginated,
unread filter), `unread-count`, `read` / `read-all`, preferences (per-category
in-app + push toggles with an un-silenceable SAFETY category), device
registration/list/revoke (push tokens stored as fingerprints, never echoed).
In-app notifications are created for all key product events: MATCH_CREATED,
MESSAGE_RECEIVED, FANTASY_INVITE/ACCEPTED/COMPLETED (deduped, body-free for
privacy).

**Backend-ready but no provider:** out-of-band push delivery. The delivery
pipeline, device model, preference gating, and a deterministic TEST provider
exist; FCM/APNs/WebPush are honest placeholders (DISABLED/TEST only). Product
events are already represented well enough for a real provider to be slotted in
later with no schema change.

**Not implemented:** real external push, email notifications.

Push is **not** an MVP frontend blocker — the in-app feed + unread count fully
support the frontend; push is Future Infrastructure.

---

## 12. Admin / Moderation

Complete and RBAC-guarded (`requireModerator` / `requireAdmin`, roles from the
DB record only):
- **User management:** suspend/unsuspend/deactivate/reactivate, role get/set
  (last-admin protection, cannot-target-self), device inspection (no raw token).
- **Reports/moderation:** queue + list/detail (keyset-paginated, filterable),
  assign/resolve, media review bytes, approve/reject/quarantine media.
- **Audit & ops:** audit logs, operational events, security events, job queue
  control, abuse-backend diagnostics — all admin-only, paginated, no sensitive
  leakage.

No MVP-justified admin gaps. A moderation **UI** is out of scope (Future).

---

## 13. Database Findings

Schema is consistent with the implemented product: canonical match ordering
(`user_a < user_b` CHECK + unique), unique constraints on
likes/matches/blocks/devices/consent/session-actions, FKs with sensible
`ON DELETE CASCADE/SET NULL`, `updated_at` triggers, keyset indexes, state
CHECKs, 18+ CHECK on users. Transactions wrap all multi-row/race-sensitive
operations (register, like+match with advisory lock, consent upsert, gameplay
advanceTurn with FOR UPDATE + optimistic `state_version`). No orphan risks found.

Genuine findings:
- **D-1 (P0-related): two parallel photo models.** Legacy `photos` (Increment 1)
  is read by discovery/match but **never written by any code, seed, or test** →
  avatars always null. `media_assets` (Increment 5) supports `context='profile'`
  but isn't wired to profiles/discovery. Increment 14 should standardize on
  **one** model (recommend `media_assets` + a `profiles.primary_photo_media_id`
  or `profile_photos` join) — a migration `0012` is justified **only then**.
- **D-2 (informational): fields with no API access** — `profiles.bio`,
  `interests`, `fantasy_preferences`, and all four privacy flags (writable only
  at register for display_name; otherwise unreachable). `matches.state`
  `'UNMATCHED'`, `fantasy_sessions` `'WAITING'`/`'REPORTED'` are reserved but
  never written. No APIs require data missing from the DB.

**No migration is created in this audit** (per the implementation rule).

---

## 14. Security Findings

Product endpoints correctly reuse the Increment 11/12 foundation (authn, RBAC,
IDOR-safe opaque errors, consent/block re-authorization on chat/media, rate
limiting, brute force, validation, no error/data leakage). No vulnerabilities
were manufactured. Two low/informational, defense-in-depth items (not frontend
blockers, not fixed in this audit):

- **S-1 (Low): in-flight fantasy sessions survive block/unmatch.** `block()`
  sets `matches.state='BLOCKED'` but doesn't touch `fantasy_sessions`, and
  gameplay endpoints (`/scenario`, `/choices`, `/pause`, `/resume`, `/state`)
  authorize only on session participation — never re-checking match state or
  `blocks`. Two users in a PLAYING session can keep playing after one blocks the
  other. Chat/media/presence correctly cut off. Recommended follow-up (a later
  safety pass, not Increment 14): abandon non-terminal sessions on block, or
  re-check match/block in `loadParticipantSession`.
- **S-2 (Informational): `REPORTED` session state unreachable.** Reporting a
  session records the safety report but never transitions the session; the state
  is reserved. No security impact (report is captured).

No auth-bypass, injection, IDOR, or sensitive-data exposure found in product
endpoints.

---

## 15. Frontend Contract (consumable today)

- **Envelope:** `{success:true,data}` / `{success:false,error:{code,message,details?}}`;
  `code`s are stable machine strings — safe to branch on.
- **Auth:** `Authorization: Bearer <accessToken>`; refresh via
  `POST /api/auth/refresh`; throttling → `429` + `Retry-After`.
- **IDs:** UUIDs. **Timestamps:** ISO-8601 strings (`created_at`, etc.).
  **Nullable:** explicit `| null` in DTOs (e.g. `photo`, `age`, `nextCursor`).
  **Enums/state:** explicit string fields (session `state`, `action`, report
  reasons).
- **Pagination:** opaque base64 keyset cursors; `nextCursor` null when no more.
  Consistent across discovery, chat history, scenarios, notifications.
- **Realtime:** `/ws/chat` + `/ws/game`, same origin; auth via header or
  `?access_token=`.
- **Consumable now:** auth, discovery feed + like/pass, matches, chat
  send/history + live, blocking, reporting, full consent/fantasy/gameplay,
  scenarios, notifications + unread + prefs, devices, presence.
- **NOT consumable:** self-profile read/update; any profile-photo display or
  management; REST read-receipt + per-conversation unread.

---

## 16. User Journey Results

| Journey | Status | Smallest backend contract needed |
|---|---|---|
| A — Registration | **PARTIAL** | register/login/me work and establish a session, but "load current user → complete profile → upload photos → save → become discoverable" is impossible: no profile read/update, no profile-photo upload/associate, no `discoverable` toggle. Needs **P0-1 + P0-2**. |
| B — Discovery | **PARTIAL** | candidates + text + like/pass + paging work; **profile photos cannot be displayed** (P0-2). The "consent action" in discovery is like/pass (works); fantasy consent is a post-match flow (works). |
| C — Match | **COMPLETE** | reciprocal like → match; match visible via `/api/matches`; matched profile detail via `/api/matches/:id`; conversation auto-available. (Avatar in the match card hits P0-2, but the journey functions.) |
| D — Messaging | **PARTIAL** | inbox (via matches), open conversation, load/paginate, send, live receive all work; marking read is **WS-only** and there's no per-conversation unread (P1). |
| E — Safety | **COMPLETE** | block/report fully functional with correct resulting restrictions across discovery/matching/chat/media/presence (gameplay caveat S-1 is low-severity). |

Journey-to-section mapping for the final response: Registration (A, auth part) =
COMPLETE; Profile (A, profile part) = BLOCKED; Discovery = PARTIAL; Consent =
COMPLETE; Matching = COMPLETE; Messaging = PARTIAL; Safety = COMPLETE.

---

## 17. P0 Blockers (frontend cannot implement core MVP without these)

- **P0-1 — Self-profile read/update API.** Expose the authenticated user's
  profile (display_name, bio, interests, fantasy_preferences, privacy flags) for
  read and update. Without it: no onboarding, no profile screen, no settings, no
  way to become/stop being discoverable.
- **P0-2 — Consumable profile photos.** A way to upload/associate a profile
  photo (reusing the `media_assets` pipeline, `context='profile'`) **and** a view
  path that serves an approved profile photo to a legitimately-entitled viewer
  (discovery candidate or match). Without it: no avatars anywhere.

---

## 18. P1 Requirements (MVP should have; frontend can start without)

- **P1-1 — REST read-receipt + per-conversation unread count** (currently
  WS-only; no inbox unread badge).
- **P1-2 — Match/conversation list enrichment** (last-message preview + per-match
  unread for an inbox).
- **P1-3 — Self account controls** (self deactivate/delete; password/email
  change) — only admins can change account state today.

---

## 19. P2 Requirements (post-MVP)

- `GET /api/sessions` ("my fantasies") list.
- Discovery filters (age range / interests / distance — none exist).
- Wire or formally retire the inert privacy flags
  (`online_status_visible`, `read_receipts_enabled`, `fantasy_preferences`).
- Profile-completion hints.

---

## 20. Future Infrastructure (do NOT build now)

- Real push providers (FCM / APNs / WebPush) — placeholders today.
- Distributed presence / cross-instance realtime — placeholders.
- Signed-URL / CDN media delivery pipeline.
- Exactly-once job semantics; large-scale realtime optimization.
- Moderation UI; frontend / Android clients.

---

## 21. Recommended Increment 14

**One recommendation: "Profile & Profile-Photo Contract" — the minimum work that
unblocks the frontend.** Scope strictly to P0-1 + P0-2:

1. **Self-profile API** — `GET /api/profile` (or embed the profile in
   `GET /api/auth/me`) and `PATCH /api/profile` for display_name, bio,
   interests, fantasy_preferences, and the privacy flags (incl. `discoverable`).
2. **Profile photos on the existing `media_assets` pipeline** (`context='profile'`):
   upload/associate (primary + ordering), delete, and a **view path** that serves
   an approved profile photo to any authenticated viewer entitled to see that
   user (discovery candidate or match). Standardize on one photo model and point
   discovery/match reads at it (migration `0012` justified here).

Explicitly **out of scope** for Increment 14 (keep it small): push providers,
distributed presence, signed-URL/CDN, discovery filters, self-account deletion,
the S-1 gameplay/block hardening (fold into a later safety pass), and any
frontend code.

**Decision:** the backend is **PARTIALLY-FRONTEND-READY**. It cannot start the
consumer frontend today (no profile read/edit, no avatars). After the small
Increment 14 above, it is MVP-frontend-ready.
