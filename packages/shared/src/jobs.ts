/**
 * Background job + worker shared types (Increment 9).
 *
 * Luvora runs a durable, PostgreSQL-backed job queue (no Redis/BullMQ/etc.).
 * Jobs are the SOURCE OF TRUTH in the `background_jobs` table; a worker leases
 * and executes them with at-least-once semantics. Handlers MUST be idempotent.
 *
 * These contracts are shared so the worker, the API, and (admin) diagnostics
 * agree on job types and statuses. Internal job PAYLOADS are never exposed
 * through normal user APIs — admin diagnostics return a redacted summary only.
 */

/** Durable job types. Only trusted server code enqueues these; a client can
 *  never choose a job type or payload. */
export enum JobType {
  /** Deliver a persisted notification to the recipient's push devices. Payload:
   *  { notificationId }. The handler reuses the Increment 8 delivery pipeline. */
  NOTIFICATION_PUSH_DELIVERY = "NOTIFICATION_PUSH_DELIVERY",
  /** Periodic: delete expired non-critical notifications + prune delivery
   *  records / long-revoked devices (safe retention). */
  NOTIFICATION_CLEANUP = "NOTIFICATION_CLEANUP",
  /** Periodic: reconcile presence TTLs (reap stale connections a crashed
   *  process never cleaned up) without falsely marking an active user offline. */
  PRESENCE_RECONCILIATION = "PRESENCE_RECONCILIATION",
  /** Periodic: prune old terminal jobs from the queue per retention policy. */
  BACKGROUND_JOB_CLEANUP = "BACKGROUND_JOB_CLEANUP",
}

/** Explicit job status machine (CHECK-constrained in the DB). */
export enum JobStatus {
  /** Enqueued and available at/after `availableAt`. */
  PENDING = "PENDING",
  /** Claimed by a worker and currently executing (holds a lease). */
  RUNNING = "RUNNING",
  /** A retryable failure occurred; waiting for the next attempt time. */
  RETRY_WAIT = "RETRY_WAIT",
  /** Completed successfully. */
  SUCCEEDED = "SUCCEEDED",
  /** Permanently failed (max attempts exhausted or a permanent error). */
  DEAD = "DEAD",
  /** Cancelled by trusted server code before completion. */
  CANCELLED = "CANCELLED",
}

/** Terminal statuses — a job in one of these is never claimed again. */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  JobStatus.SUCCEEDED,
  JobStatus.DEAD,
  JobStatus.CANCELLED,
]);

/** Default priorities (lower number = higher priority; worker claims ascending).
 *  SAFETY-related delivery is given a head start over routine work. */
export enum JobPriority {
  HIGH = 10,
  NORMAL = 100,
  LOW = 500,
}

/** How a handler asks the worker to treat a failure. */
export enum JobFailureKind {
  /** Do not retry (e.g. invalid input). Dead-letter immediately. */
  PERMANENT = "PERMANENT",
  /** Retry with backoff up to max attempts (e.g. provider unavailable). */
  TEMPORARY = "TEMPORARY",
}

/**
 * Safe, admin-facing job DTO. NEVER includes the raw payload — only a redacted
 * summary (safe scalar fields) so diagnostics can't leak secrets.
 */
export interface JobView {
  id: string;
  jobType: JobType;
  status: JobStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  idempotencyKey: string | null;
  /** Redacted payload summary — safe keys only (ids/flags), never secrets. */
  payloadSummary: Record<string, string | number | boolean | null>;
  availableAt: string;
  leasedUntil: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  failedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Lightweight queue metrics snapshot (counts per status/type + totals). */
export interface JobMetricsSnapshot {
  countsByStatus: Record<string, number>;
  countsByType: Record<string, number>;
  counters: Record<string, number>;
}

/** Worker health, exposed only to admins (never unauthenticated). */
export interface WorkerHealth {
  workerId: string;
  running: boolean;
  stopping: boolean;
  concurrency: number;
  activeJobs: number;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
}
