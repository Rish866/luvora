-- Migration 0001: core foundation (users, auth sessions, devices, profiles,
-- social graph, consent, fantasy sessions). Increment 1.
--
-- Design notes:
--  * UUID primary keys (gen_random_uuid from pgcrypto) — avoids enumerable IDs,
--    which matters for the "changing an ID in a request must not grant access"
--    security requirement.
--  * created_at / updated_at on every table; soft delete via deleted_at where
--    user data must be recoverable / anonymizable.
--  * CHECK constraints and FKs enforce invariants at the DB layer, not just app.

-- gen_random_uuid() is built into PostgreSQL core since v13, so no extension is
-- required. (We previously used pgcrypto; core support is more portable.)

-- Reusable updated_at trigger.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- USERS & AUTH
-- =========================================================================
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT NOT NULL,                          -- uniqueness via lower() index below
  password_hash     TEXT NOT NULL,
  -- Age gate: we store date_of_birth to derive age, plus an explicit
  -- confirmation flag + timestamp proving the 18+ attestation was made.
  date_of_birth     DATE NOT NULL,
  age_confirmed_at  TIMESTAMPTZ,
  email_verified_at TIMESTAMPTZ,
  is_disabled       BOOLEAN NOT NULL DEFAULT false,
  disabled_reason   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  -- Hard invariant: nobody under 18 can exist as an active user.
  CONSTRAINT users_min_age CHECK (date_of_birth <= (CURRENT_DATE - INTERVAL '18 years'))
);
-- Case-insensitive unique email among non-deleted users.
CREATE UNIQUE INDEX users_email_unique
  ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auth sessions = refresh-token families.
--
-- Each row is a single refresh token (stored only as a SHA-256 hash). A login
-- starts a new family (family_id). On refresh we mark the presented token's row
-- rotated_at and INSERT a new row in the same family. Presenting an
-- already-rotated token (reuse) signals theft, so we revoke the entire family.
CREATE TABLE auth_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id          uuid NOT NULL,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  rotated_at         TIMESTAMPTZ,     -- set when this token has been exchanged
  revoked_at         TIMESTAMPTZ,     -- set on logout / family revocation
  user_agent         TEXT,
  ip                 TEXT,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_family ON auth_sessions(family_id);
CREATE UNIQUE INDEX auth_sessions_token ON auth_sessions(refresh_token_hash);

-- Registered push devices.
CREATE TABLE devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  push_token  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, push_token)
);
CREATE TRIGGER devices_updated_at BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- PROFILES
-- =========================================================================
CREATE TABLE profiles (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name        TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 50),
  bio                 TEXT CHECK (bio IS NULL OR char_length(bio) <= 500),
  interests           TEXT[] NOT NULL DEFAULT '{}',
  fantasy_preferences TEXT[] NOT NULL DEFAULT '{}',
  -- Privacy controls (defaults are privacy-preserving).
  age_visible         BOOLEAN NOT NULL DEFAULT true,
  online_status_visible BOOLEAN NOT NULL DEFAULT true,
  read_receipts_enabled BOOLEAN NOT NULL DEFAULT true,
  discoverable        BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE photos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key       TEXT NOT NULL,            -- opaque object-storage key, never public
  position          INT NOT NULL DEFAULT 0,
  moderation_state  TEXT NOT NULL DEFAULT 'MODERATION_PENDING'
                    CHECK (moderation_state IN ('UPLOADING','MODERATION_PENDING','APPROVED','REJECTED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX photos_user ON photos(user_id) WHERE deleted_at IS NULL;

-- =========================================================================
-- SOCIAL GRAPH: likes, matches, blocks
-- =========================================================================
CREATE TABLE likes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  liker_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  likee_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_pass    BOOLEAN NOT NULL DEFAULT false,  -- true = explicit pass/dislike
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT likes_no_self CHECK (liker_id <> likee_id),
  -- One decision per (liker, likee): prevents duplicate likes.
  UNIQUE (liker_id, likee_id)
);
CREATE INDEX likes_likee ON likes(likee_id) WHERE is_pass = false;

CREATE TABLE matches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical ordering (user_a < user_b) so a pair has exactly one match row.
  user_a     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','UNMATCHED','BLOCKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT matches_order CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);
CREATE INDEX matches_user_a ON matches(user_a);
CREATE INDEX matches_user_b ON matches(user_b);
CREATE TRIGGER matches_updated_at BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE blocks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT blocks_no_self CHECK (blocker_id <> blocked_id),
  UNIQUE (blocker_id, blocked_id)
);
CREATE INDEX blocks_blocked ON blocks(blocked_id);

-- =========================================================================
-- FANTASY SESSIONS + CONSENT
-- =========================================================================
CREATE TABLE fantasy_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id       uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  scenario_id    TEXT NOT NULL,
  scenario_version TEXT NOT NULL,          -- active sessions pin a content version
  state          TEXT NOT NULL DEFAULT 'WAITING'
                 CHECK (state IN ('WAITING','INVITED','ACCEPTED','CONSENT','PLAYING','PAUSED','COMPLETED','ABANDONED','REPORTED')),
  initiator_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_scene_id TEXT,
  seq            BIGINT NOT NULL DEFAULT 0, -- monotonic event sequence number
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fantasy_sessions_distinct_players CHECK (initiator_id <> invitee_id)
);
CREATE INDEX fantasy_sessions_match ON fantasy_sessions(match_id);
CREATE INDEX fantasy_sessions_state ON fantasy_sessions(state);
CREATE TRIGGER fantasy_sessions_updated_at BEFORE UPDATE ON fantasy_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-player participation + explicit "I agree to participate" confirmation.
CREATE TABLE fantasy_players (
  session_id     uuid NOT NULL REFERENCES fantasy_sessions(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_status TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (consent_status IN ('PENDING','SUBMITTED','CONFIRMED')),
  participation_agreed_at TIMESTAMPTZ,
  joined_at      TIMESTAMPTZ,
  left_at        TIMESTAMPTZ,
  PRIMARY KEY (session_id, user_id)
);

-- Private consent responses. CRITICAL: rows here are NEVER exposed to the other
-- player via any API; only the server-computed allow-list is shared.
CREATE TABLE consent_responses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES fantasy_sessions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  response        TEXT NOT NULL CHECK (response IN ('YES','MAYBE','NO')),
  consent_version TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id, category)
);
CREATE INDEX consent_responses_session_user ON consent_responses(session_id, user_id);
