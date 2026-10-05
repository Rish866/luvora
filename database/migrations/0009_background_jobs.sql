-- Migration 0009: durable PostgreSQL-backed background job queue. Increment 9.
--
-- Replaces fragile fire-and-forget async work (Increment 8's `void deliver(...)`
-- and manual retry calls) with a durable queue that survives API/worker/machine
-- restarts and worker crashes. Forward-only, additive, backward-compatible — no
-- prior migration is modified.
--
-- Design:
--  * PostgreSQL is the source of truth for job state.
--  * Workers claim jobs with `FOR UPDATE SKIP LOCKED` and hold a lease
--    (`leased_until` + `worker_id`); an expired lease is reclaimable by any
--    worker, so a crashed worker never leaves a job permanently stuck.
--  * At-least-once execution — handlers MUST be idempotent.
--  * Payloads are server-controlled JSON (ids/flags only); never credentials,
--    tokens, message bodies, consent, or media keys (enforced in app code).

-- =========================================================================
-- BACKGROUND JOBS
-- =========================================================================
CREATE TABLE background_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','RUNNING','RETRY_WAIT','SUCCEEDED','DEAD','CANCELLED')),
  -- Server-controlled payload. Keep it to ids/flags — NEVER secrets.
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Optional deterministic idempotency key. When present, (job_type, key) is
  -- unique among non-terminal jobs so the same logical job is enqueued once.
  idempotency_key    TEXT,
  -- Lower number = higher priority (claimed ascending).
  priority           INTEGER NOT NULL DEFAULT 100,
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts       INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  -- Earliest time the job may be claimed (drives delays + backoff).
  available_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lease: set while RUNNING; an expired lease is reclaimable.
  leased_until       TIMESTAMPTZ,
  worker_id          TEXT,
  -- Sanitized error metadata (never a full provider response / secret).
  last_error_code    TEXT,
  last_error_message TEXT,
  failed_at          TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER background_jobs_updated_at
  BEFORE UPDATE ON background_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Idempotency: at most one NON-TERMINAL job per (job_type, idempotency_key)
-- when a key is supplied. Terminal jobs (SUCCEEDED/DEAD/CANCELLED) are excluded
-- so the same logical job can be re-enqueued later (e.g. periodic cleanup).
-- Jobs with a NULL idempotency_key may legitimately duplicate.
CREATE UNIQUE INDEX background_jobs_idempotency
  ON background_jobs (job_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND status IN ('PENDING','RUNNING','RETRY_WAIT');

-- Worker claim query: available PENDING/RETRY_WAIT jobs, highest priority then
-- oldest availability first. Partial index keeps the hot path small.
CREATE INDEX background_jobs_claimable
  ON background_jobs (priority ASC, available_at ASC)
  WHERE status IN ('PENDING','RETRY_WAIT');

-- Reclaim query: RUNNING jobs whose lease has expired.
CREATE INDEX background_jobs_running_lease
  ON background_jobs (leased_until)
  WHERE status = 'RUNNING';

-- Diagnostics / admin filters.
CREATE INDEX background_jobs_type_status ON background_jobs (job_type, status);
CREATE INDEX background_jobs_status_created ON background_jobs (status, created_at DESC);
-- Retention cleanup of terminal jobs.
CREATE INDEX background_jobs_terminal_updated
  ON background_jobs (updated_at)
  WHERE status IN ('SUCCEEDED','DEAD','CANCELLED');
