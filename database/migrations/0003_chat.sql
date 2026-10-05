-- Migration 0003: private chat (conversations, messages, read state).
-- Increment 3.
--
-- Design:
--  * One conversation per match. The `matches` table (Increment 1/2) remains
--    the authoritative relationship + eligibility (state ACTIVE) record; a
--    conversation is just the message container for a match, created lazily and
--    race-safely (UNIQUE(match_id) + INSERT ... ON CONFLICT).
--  * Messages are append-only for this increment (no edit/delete). IDs are
--    server-generated UUIDs; client_message_id is an optional idempotency key.
--  * Read state is a per-user marker (last read message) rather than a row per
--    message, keeping it compact.
--  * Presence/typing are ephemeral and are NOT persisted here.
--
-- Forward-only. Safe on existing data.

-- =========================================================================
-- CONVERSATIONS — exactly one per match.
-- =========================================================================
CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id   uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Enforces "one conversation per match" at the database layer.
  UNIQUE (match_id)
);
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- MESSAGES — append-only private messages within a conversation.
-- =========================================================================
CREATE TABLE messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body              TEXT NOT NULL,
  -- Optional client-supplied idempotency key (NOT the authoritative id).
  client_message_id uuid,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Server-side guard. The AUTHORITATIVE message limit (4000 Unicode code
  -- points, non-empty-after-trim) is enforced in the application
  -- (chatService.validateBody). This DB guard is a backstop against empty or
  -- absurdly large values and is intentionally byte-based so it does not depend
  -- on the database's character encoding/collation: 4000 code points is at most
  -- 16000 UTF-8 bytes, so 32000 bytes leaves safe headroom while still bounding
  -- storage. It must never reject a value the application already accepted.
  CONSTRAINT messages_body_nonempty CHECK (length(btrim(body)) >= 1),
  CONSTRAINT messages_body_max_bytes CHECK (octet_length(body) <= 32000)
);

-- Deterministic history ordering + efficient per-conversation keyset scans.
CREATE INDEX messages_conversation_order
  ON messages (conversation_id, created_at, id);

-- Idempotency: at most one message per (conversation, sender, client_message_id)
-- when a client idempotency key is supplied. NULL keys are not constrained
-- (Postgres treats NULLs as distinct), so messages without a key are unaffected.
CREATE UNIQUE INDEX messages_idempotency
  ON messages (conversation_id, sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

-- =========================================================================
-- READ STATE — per-user "last read message" marker per conversation.
-- =========================================================================
CREATE TABLE conversation_read_state (
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TRIGGER conversation_read_state_updated_at
  BEFORE UPDATE ON conversation_read_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
