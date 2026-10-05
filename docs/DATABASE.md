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

## Resetting a dev/test database

Migrations are forward-only; to reset, drop and recreate the database, then
`migrate:up`. The test runner does this automatically.
