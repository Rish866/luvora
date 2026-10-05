-- Migration 0012: profile photos — standardize profile media on media_assets.
-- Increment 14. Forward-only, additive, alters no existing table's data.
--
-- CONTEXT (from PRODUCT_AUDIT.md, finding D-1): the product had TWO parallel
-- photo models. The legacy `photos` table (0001) is referenced by discovery/
-- match reads but is NEVER written by any code, seed, or test — so profile
-- avatars were always null. The real media pipeline (`media_assets`, 0005)
-- already supports a `context='profile'` value but was never wired to profiles.
--
-- This migration introduces ONE authoritative profile-photo model: a join
-- table linking a user to the `media_assets` rows that are their profile
-- photos, with explicit display ordering and exactly one primary photo. All
-- upload/validation/EXIF-strip/moderation reuse the existing media pipeline;
-- bytes are served through the existing authenticated /api/media/:id/content
-- endpoint (never a raw storage key).
--
-- The legacy `photos` table is deliberately LEFT IN PLACE (not dropped): it is
-- unused by any writer, dropping it is a separate, independently-verifiable
-- cleanup, and keeping it avoids any risk to the 0001 schema. Discovery/match
-- reads are migrated (in application code) to `profile_photos`.

-- =========================================================================
-- PROFILE PHOTOS (join: user -> media_assets, ordered, one primary)
-- =========================================================================
CREATE TABLE profile_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The underlying media asset. ON DELETE CASCADE so removing the media row
  -- (hard delete / owner cleanup) also removes the profile association. A media
  -- asset is a profile photo for at most one user (it is owned by that user).
  media_id    uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  -- Zero-based display order within the user's gallery. Lower sorts first.
  position    INT  NOT NULL DEFAULT 0,
  -- Exactly one primary per user is enforced by the partial unique index below.
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A given media asset appears at most once as a profile photo.
  UNIQUE (media_id)
);

-- Fast lookup + deterministic ordering of a user's gallery.
CREATE INDEX profile_photos_user ON profile_photos (user_id, position, created_at);

-- At most ONE primary photo per user. Partial unique index: only rows with
-- is_primary=true participate, so non-primary rows are unconstrained.
CREATE UNIQUE INDEX profile_photos_one_primary
  ON profile_photos (user_id) WHERE is_primary;

CREATE TRIGGER profile_photos_updated_at BEFORE UPDATE ON profile_photos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
