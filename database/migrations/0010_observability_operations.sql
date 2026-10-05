-- Migration 0010: observability & operational events. Increment 10.
--
-- Additive and safe. Does NOT alter any existing table. The ONLY durable
-- operational state introduced here is `operational_events` — a low-volume
-- store for SIGNIFICANT operational/security events (worker lifecycle, admin
-- operational actions, threshold/circuit signals). High-frequency telemetry
-- (per-HTTP-request counters, histograms, DB/WS/job metrics) is intentionally
-- IN-PROCESS and is NOT written here, so this table never becomes a per-request
-- firehose.
--
-- Security: `metadata` is sanitized by the application before insert — it never
-- contains tokens, passwords, raw job payloads, message bodies, media keys, or
-- credentials. Severity is CHECK-constrained.

CREATE TABLE operational_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'INFO'
                CHECK (severity IN ('INFO','WARNING','ERROR','CRITICAL')),
  -- Who/what the event relates to (all optional).
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  correlation_id TEXT,
  job_id        uuid,                       -- not FK: a job row may be pruned
  entity_type   TEXT,
  entity_id     uuid,
  -- Sanitized, flat JSON — safe scalar values only.
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Recent events first; retention cleanup scans by created_at.
CREATE INDEX operational_events_created ON operational_events (created_at DESC);
-- Filter by type / severity for diagnostics.
CREATE INDEX operational_events_type ON operational_events (event_type, created_at DESC);
CREATE INDEX operational_events_severity ON operational_events (severity, created_at DESC);
-- Correlate events for a given actor / job when investigating.
CREATE INDEX operational_events_actor ON operational_events (actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX operational_events_job ON operational_events (job_id) WHERE job_id IS NOT NULL;
