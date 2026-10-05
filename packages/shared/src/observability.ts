/**
 * Observability & operational shared types (Increment 10).
 *
 * These are durable OPERATIONAL/security events + readiness/health contracts
 * shared between the backend and (admin) clients. High-frequency telemetry
 * (per-request counters/histograms) lives in-process and is NOT represented
 * here — only significant, persistable operational state is.
 */

/** Severity of an operational event (CHECK-constrained in the DB). */
export enum OperationalSeverity {
  INFO = "INFO",
  WARNING = "WARNING",
  ERROR = "ERROR",
  CRITICAL = "CRITICAL",
}

/** Well-known operational event types. Bounded set — never free-form from a
 *  client. Used for worker lifecycle, admin operational actions, and
 *  threshold/circuit signals. */
export enum OperationalEventType {
  WORKER_STARTED = "WORKER_STARTED",
  WORKER_STOPPED = "WORKER_STOPPED",
  WORKER_UNHEALTHY = "WORKER_UNHEALTHY",
  JOB_MANUALLY_REQUEUED = "JOB_MANUALLY_REQUEUED",
  JOB_CANCELLED = "JOB_CANCELLED",
  OPERATIONAL_THRESHOLD_TRIGGERED = "OPERATIONAL_THRESHOLD_TRIGGERED",
  DATABASE_DEGRADED = "DATABASE_DEGRADED",
  QUEUE_BACKLOG = "QUEUE_BACKLOG",
}

/** Safe, admin-facing operational event DTO. Metadata is sanitized before
 *  persistence; it never contains tokens/bodies/credentials/payloads. */
export interface OperationalEventView {
  id: string;
  eventType: OperationalEventType | string;
  severity: OperationalSeverity | string;
  actorUserId: string | null;
  correlationId: string | null;
  jobId: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

/** Per-dependency readiness status. */
export type ReadinessCheck = "ok" | "degraded" | "disabled" | "error";

/** Structured readiness response payload (never leaks connection strings etc.). */
export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: Record<string, ReadinessCheck>;
}

/** Safe liveness payload. */
export interface HealthReport {
  status: "ok";
  uptimeSeconds: number;
}

/** Safe DB health snapshot (no credentials/connection string). */
export interface DbHealth {
  reachable: boolean;
  poolTotal: number;
  poolIdle: number;
  poolWaiting: number;
  /** 0..1 utilization = (total - idle) / max. */
  utilization: number;
}
