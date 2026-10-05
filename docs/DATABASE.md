# Database

PostgreSQL. Migrations are forward-only `.sql` files in `database/migrations/`,
applied in lexical order by a small runner (`apps/backend/src/db/migrate.ts`)
that records applied files in `schema_migrations`. Re-running is idempotent.

```bash
npm run -w @luvora/backend migrate:up
```

## Conventions
- UUID primary keys via core `gen_random_uuid()` (no extension needed; built in
  since PG 13) — non-enumerable, which supports IDOR resistance.
- `created_at` / `updated_at` on mutable tables; `updated_at` maintained by a
  shared `set_updated_at()` trigger.
- Soft delete via `deleted_at` where user data must be recoverable/anonymizable
  (`users`, `photos`).
- Invariants enforced at the DB layer with `CHECK`/`UNIQUE`/FK constraints, not
  only in application code.

## Increment 1 tables

| Table               | Purpose / notable constraints |
|---------------------|-------------------------------|
| `users`             | Auth identity. `CHECK` enforces 18+ by DOB. Unique email (case-insensitive, among non-deleted). |
| `auth_sessions`     | Refresh-token families. Stores token **hash** only; `rotated_at`/`revoked_at`/`family_id` drive rotation + theft containment. |
| `devices`           | Push device registrations. |
| `profiles`          | 1:1 with user. Privacy toggles default to privacy-preserving. |
| `photos`            | Private media; `moderation_state` lifecycle; `storage_key` opaque. |
| `likes`             | Like/pass. `UNIQUE (liker, likee)` prevents duplicate decisions; `CHECK` forbids self-like. |
| `matches`           | Canonical pair ordering `CHECK (user_a < user_b)` + `UNIQUE` → exactly one row per pair, race-safe. States: ACTIVE/UNMATCHED/BLOCKED. |
| `blocks`            | `UNIQUE (blocker, blocked)`; `CHECK` forbids self-block. |
| `fantasy_sessions`  | Two-player session; `state` CHECK matches the shared state machine; `scenario_version` pins content; `seq` for event ordering. |
| `fantasy_players`   | Per-player consent status + participation agreement + join/leave timestamps. |
| `consent_responses` | **Private** per-player answers; `UNIQUE (session, user, category)`; never exposed to the partner via any API. |

Later increments add: messages/attachments, scenario content tables,
fantasy_events, relationship, reports, moderation_actions, notifications,
audit_log.

## Migration 0002 — discovery & matching indexes (Increment 2)

Increment 2 reuses the Increment 1 `likes`, `matches`, and `blocks` tables
unchanged (their uniqueness and canonical-ordering constraints already enforce
the required invariants). Migration `0002_discovery_matching.sql` adds only the
indexes the discovery and relationship queries need — no table redesign:

| Index | Supports |
|-------|----------|
| `likes_liker (liker_id)` | "every decision the viewer already made" (feed exclusion). |
| `likes_liker_likee_like (liker_id, likee_id) WHERE is_pass = false` | reciprocal "did candidate like me?" (match detection + feed). |
| `blocks_blocker (blocker_id)` | blocks created by the viewer (0001 had only `blocks_blocked`). |
| `users_discovery_order (created_at, id) WHERE deleted_at IS NULL AND is_disabled = false` | deterministic keyset ordering of the feed over live accounts. |

### Relationship invariants relied upon (from 0001)
- `likes UNIQUE (liker_id, likee_id)` → one decision per `(actor, target)`;
  LIKE/PASS is an upsert on this key.
- `matches CHECK (user_a < user_b)` + `UNIQUE (user_a, user_b)` → one row per
  pair; race-safe match creation via `ON CONFLICT DO NOTHING`.
- `blocks UNIQUE (blocker_id, blocked_id)` → idempotent block via `ON CONFLICT`.
- `matches.state ∈ {ACTIVE, UNMATCHED, BLOCKED}` → blocking sets an existing
  match to `BLOCKED`; active listings and discovery filter on `ACTIVE`.

## Migration 0003 — private chat (Increment 3)

`0003_chat.sql` adds the chat tables. One conversation per match; messages are
append-only; read state is a compact per-user marker.

| Table | Purpose / notable constraints |
|-------|-------------------------------|
| `conversations` | One per match. `UNIQUE (match_id)` enforces that at the DB layer; FK → `matches(id) ON DELETE CASCADE`. Created lazily + race-safely via `INSERT ... ON CONFLICT (match_id)`. |
| `messages` | Append-only. `id` server-generated UUID; FK `conversation_id` → `conversations`, `sender_id` → `users`. `client_message_id` is an optional idempotency key. |
| `conversation_read_state` | Per-user "last read message" marker. PK `(conversation_id, user_id)`; `last_read_message_id` FK → `messages ON DELETE SET NULL`. |

Indexes / constraints:
- `messages_conversation_order (conversation_id, created_at, id)` — deterministic
  keyset history pagination, no N+1.
- `messages_idempotency` — partial `UNIQUE (conversation_id, sender_id,
  client_message_id) WHERE client_message_id IS NOT NULL` — at most one message
  per client idempotency key; keyless messages are unconstrained.
- `messages_body_nonempty` (`length(btrim(body)) >= 1`) and
  `messages_body_max_bytes` (`octet_length(body) <= 32000`). The **authoritative**
  4000-code-point limit is enforced in the application (`chatService.validateBody`);
  these DB checks are encoding-independent backstops (4000 code points ≤ 16000
  UTF-8 bytes, so 32000 bytes is safe headroom) and never reject a value the
  application already accepted.

Presence and typing are ephemeral and are **not** persisted.

## Migration 0004 — fantasy engine + scenario library (Increment 4)

`0004_fantasy_engine.sql` adds the data-driven scenario engine and extends
`fantasy_sessions` with gameplay state. Content is data; scenario versions are
immutable once a session references them.

| Table | Purpose / notable constraints |
|-------|-------------------------------|
| `scenarios` | Authoring parent. `UNIQUE(lower(slug))`; `status ∈ {DRAFT,PUBLISHED,ARCHIVED}`; only PUBLISHED is user-visible. |
| `scenario_versions` | Immutable snapshot. `UNIQUE(scenario_id, version)`; `start_node_id` FK → nodes; FK → scenarios `ON DELETE RESTRICT`. |
| `scenario_nodes` | One step. `node_type ∈ {START,NARRATIVE,CHOICE,ENDING}`; `UNIQUE(scenario_version_id, node_key)`. |
| `scenario_choices` | `UNIQUE(node_id, choice_key)`; `next_node_id` FK → nodes `ON DELETE RESTRICT` (server-resolved destination; clients never supply it). |
| `scenario_choice_requirements` | `(choice_id, consent_category)` PK — consent categories a choice requires. |
| `session_actions` | Idempotency ledger. `UNIQUE(session_id, user_id, client_action_id)` — a retried action returns the same result, no double-advance. |

`fantasy_sessions` additive columns: `scenario_version_id` (FK → versions, RESTRICT),
`current_node_id` (FK → nodes, RESTRICT), `turn_number`, `state_version`
(optimistic-concurrency token), `started_at`, `completed_at`.

**Deletion safety:** every column a running session can reference
(`scenario_version_id`, `current_node_id`, choice `next_node_id`, version
`start_node_id`) uses `ON DELETE RESTRICT`, so content a session depends on
cannot be deleted out from under it. `session_actions` is `ON DELETE CASCADE`
from the session (child side).

Indexes: `scenarios_slug_unique`, `scenarios_status`, `scenario_versions_scenario`,
partial `scenario_versions_published`, `scenario_nodes_version`,
`scenario_choices_node`, `fantasy_sessions_scenario_version`,
`fantasy_sessions_current_node`, `session_actions_session`.

### Seeding
`apps/backend/src/db/scenarioSeed.ts` seeds ~5 safe, non-graphic PUBLISHED demo
scenarios (linear, branching, consent-gated, multiple endings) idempotently
(keyed on slug + version). It is invoked by `seed` and runnable standalone.

## Migration 0005 — secure media & attachments (Increment 5)

`0005_media.sql` adds media infrastructure (normalized relations; no JSON blobs
in `messages`) and drops the Increment 3 body-non-empty check so attachment-only
messages are allowed.

| Table | Purpose / notable constraints |
|-------|-------------------------------|
| `media_assets` | Server-controlled metadata. `status ∈ {UPLOADING,UPLOADED,PROCESSING,READY,QUARANTINED,REJECTED,DELETED}`; `moderation_status ∈ {PENDING,APPROVED,REJECTED,NEEDS_REVIEW}` (independent); opaque `storage_key`/`thumbnail_storage_key`; `detected_mime_type`, `byte_size`, `sha256`, `width`, `height` all server-derived; `context ∈ {chat,session,profile}`; soft-delete via `deleted_at`. |
| `message_attachments` | Normalized link: FK `message_id` → messages `ON DELETE CASCADE`, `media_id` → media_assets `ON DELETE RESTRICT`; `UNIQUE(message_id, media_id)` prevents duplicate links. |
| `media_reports` | FK media/reporter; `reason`/`status` CHECK enums; `UNIQUE(media_id, reporter_id)` throttles duplicate reports. |

Indexes: `media_assets_owner` (partial, non-deleted), `media_assets_status`,
`media_assets_uploading_created` (partial — supports orphan cleanup),
`message_attachments_message`, `message_attachments_media`, `media_reports_media`.

Deletion safety: `message_attachments.media_id` is `ON DELETE RESTRICT`, so a
media asset referenced by a historical message cannot be hard-deleted out from
under it; media deletion is a soft delete (`status=DELETED`). Orphaned
`UPLOADING` assets are removed by `cleanupAbandonedUploads()` (a plain function a
scheduler can call; no cron required).

## Migration 0006 — admin + safety + moderation (Increment 6)

`0006_safety_admin.sql` adds a server-controlled role + account-state model to
`users`, a unified report system, and append-only moderation/audit ledgers.

**`users` additive columns** (safe defaults; existing rows become `USER`/`ACTIVE`):

| Column | Notes |
|--------|-------|
| `role` | `USER` \| `MODERATOR` \| `ADMIN` (CHECK), default `USER`. |
| `account_status` | `ACTIVE` \| `SUSPENDED` \| `DEACTIVATED` (CHECK), default `ACTIVE`. |
| `suspended_until` | optional suspension expiry (auto-lapses to ACTIVE). |
| `suspension_reason` | reason text. |

Indexes: `users_role`, `users_account_status` (both partial on non-deleted).

| Table | Purpose / notable constraints |
|-------|-------------------------------|
| `safety_reports` | Unified reports. `target_type` CHECK + 4 FK-backed typed target columns, with a CHECK that exactly one target matches the type (no fragile polymorphic FK). Partial `UNIQUE` on `(reporter, type, coalesced target)` where status in OPEN/IN_REVIEW throttles duplicate reports. Status machine `OPEN→IN_REVIEW→RESOLVED\|DISMISSED`. |
| `moderation_actions` | Append-only decision ledger (actor, action, target, reason, optional report). FK actor `ON DELETE RESTRICT`. |
| `audit_logs` | Append-only. `metadata jsonb` (sanitized by the app). Indexed by actor/action/target/created. No update/delete path anywhere in the application. |

The Increment 5 `media_reports` table is preserved for compatibility; new
reports flow through `safety_reports`.

## Migration 0007 — notifications + presence (Increment 7)

`0007_notifications_presence.sql` adds a PostgreSQL-authoritative notification
store, per-category preferences, and a single persistent presence column.
Forward-only and additive.

| Table / column | Purpose / notable constraints |
|----------------|-------------------------------|
| `notifications` | Authoritative per-user notification store. `type` and `category` are `CHECK`-constrained enums. `title`/`body` are short display-only text (`<= 200` / `<= 500` chars) that **never** hold private bodies/PII. `entity_type`/`entity_id` only *reference* a related object (the client re-fetches + re-authorizes it via normal APIs). `dedupe_key` is an optional deterministic idempotency key. `read_at`/`expires_at` nullable; `created_at` default `now()`. FK `user_id ON DELETE CASCADE`. |
| `notification_preferences` | Per-`(user_id, category)` enable toggle, PK `(user_id, category)`. A **missing** row means "default" (resolved lazily by the app as enabled) — so there is no per-user initialization race. `updated_at` maintained by the shared `set_updated_at` trigger. FK `ON DELETE CASCADE`. |
| `users.last_seen_at` (additive column) | The **only** persisted presence state. Written **only** on the `ONLINE→OFFLINE` transition. Live "online" is deliberately NOT stored — it lives in the in-memory `PresenceRegistry` so it can never go stale across restarts. |

Indexes on `notifications`:

| Index | Purpose |
|-------|---------|
| `notifications_user_feed` on `(user_id, created_at DESC, id DESC)` | Keyset-paginated feed, newest first. |
| `notifications_user_unread` partial `WHERE read_at IS NULL` | Fast unread count + `unread=true` filter. |
| `notifications_dedupe` **unique** partial on `(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL` | Enforces at most one notification per `(user, dedupe_key)`; backs `ON CONFLICT DO NOTHING` dedup. |
| `notifications_expires` partial `WHERE expires_at IS NOT NULL` | Supports expiry/cleanup scans. |

Expiry convention: non-critical notifications are created with a 90-day
`expires_at`; SAFETY notifications are created with `expires_at = NULL` (never
expire). Expired rows are filtered out of the feed/count by
`(expires_at IS NULL OR expires_at > now())` and removed by the cleanup job.

## Migration 0008 — notification delivery + devices (Increment 8)

`0008_notification_delivery.sql` adds the out-of-band delivery layer. Additive
and backward-compatible; the legacy `devices` table (0001, unused) is left
untouched.

| Table / column | Purpose / notable constraints |
|----------------|-------------------------------|
| `notification_devices` | Registered push targets owned by a user. `platform` ∈ `WEB`/`ANDROID`/`IOS`, `provider` ∈ `FCM`/`APNS`/`WEB_PUSH`/`TEST`/`DISABLED` (both `CHECK`-constrained). Stores the raw `token` (a credential — **never** selected into any DTO; the repository's `toView` omits it), a `token_hash` (SHA-256, for uniqueness/dedup) and a short `token_fingerprint` (safe UI display). `revoked_at` nullable; `last_seen_at` updated on registration. FK `ON DELETE CASCADE`. |
| `notification_deliveries` | One row per `(notification, device, channel)`. `channel` ∈ `REALTIME`/`PUSH`; `status` machine `PENDING→SENT→DELIVERED` \| `FAILED` \| `REVOKED`. `attempt_count`, sanitized `last_error_code` (never a full provider response), `provider_message_id`. FKs `ON DELETE CASCADE` to both the notification and the device. |
| `notification_preferences.push_enabled` (additive column, default `true`) | PUSH delivery toggle, **distinct** from `enabled` (in-app existence). Disabling push never removes the in-app notification. A missing row still means "default" (both enabled). |

Indexes:

| Index | Purpose |
|-------|---------|
| `notification_devices_active_token` **unique** partial on `(user_id, token_hash) WHERE revoked_at IS NULL` | At most one ACTIVE registration per `(user, token)`; backs idempotent upsert registration. A revoked row may coexist with a fresh active one. |
| `notification_devices_user` on `(user_id, created_at DESC)` | List a user's devices. |
| `notification_devices_revoked` partial `WHERE revoked_at IS NOT NULL` | Cleanup of long-revoked devices. |
| `notification_deliveries_unique` **unique** on `(notification_id, channel, COALESCE(device_id, '000…0'::uuid))` | Idempotent, race-safe delivery (one logical delivery per notification/device/channel). `device_id` is `NULL` for REALTIME, coalesced to the all-zero UUID in the key. |
| `notification_deliveries_notification` / `_device` | Lookups per notification / device. |
| `notification_deliveries_retry` partial `WHERE status = 'FAILED'` | Supports the bounded retry scan. |

Delivery retention: terminal (`DELIVERED`/`REVOKED`) delivery rows and devices
revoked longer than 30 days are removed by `cleanupDeliveryRecords`; the
notification tables keep their own retention.

## Resetting a dev/test database

Migrations are forward-only; to reset, drop and recreate the database, then
`migrate:up`. The test runner does this automatically.
