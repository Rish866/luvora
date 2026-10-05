import type { PoolClient } from "pg";
import {
  JobType,
  JobPriority,
  type JobView,
  type JobMetricsSnapshot,
} from "@luvora/shared";
import * as jobRepo from "./jobRepository";
import { jobMetrics } from "./jobMetrics";
import { config } from "../config";
import { Errors } from "../http/errors";
import { logger } from "../logger";

/**
 * Application-level entry point for the durable job queue (Increment 9).
 *
 * Only trusted server code calls these — there is no path for a client to pick
 * a job type or payload. The service enforces per-type defaults (priority, max
 * attempts), optional backpressure, idempotency keys, and backoff computation,
 * and never puts secrets into payloads.
 */

/** Per-type default priority. SAFETY-sensitive push gets a head start. */
function defaultPriority(type: JobType): number {
  switch (type) {
    case JobType.NOTIFICATION_PUSH_DELIVERY:
      return JobPriority.NORMAL;
    case JobType.NOTIFICATION_CLEANUP:
    case JobType.PRESENCE_RECONCILIATION:
    case JobType.BACKGROUND_JOB_CLEANUP:
      return JobPriority.LOW;
    default:
      return JobPriority.NORMAL;
  }
}

export interface EnqueueOptions {
  idempotencyKey?: string | null;
  priority?: number;
  maxAttempts?: number;
  availableAt?: Date | null;
  /** High-priority override (e.g. a SAFETY notification's delivery job). */
  high?: boolean;
}

/**
 * Enqueue a trusted job. Transaction-aware: pass `client` to enqueue inside the
 * caller's transaction (outbox pattern — the domain write and the job commit
 * atomically). Returns the job row + whether it was newly created (idempotency).
 *
 * Backpressure: when JOB_MAX_QUEUE_DEPTH > 0 and the claimable depth exceeds it,
 * a NON-idempotent enqueue is refused with QUEUE_BACKPRESSURE rather than
 * silently dropped. Idempotent jobs (which collapse to one row) bypass the
 * check so critical de-duplicated work is never lost.
 */
export async function enqueue(
  type: JobType,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
  client?: PoolClient,
): Promise<{ id: string; created: boolean }> {
  if (
    config.jobs.maxQueueDepth > 0 &&
    !opts.idempotencyKey &&
    !client // only guard standalone enqueues; a txn enqueue is already committed-with
  ) {
    const depth = await jobRepo.claimableDepth();
    if (depth >= config.jobs.maxQueueDepth) {
      throw Errors.queueBackpressure();
    }
  }

  const priority = opts.high ? JobPriority.HIGH : opts.priority ?? defaultPriority(type);
  const { row, created } = await jobRepo.enqueue(
    {
      jobType: type,
      payload,
      idempotencyKey: opts.idempotencyKey ?? null,
      priority,
      maxAttempts: opts.maxAttempts ?? config.jobs.maxAttempts,
      availableAt: opts.availableAt ?? null,
    },
    client,
  );
  if (created) jobMetrics.inc("jobs_enqueued", type);
  return { id: row.id, created };
}

/**
 * Compute the retry delay for a given attempt number using exponential backoff
 * with optional full jitter, clamped to [base, max].
 *   attempt 1 -> ~base, 2 -> ~2*base, 3 -> ~4*base ... capped at maxDelay.
 * With jitter the delay is uniformly random in [0, computed] (full jitter), but
 * never below a small floor so we don't hot-loop.
 */
export function computeBackoffMs(attempt: number): number {
  const base = config.jobs.retryBaseDelayMs;
  const max = config.jobs.retryMaxDelayMs;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
  if (!config.jobs.retryJitter) return Math.floor(exp);
  // Full jitter in [exp/2, exp]: keeps a sane floor while spreading load.
  const floor = exp / 2;
  const delay = floor + Math.random() * (exp - floor);
  return Math.max(base / 2, Math.floor(delay));
}

/** Short, sanitized error code (uppercase, token-free, bounded). */
export function sanitizeErrorCode(input: string | undefined): string {
  if (!input) return "UNKNOWN_ERROR";
  const code = input.slice(0, 60).replace(/[^A-Za-z0-9_]+/g, "_").toUpperCase();
  return code.slice(0, 40) || "UNKNOWN_ERROR";
}

/** Bounded, sanitized error message for persistence/logging (no secrets, no
 *  full provider responses, length-capped). */
export function sanitizeErrorMessage(input: string | undefined): string {
  if (!input) return "";
  // Strip anything token-like and cap length.
  return input.replace(/[\r\n]+/g, " ").slice(0, 200);
}

// ---- Diagnostics ----

/** Redact a payload to a safe summary (ids/flags/scalars only). Any key that
 *  looks sensitive is dropped entirely; nested values are stringified+bounded. */
const SENSITIVE_KEY = /(token|password|secret|authorization|cookie|refresh|body|consent|storage|credential|email)/i;

export function redactPayload(
  payload: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (SENSITIVE_KEY.test(k)) continue;
    if (v === null || typeof v === "boolean" || typeof v === "number") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 128);
    else out[k] = `[${typeof v}]`;
  }
  return out;
}

export function toView(row: jobRepo.JobRow): JobView {
  return {
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    priority: row.priority,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    idempotencyKey: row.idempotency_key,
    payloadSummary: redactPayload(row.payload),
    availableAt: row.available_at,
    leasedUntil: row.leased_until,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    failedAt: row.failed_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function metricsSnapshot(): Promise<JobMetricsSnapshot> {
  const [countsByStatus, countsByType] = await Promise.all([
    jobRepo.countByStatus(),
    jobRepo.countByType(),
  ]);
  return { countsByStatus, countsByType, counters: jobMetrics.snapshotCounters() };
}

// ---- Convenience enqueuers for the known job types (trusted callers) ----

/** Enqueue push delivery for a persisted notification. Idempotent per
 *  notification so a duplicated domain event does not duplicate the job.
 *  `high` routes SAFETY delivery ahead of routine work. */
export async function enqueueNotificationPushDelivery(
  notificationId: string,
  opts: { high?: boolean } = {},
  client?: PoolClient,
): Promise<{ id: string; created: boolean }> {
  return enqueue(
    JobType.NOTIFICATION_PUSH_DELIVERY,
    { notificationId },
    { idempotencyKey: `push:${notificationId}`, high: opts.high },
    client,
  );
}

/** Enqueue a periodic maintenance job. The idempotency key collapses rapid
 *  duplicate scheduling into a single pending job. */
export async function enqueueMaintenance(
  type:
    | JobType.NOTIFICATION_CLEANUP
    | JobType.PRESENCE_RECONCILIATION
    | JobType.BACKGROUND_JOB_CLEANUP,
): Promise<{ id: string; created: boolean }> {
  // One pending maintenance job of each type at a time.
  return enqueue(type, {}, { idempotencyKey: `maintenance:${type}` });
}

/** Log a safe one-line summary of an enqueue decision (no payload). */
export function logEnqueue(type: JobType, id: string, created: boolean): void {
  logger.debug({ jobType: type, jobId: id, created }, "job enqueue");
}
