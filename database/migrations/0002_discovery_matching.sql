-- Migration 0002: Discovery & matching support. Increment 2.
--
-- The Increment 1 schema already models the social graph (likes, matches,
-- blocks) with the right uniqueness/canonical-ordering constraints, so this
-- migration is intentionally small: it adds the INDEXES the discovery query and
-- relationship lookups need to run efficiently at the database layer (never by
-- loading rows and filtering in application code).
--
-- Forward-only. No destructive changes. Safe on existing data.

-- ------------------------------------------------------------------------
-- likes: discovery needs to find "every decision the current actor has already
-- made" (to exclude already-liked/-passed candidates) and the reciprocal
-- "has the candidate liked me?" lookup for match detection.
--
-- 0001 created only `likes_likee (likee_id) WHERE is_pass = false`. We add an
-- actor-side index covering both like and pass decisions.
-- ------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS likes_liker ON likes (liker_id);

-- Reciprocal "did candidate like me?" — a liker->likee lookup limited to likes
-- (not passes), used by both discovery exclusion and match creation.
CREATE INDEX IF NOT EXISTS likes_liker_likee_like
  ON likes (liker_id, likee_id) WHERE is_pass = false;

-- ------------------------------------------------------------------------
-- blocks: discovery must exclude both directions (A blocked B, and B blocked
-- A). 0001 created only `blocks_blocked (blocked_id)`. Add the actor-side index
-- so "blocks created by the current user" is efficient.
-- ------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS blocks_blocker ON blocks (blocker_id);

-- ------------------------------------------------------------------------
-- Discovery ordering is deterministic on (created_at, id). Index users so the
-- ordered, keyset-paginated scan is efficient and only considers live accounts.
-- (Partial index mirrors the eligibility predicate used by the feed query.)
-- ------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS users_discovery_order
  ON users (created_at, id)
  WHERE deleted_at IS NULL AND is_disabled = false;
