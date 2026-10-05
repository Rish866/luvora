-- Migration 0011: security hardening — durable security-event store.
-- Increment 11. Forward-only, additive, alters no existing table.
--
-- SCOPE DECISION: high-frequency abuse state (per-IP / per-account rate-limit
-- and login-failure counters) is INTENTIONALLY kept in-process (the AbuseGuard),
-- NOT in PostgreSQL — writing a row per request would be a self-inflicted DoS.
-- This table holds only LOW-VOLUME, SIGNIFICANT, durable security events worth
-- auditing/forensics (e.g. brute-force lockout triggered, refresh-token reuse
-- detected, repeated unauthorized access). It complements (does not replace)
-- `audit_logs` (admin actions) and `operational_events` (operational signals).
--
-- PRIVACY: `source_fingerprint` is a SALTED, TRUNCATED hash of the client IP
-- (NOT the raw IP) so forensics can correlate bursts from one source without
-- storing PII indefinitely. `metadata` is sanitized by the app before insert —
-- it never contains passwords, tokens, authorization headers, raw push tokens,
-- storage keys, message bodies, or consent details. Events expire via retention.

CREATE TABLE security_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The subject user when known (e.g. the account targeted by brute force).
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type         TEXT NOT NULL,
  severity           TEXT NOT NULL DEFAULT 'INFO'
                     CHECK (severity IN ('INFO','WARNING','ERROR','CRITICAL')),
  -- Logical category/surface (e.g. 'auth', 'websocket', 'media', 'admin').
  category           TEXT,
  -- Salted + truncated hash of the client source (never the raw IP). Nullable.
  source_fingerprint TEXT,
  correlation_id     TEXT,
  -- Flat, sanitized JSON (safe scalars only).
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recent-first scan + retention cleanup.
CREATE INDEX security_events_created ON security_events (created_at DESC);
-- Filter by type / category for investigation.
CREATE INDEX security_events_type ON security_events (event_type, created_at DESC);
CREATE INDEX security_events_category ON security_events (category, created_at DESC);
-- Correlate a user's security events and a source's burst.
CREATE INDEX security_events_user ON security_events (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX security_events_source ON security_events (source_fingerprint) WHERE source_fingerprint IS NOT NULL;
