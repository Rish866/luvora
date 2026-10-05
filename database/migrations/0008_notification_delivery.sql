-- Migration 0008: production-grade notification delivery + delivery tracking.
-- Increment 8. Forward-only, additive, backward-compatible.
--
-- PostgreSQL notifications (0007) remain authoritative. This migration adds the
-- out-of-band DELIVERY layer: registered push devices and per-(notification,
-- device, channel) delivery records. Nothing here is required for a notification
-- to exist — push delivery is strictly best-effort.
--
-- Security notes:
--  * Raw push tokens are credentials. We store the token itself (needed to call
--    a provider) PLUS a non-reversible SHA-256 hash used for uniqueness/dedup
--    and a short fingerprint used for safe display. Tokens are NEVER selected
--    into any client/admin DTO (enforced in the repository) and NEVER logged.
--  * The legacy `devices` table (0001, unused) is left untouched for backward
--    compatibility; this is a separate, richer table.

-- =========================================================================
-- NOTIFICATION DEVICES — registered push targets, owned by a single user.
-- =========================================================================
CREATE TABLE notification_devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL CHECK (platform IN ('WEB','ANDROID','IOS')),
  provider      TEXT NOT NULL CHECK (provider IN ('FCM','APNS','WEB_PUSH','TEST','DISABLED')),
  -- The raw provider token (credential). Never returned by any API.
  token         TEXT NOT NULL,
  -- SHA-256 of the token, used for uniqueness + dedup without comparing raw.
  token_hash    TEXT NOT NULL,
  -- Short, non-reversible fingerprint for safe UI display.
  token_fingerprint TEXT NOT NULL,
  label         TEXT CHECK (label IS NULL OR char_length(label) <= 100),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

-- At most one ACTIVE (non-revoked) registration per (user, token). A revoked
-- row may coexist with a fresh active one, so re-registering a previously
-- revoked token works. Registration upserts onto this partial unique index.
CREATE UNIQUE INDEX notification_devices_active_token
  ON notification_devices (user_id, token_hash) WHERE revoked_at IS NULL;
-- List a user's devices efficiently.
CREATE INDEX notification_devices_user ON notification_devices (user_id, created_at DESC);
-- Supports cleanup of long-revoked devices.
CREATE INDEX notification_devices_revoked
  ON notification_devices (revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TRIGGER notification_devices_updated_at
  BEFORE UPDATE ON notification_devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- NOTIFICATION DELIVERIES — one row per (notification, device, channel).
--
-- Tracks the lifecycle of each delivery attempt so the system can distinguish
-- created / sent / delivered / failed(temporary) / revoked(permanent). Provider
-- errors are sanitized to a short code before persistence; full provider
-- responses and credentials are NEVER stored.
-- =========================================================================
CREATE TABLE notification_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id     uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  -- NULL for the REALTIME channel (not device-scoped); set for PUSH.
  device_id           uuid REFERENCES notification_devices(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL CHECK (channel IN ('REALTIME','PUSH')),
  status              TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','SENT','DELIVERED','FAILED','REVOKED')),
  attempt_count       INT NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  last_error_code     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at        TIMESTAMPTZ
);

-- Idempotency: at most one delivery row per logical (notification, device,
-- channel). device_id is NULL for REALTIME, so we coalesce it to a fixed
-- sentinel UUID in the uniqueness expression (a real device id can never equal
-- the all-zero UUID). This makes concurrent dispatch attempts race-safe via
-- ON CONFLICT DO NOTHING rather than in-memory locks.
CREATE UNIQUE INDEX notification_deliveries_unique
  ON notification_deliveries
     (notification_id, channel, COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid));
-- Find deliveries for a notification / device.
CREATE INDEX notification_deliveries_notification ON notification_deliveries (notification_id);
CREATE INDEX notification_deliveries_device ON notification_deliveries (device_id) WHERE device_id IS NOT NULL;
-- Supports a retry scan: rows still eligible for another attempt.
CREATE INDEX notification_deliveries_retry
  ON notification_deliveries (status, updated_at) WHERE status = 'FAILED';

CREATE TRIGGER notification_deliveries_updated_at
  BEFORE UPDATE ON notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
-- PUSH DELIVERY PREFERENCE — distinct from notification EXISTENCE.
--
-- Disabling push for a category suppresses PUSH delivery only; the PostgreSQL
-- notification is still created and still appears in the in-app feed. SAFETY
-- remains critical and is handled by the service, not by a stored row.
-- =========================================================================
ALTER TABLE notification_preferences
  ADD COLUMN push_enabled BOOLEAN NOT NULL DEFAULT true;
