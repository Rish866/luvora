-- Migration 0006: admin + safety + moderation operations. Increment 6.
--
-- Adds a server-controlled role + account-state model to users, a unified
-- safety-report system, an append-only moderation-action ledger, and an
-- append-only audit log. Forward-only, additive; preserves all existing data
-- and the Increment 5 media_reports table (kept for compatibility).

-- =========================================================================
-- USERS: role + account state (server-controlled; client can never set these)
-- =========================================================================
ALTER TABLE users
  ADD COLUMN role TEXT NOT NULL DEFAULT 'USER'
    CHECK (role IN ('USER','MODERATOR','ADMIN')),
  ADD COLUMN account_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (account_status IN ('ACTIVE','SUSPENDED','DEACTIVATED')),
  ADD COLUMN suspended_until   TIMESTAMPTZ,
  ADD COLUMN suspension_reason TEXT;

-- Existing accounts default to USER/ACTIVE (safe: nobody is accidentally
-- privileged or locked out).
CREATE INDEX users_role ON users (role) WHERE deleted_at IS NULL;
CREATE INDEX users_account_status ON users (account_status) WHERE deleted_at IS NULL;

-- =========================================================================
-- SAFETY REPORTS — unified report model for multiple target types.
--
-- We avoid a fragile polymorphic FK: target_type is constrained, and the
-- correct typed id column is populated with a real FK per type. Exactly one
-- target column is non-null (enforced by a CHECK), so integrity is preserved.
-- =========================================================================
CREATE TABLE safety_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type        TEXT NOT NULL CHECK (target_type IN ('USER','MEDIA','MESSAGE','SESSION')),
  -- Typed, FK-backed target columns (exactly one set, per CHECK below).
  target_user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  target_media_id    uuid REFERENCES media_assets(id) ON DELETE CASCADE,
  target_message_id  uuid REFERENCES messages(id) ON DELETE CASCADE,
  target_session_id  uuid REFERENCES fantasy_sessions(id) ON DELETE CASCADE,
  reason             TEXT NOT NULL
                     CHECK (reason IN ('CSAM','NONCONSENSUAL','VIOLENCE','HARASSMENT','SPAM','HATE','SELF_HARM','OTHER')),
  description        TEXT CHECK (description IS NULL OR char_length(description) <= 2000),
  status             TEXT NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','DISMISSED')),
  priority           TEXT NOT NULL DEFAULT 'NORMAL'
                     CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  assigned_to        uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution         TEXT CHECK (resolution IS NULL OR char_length(resolution) <= 2000),
  resolved_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Exactly one target column must be set, matching target_type.
  CONSTRAINT safety_reports_target_shape CHECK (
    (target_type = 'USER'    AND target_user_id    IS NOT NULL AND target_media_id IS NULL AND target_message_id IS NULL AND target_session_id IS NULL) OR
    (target_type = 'MEDIA'   AND target_media_id   IS NOT NULL AND target_user_id  IS NULL AND target_message_id IS NULL AND target_session_id IS NULL) OR
    (target_type = 'MESSAGE' AND target_message_id IS NOT NULL AND target_user_id  IS NULL AND target_media_id   IS NULL AND target_session_id IS NULL) OR
    (target_type = 'SESSION' AND target_session_id IS NOT NULL AND target_user_id  IS NULL AND target_media_id   IS NULL AND target_message_id IS NULL)
  )
);
CREATE INDEX safety_reports_status   ON safety_reports (status, priority, created_at, id);
CREATE INDEX safety_reports_reporter ON safety_reports (reporter_user_id);
CREATE INDEX safety_reports_assigned ON safety_reports (assigned_to) WHERE assigned_to IS NOT NULL;
-- One OPEN/IN_REVIEW report per (reporter, target) to throttle duplicate spam.
-- A partial unique index keyed on a coalesced target id, limited to live reports.
CREATE UNIQUE INDEX safety_reports_dedup
  ON safety_reports (
    reporter_user_id,
    target_type,
    COALESCE(target_user_id, target_media_id, target_message_id, target_session_id)
  )
  WHERE status IN ('OPEN','IN_REVIEW');
CREATE TRIGGER safety_reports_updated_at BEFORE UPDATE ON safety_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- MODERATION ACTIONS — append-only ledger of moderator/admin decisions.
-- =========================================================================
CREATE TABLE moderation_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL CHECK (target_type IN ('USER','MEDIA','MESSAGE','SESSION','REPORT')),
  target_id    uuid NOT NULL,
  reason       TEXT CHECK (reason IS NULL OR char_length(reason) <= 2000),
  report_id    uuid REFERENCES safety_reports(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_target ON moderation_actions (target_type, target_id);
CREATE INDEX moderation_actions_actor  ON moderation_actions (actor_user_id);

-- =========================================================================
-- AUDIT LOGS — append-only. Metadata is intentionally sanitized by the app
-- (no tokens/passwords/message bodies/raw bytes). There is deliberately NO
-- update/delete path exposed by the application.
-- =========================================================================
CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     uuid,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor  ON audit_logs (actor_user_id, created_at, id);
CREATE INDEX audit_logs_action ON audit_logs (action, created_at, id);
CREATE INDEX audit_logs_target ON audit_logs (target_type, target_id);
CREATE INDEX audit_logs_created ON audit_logs (created_at, id);
