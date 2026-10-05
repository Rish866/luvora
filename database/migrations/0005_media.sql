-- Migration 0005: secure media, attachments & moderation. Increment 5.
--
-- Design:
--  * media_assets holds server-controlled metadata for every uploaded asset.
--    Clients NEVER set status/moderation_status/dimensions/detected mime — the
--    server derives those from byte inspection. storage_key is opaque + random
--    and never exposed to clients.
--  * message_attachments is a normalized relation linking a media asset to a
--    chat message (no JSON blob in `messages`). UNIQUE prevents duplicate links.
--  * media_reports records user reports without exposing reporter identity to
--    other users; UNIQUE throttles duplicate reports per (reporter, media).
--
-- Forward-only, additive. Safe after 0001-0004; preserves existing data.

-- =========================================================================
-- MEDIA ASSETS
-- =========================================================================
CREATE TABLE media_assets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Opaque, server-generated storage key (never derived from user filename).
  storage_key         TEXT NOT NULL,
  thumbnail_storage_key TEXT,
  -- Client-declared values (recorded but NOT trusted for access decisions).
  original_filename   TEXT,
  declared_mime_type  TEXT,
  -- Server-detected values from byte inspection (authoritative).
  detected_mime_type  TEXT,
  byte_size           BIGINT,
  sha256              TEXT,
  width               INT,
  height              INT,
  duration_ms         INT,            -- future-compatible (video/audio); null for images
  -- Upload/processing lifecycle (server-controlled).
  status              TEXT NOT NULL DEFAULT 'UPLOADING'
                      CHECK (status IN ('UPLOADING','UPLOADED','PROCESSING','READY','QUARANTINED','REJECTED','DELETED')),
  -- Moderation lifecycle (independent of upload status).
  moderation_status   TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (moderation_status IN ('PENDING','APPROVED','REJECTED','NEEDS_REVIEW')),
  moderation_reason   TEXT,
  -- Context the asset was created for (restricts where it may be attached).
  context             TEXT NOT NULL DEFAULT 'chat'
                      CHECK (context IN ('chat','session','profile')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX media_assets_owner ON media_assets (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX media_assets_status ON media_assets (status);
-- Supports orphan cleanup of abandoned UPLOADING assets by age.
CREATE INDEX media_assets_uploading_created
  ON media_assets (created_at) WHERE status = 'UPLOADING';
CREATE TRIGGER media_assets_updated_at BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- MESSAGE ATTACHMENTS (normalized link; no JSON blob in messages)
-- =========================================================================
CREATE TABLE message_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_id    uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A given media asset is linked at most once per message.
  UNIQUE (message_id, media_id)
);
CREATE INDEX message_attachments_message ON message_attachments (message_id);
CREATE INDEX message_attachments_media ON message_attachments (media_id);

-- =========================================================================
-- MEDIA REPORTS
-- =========================================================================
CREATE TABLE media_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id    uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL
              CHECK (reason IN ('CSAM','NONCONSENSUAL','VIOLENCE','HARASSMENT','SPAM','OTHER')),
  status      TEXT NOT NULL DEFAULT 'OPEN'
              CHECK (status IN ('OPEN','REVIEWING','RESOLVED','DISMISSED')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- At most one open report per (reporter, media) to throttle spam.
  UNIQUE (media_id, reporter_id)
);
CREATE INDEX media_reports_media ON media_reports (media_id);

-- =========================================================================
-- Allow attachment-only messages.
-- Migration 0003 enforced a non-empty message body. With Increment 5 a message
-- may legitimately carry NO text but one or more attachments. The authoritative
-- rule ("text OR >=1 attachment, non-empty text when present") is enforced in
-- the application (chatService.validateBody). We drop the body-non-empty DB
-- check; the byte-size cap stays.
-- =========================================================================
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_body_nonempty;
