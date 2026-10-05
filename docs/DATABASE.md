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

## Resetting a dev/test database

Migrations are forward-only; to reset, drop and recreate the database, then
`migrate:up`. The test runner does this automatically.
