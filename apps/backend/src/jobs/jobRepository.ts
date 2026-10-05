import type { PoolClient, QueryResultRow } from "pg";
import { query, withTransaction } from "../db/pool";
import { JobType, JobStatus } from "@luvora/shared";

/**
 * Data access for the durable background job queue (Increment 9).
 *
 * All SQL is parameterized. The claim path uses `FOR UPDATE SKIP LOCKED` so
 * multiple concurrent workers never claim the same row, and the critical
 * section (claim) commits BEFORE any external work runs — the worker never
 * holds a transaction open across a provider call.
 */

export interface JobRow {
  id: string;
  job_type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  leased_until: string | null;
  worker_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  failed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueInput {
  jobType: JobType;
  payload: Record<string, unknown>;
  idempotencyKey?: string | null;
  priority?: number;
  maxAttempts?: number;
  /** Earliest claim time (default: now). */
  availableAt?: Date | null;
}

type Runner = {
  query: <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ) => Promise<T[]>;
};

/** Build a runner over either a transaction client or the shared pool. */
function runner(client?: PoolClient): Runner {
  if (client) {
    return {
      query: <T extends QueryResultRow>(sql: string, params?: unknown[]) =>
        client.query<T>(sql, params as never[]).then((r) => r.rows as T[]),
    };
  }
  return {
    query: <T extends QueryResultRow>(sql: string, params?: unknown[]) =>
      query<T>(sql, params),
  };
}

/**
 * Enqueue a job. Transaction-aware: when `client` is supplied the INSERT joins
 * the caller's transaction, so a domain write (e.g. a notification INSERT) and
 * its job commit atomically (outbox pattern).
 *
 * Idempotency: when `idempotencyKey` is set, a conflicting NON-TERMINAL job of
 * the same type is NOT re-inserted (the partial unique index backs this); the
 * existing row is returned with `created=false`.
 */
export async function enqueue(
  input: EnqueueInput,
  client?: PoolClient,
): Promise<{ row: JobRow; created: boolean }> {
  const r = runner(client);
  const availableAt = input.availableAt ? input.availableAt.toISOString() : null;
  const inserted = await r.query<JobRow>(
    `INSERT INTO background_jobs
       (job_type, payload, idempotency_key, priority, max_attempts, available_at, status)
     VALUES ($1, $2::jsonb, $3, COALESCE($4, 100), COALESCE($5, 5),
             COALESCE($6::timestamptz, now()), 'PENDING')
     ON CONFLICT (job_type, idempotency_key)
       WHERE idempotency_key IS NOT NULL
         AND status IN ('PENDING','RUNNING','RETRY_WAIT')
       DO NOTHING
     RETURNING *`,
    [
      input.jobType,
      JSON.stringify(input.payload ?? {}),
      input.idempotencyKey ?? null,
      input.priority ?? null,
      input.maxAttempts ?? null,
      availableAt,
    ],
  );
  if (inserted[0]) return { row: inserted[0], created: true };

  // Conflict: a live job with this (type, key) already exists — return it.
  const existing = await r.query<JobRow>(
    `SELECT * FROM background_jobs
      WHERE job_type = $1 AND idempotency_key = $2
        AND status IN ('PENDING','RUNNING','RETRY_WAIT')
      ORDER BY created_at DESC
      LIMIT 1`,
    [input.jobType, input.idempotencyKey],
  );
  return { row: existing[0], created: false };
}

/**
 * Claim the next available job for `workerId`, atomically transitioning it to
 * RUNNING with a lease. Uses `FOR UPDATE SKIP LOCKED` so concurrent workers get
 * distinct rows. Claims jobs that are:
 *   - PENDING / RETRY_WAIT with available_at <= now  (new or backed-off work)
 *   - RUNNING with an EXPIRED lease                   (reclaimed crashed work)
 * Higher priority (lower number) then older availability wins.
 *
 * Reclaimed rows keep their attempt_count (a crash is not the job's fault, but
 * the attempt already happened — we do not reset it, preventing infinite work).
 */
export async function claimNext(
  workerId: string,
  leaseSeconds: number,
): Promise<JobRow | null> {
  return withTransaction(async (client) => {
    const picked = await client.query<{ id: string }>(
      `SELECT id FROM background_jobs
        WHERE (
                (status IN ('PENDING','RETRY_WAIT') AND available_at <= now())
             OR (status = 'RUNNING' AND leased_until IS NOT NULL AND leased_until <= now())
              )
        ORDER BY priority ASC, available_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    const row = picked.rows[0];
    if (!row) return null;

    const updated = await client.query<JobRow>(
      `UPDATE background_jobs
          SET status = 'RUNNING',
              worker_id = $2,
              leased_until = now() + ($3 || ' seconds')::interval,
              attempt_count = attempt_count + 1
        WHERE id = $1
        RETURNING *`,
      [row.id, workerId, String(leaseSeconds)],
    );
    return updated.rows[0] ?? null;
  });
}

/** Extend the lease of a RUNNING job owned by this worker (heartbeat). Returns
 *  false if the job is no longer owned/RUNNING (e.g. reclaimed meanwhile). */
export async function extendLease(
  jobId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE background_jobs
        SET leased_until = now() + ($3 || ' seconds')::interval
      WHERE id = $1 AND worker_id = $2 AND status = 'RUNNING'
      RETURNING id`,
    [jobId, workerId, String(leaseSeconds)],
  );
  return rows.length > 0;
}

/** Mark a job succeeded (terminal). Scoped to the owning worker + RUNNING so a
 *  reclaimed job isn't completed by a stale worker. Safe to call once. */
export async function markSucceeded(jobId: string, workerId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE background_jobs
        SET status = 'SUCCEEDED',
            completed_at = now(),
            leased_until = NULL,
            worker_id = NULL,
            last_error_code = NULL,
            last_error_message = NULL
      WHERE id = $1 AND worker_id = $2 AND status = 'RUNNING'
      RETURNING id`,
    [jobId, workerId],
  );
  return rows.length > 0;
}

/** Schedule a retry: RETRY_WAIT, next availability in `delayMs`, lease cleared,
 *  sanitized error retained. Scoped to the owning worker + RUNNING. */
export async function scheduleRetry(
  jobId: string,
  workerId: string,
  delayMs: number,
  errorCode: string,
  errorMessage: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE background_jobs
        SET status = 'RETRY_WAIT',
            available_at = now() + ($3 || ' milliseconds')::interval,
            leased_until = NULL,
            worker_id = NULL,
            last_error_code = $4,
            last_error_message = $5
      WHERE id = $1 AND worker_id = $2 AND status = 'RUNNING'
      RETURNING id`,
    [jobId, workerId, String(Math.max(0, Math.floor(delayMs))), errorCode, errorMessage],
  );
  return rows.length > 0;
}

/** Dead-letter a job (terminal). Scoped to the owning worker + RUNNING. */
export async function markDead(
  jobId: string,
  workerId: string,
  errorCode: string,
  errorMessage: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE background_jobs
        SET status = 'DEAD',
            failed_at = now(),
            leased_until = NULL,
            worker_id = NULL,
            last_error_code = $3,
            last_error_message = $4
      WHERE id = $1 AND worker_id = $2 AND status = 'RUNNING'
      RETURNING id`,
    [jobId, workerId, errorCode, errorMessage],
  );
  return rows.length > 0;
}

/** Cancel a non-terminal job (trusted server code only). Idempotent-ish:
 *  returns false if the job is already terminal. */
export async function cancel(jobId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE background_jobs
        SET status = 'CANCELLED', leased_until = NULL, worker_id = NULL
      WHERE id = $1 AND status IN ('PENDING','RETRY_WAIT','RUNNING')
      RETURNING id`,
    [jobId],
  );
  return rows.length > 0;
}

/**
 * Reclaim RUNNING jobs whose lease has expired by flipping them back to
 * RETRY_WAIT (available immediately). Concurrency-safe: `FOR UPDATE SKIP LOCKED`
 * means two concurrent reclaimers never fight over the same row. attempt_count
 * is NOT reset (the attempt already occurred). Returns the number reclaimed.
 *
 * A job that has already exhausted its attempts is dead-lettered instead of
 * being made available again (so a repeatedly-crashing job eventually stops).
 */
export async function reclaimExpired(limit = 100): Promise<{ reclaimed: number; dead: number }> {
  return withTransaction(async (client) => {
    const picked = await client.query<{ id: string; attempt_count: number; max_attempts: number }>(
      `SELECT id, attempt_count, max_attempts FROM background_jobs
        WHERE status = 'RUNNING' AND leased_until IS NOT NULL AND leased_until <= now()
        ORDER BY leased_until ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit],
    );
    let reclaimed = 0;
    let dead = 0;
    for (const j of picked.rows) {
      if (j.attempt_count >= j.max_attempts) {
        await client.query(
          `UPDATE background_jobs
              SET status = 'DEAD', failed_at = now(), leased_until = NULL, worker_id = NULL,
                  last_error_code = COALESCE(last_error_code, 'LEASE_EXPIRED'),
                  last_error_message = COALESCE(last_error_message, 'Lease expired after max attempts')
            WHERE id = $1`,
          [j.id],
        );
        dead += 1;
      } else {
        await client.query(
          `UPDATE background_jobs
              SET status = 'RETRY_WAIT', available_at = now(), leased_until = NULL, worker_id = NULL,
                  last_error_code = COALESCE(last_error_code, 'LEASE_EXPIRED')
            WHERE id = $1`,
          [j.id],
        );
        reclaimed += 1;
      }
    }
    return { reclaimed, dead };
  });
}

// ---- Diagnostics / retention ----

export async function getById(jobId: string): Promise<JobRow | null> {
  const rows = await query<JobRow>(`SELECT * FROM background_jobs WHERE id = $1`, [jobId]);
  return rows[0] ?? null;
}

export interface ListJobsFilter {
  status?: JobStatus;
  jobType?: JobType;
  limit: number;
  before?: { createdAt: string; id: string } | null;
}

export async function listJobs(f: ListJobsFilter): Promise<JobRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.status) {
    params.push(f.status);
    where.push(`status = $${params.length}`);
  }
  if (f.jobType) {
    params.push(f.jobType);
    where.push(`job_type = $${params.length}`);
  }
  if (f.before) {
    params.push(f.before.createdAt, f.before.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(f.limit);
  const limitParam = `$${params.length}`;
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return query<JobRow>(
    `SELECT * FROM background_jobs
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam}`,
    params,
  );
}

/** Count jobs grouped by status (metrics / diagnostics). */
export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM background_jobs GROUP BY status`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** Count jobs grouped by type (metrics / diagnostics). */
export async function countByType(): Promise<Record<string, number>> {
  const rows = await query<{ job_type: string; n: number }>(
    `SELECT job_type, count(*)::int AS n FROM background_jobs GROUP BY job_type`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.job_type] = r.n;
  return out;
}

/** Approximate claimable queue depth (for backpressure checks). */
export async function claimableDepth(): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM background_jobs
      WHERE status IN ('PENDING','RETRY_WAIT')`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * Queue pressure / starvation signals (Increment 10):
 *  - depth: claimable (PENDING/RETRY_WAIT) jobs
 *  - oldestPendingAgeSeconds: age of the oldest claimable job's available_at
 *  - staleRunning: RUNNING jobs whose lease has already expired
 *  - dead: DEAD jobs
 */
export async function queueStats(): Promise<{
  depth: number;
  oldestPendingAgeSeconds: number | null;
  staleRunning: number;
  dead: number;
}> {
  const rows = await query<{
    depth: number;
    oldest_age: number | null;
    stale_running: number;
    dead: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM background_jobs WHERE status IN ('PENDING','RETRY_WAIT')) AS depth,
       (SELECT EXTRACT(EPOCH FROM (now() - min(available_at)))::int
          FROM background_jobs WHERE status IN ('PENDING','RETRY_WAIT') AND available_at <= now()) AS oldest_age,
       (SELECT count(*)::int FROM background_jobs
          WHERE status = 'RUNNING' AND leased_until IS NOT NULL AND leased_until <= now()) AS stale_running,
       (SELECT count(*)::int FROM background_jobs WHERE status = 'DEAD') AS dead`,
  );
  const r = rows[0];
  return {
    depth: r?.depth ?? 0,
    oldestPendingAgeSeconds: r?.oldest_age ?? null,
    staleRunning: r?.stale_running ?? 0,
    dead: r?.dead ?? 0,
  };
}

/**
 * Requeue a DEAD job back to PENDING for a fresh attempt (admin operation).
 * Resets attempt_count to 0, clears lease/error/failed_at, and makes it
 * immediately available. Scoped to DEAD status so SUCCEEDED/RUNNING/active jobs
 * are never silently rerun. Returns the updated row, or null if the job was not
 * DEAD (or did not exist).
 */
export async function requeueDead(jobId: string): Promise<JobRow | null> {
  const rows = await query<JobRow>(
    `UPDATE background_jobs
        SET status = 'PENDING',
            attempt_count = 0,
            available_at = now(),
            leased_until = NULL,
            worker_id = NULL,
            failed_at = NULL,
            completed_at = NULL,
            last_error_code = NULL,
            last_error_message = NULL
      WHERE id = $1 AND status = 'DEAD'
      RETURNING *`,
    [jobId],
  );
  return rows[0] ?? null;
}

/** Delete terminal jobs older than the given cutoffs (retention). Uses the
 *  stable terminal timestamp (completed_at / failed_at) rather than updated_at,
 *  which the set_updated_at trigger bumps on every UPDATE. */
export async function deleteTerminalBefore(
  succeededCutoff: Date,
  deadCutoff: Date,
): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM background_jobs
      WHERE (status IN ('SUCCEEDED','CANCELLED')
             AND COALESCE(completed_at, updated_at) <= $1)
         OR (status = 'DEAD'
             AND COALESCE(failed_at, updated_at) <= $2)
      RETURNING id`,
    [succeededCutoff.toISOString(), deadCutoff.toISOString()],
  );
  return rows.length;
}
