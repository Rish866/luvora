-- Migration 0007: notifications + presence infrastructure. Increment 7.
--
-- Notifications are PostgreSQL-backed and authoritative; WebSocket delivery is a
-- real-time optimization layered on top. Presence is process-local (in-memory
-- registry); only last_seen is persisted here. Forward-only, additive.

-- =========================================================================
-- NOTIFICATIONS
-- =========================================================================
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL
              CHECK (type IN (
                'MATCH_CREATED','MESSAGE_RECEIVED','FANTASY_INVITE','FANTASY_ACCEPTED',
                'FANTASY_STARTED','FANTASY_COMPLETED','SESSION_PAUSED','SESSION_RESUMED',
                'SAFETY_ACTION','SYSTEM'
              )),
  category    TEXT NOT NULL
              CHECK (category IN ('MATCHES','MESSAGES','FANTASY','SYSTEM','SAFETY')),
  -- Safe display fields only. NEVER private message bodies / consent / PII.
  title       TEXT NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  body        TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 500),
  -- Structured reference to the related entity (resolved + re-authorized by the
  -- client via normal APIs; the notification only *references* it).
  entity_type TEXT,
  entity_id   uuid,
  -- Deterministic idempotency key for events that may be emitted more than once.
  dedupe_key  TEXT,
  read_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keyset pagination of a user's feed (newest first).
CREATE INDEX notifications_user_feed ON notifications (user_id, created_at DESC, id DESC);
-- Efficient unread count / unread filter (partial index on unread rows only).
CREATE INDEX notifications_user_unread
  ON notifications (user_id, created_at DESC, id DESC) WHERE read_at IS NULL;
-- Dedup: at most one notification per (user, dedupe_key) when a key is supplied.
CREATE UNIQUE INDEX notifications_dedupe
  ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- Supports expiry cleanup.
CREATE INDEX notifications_expires ON notifications (expires_at) WHERE expires_at IS NOT NULL;

-- =========================================================================
-- NOTIFICATION PREFERENCES — per (user, category) toggle.
--
-- Missing rows mean "default", resolved lazily by the app (default-enabled for
-- non-critical categories). SAFETY is critical and is never suppressed by the
-- service regardless of any stored preference.
-- =========================================================================
CREATE TABLE notification_preferences (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   TEXT NOT NULL
             CHECK (category IN ('MATCHES','MESSAGES','FANTASY','SYSTEM','SAFETY')),
  enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);
CREATE TRIGGER notification_preferences_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- PRESENCE: persistent last-seen only. Live "online" is in-memory/process-local
-- (PresenceRegistry) and intentionally NOT stored, so it can never go stale.
-- =========================================================================
ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ;
