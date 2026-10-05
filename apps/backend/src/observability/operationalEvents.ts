import { query } from "../db/pool";
import { config } from "../config";
import {
  OperationalSeverity,
  type OperationalEventType,
  type OperationalEventView,
} from "@luvora/shared";
import { currentContext } from "./requestContext";
import { log } from "./logger";

/**
 * Durable operational/security events (Increment 10).
 *
 * Low-volume, significant events only (worker lifecycle, admin operational
 * actions, threshold/circuit signals). Persistence is BEST-EFFORT by default:
 * a failed insert logs a sanitized warning and continues — a telemetry write
 * must never break application flow. Metadata is sanitized (flat, safe scalars;
 * sensitive keys dropped) before persistence.
 */

const FORBIDDEN_KEY = /(token|password|secret|authorization|cookie|refresh|body|consent|storage|credential|email|payload)/i;
const MAX_VALUE_LEN = 300;
const MAX_KEYS = 25;

export function sanitizeMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!input) return out;
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (n >= MAX_KEYS) break;
    if (FORBIDDEN_KEY.test(k)) continue;
    if (v === null) out[k] = null;
    else if (typeof v === "boolean" || typeof v === "number") out[k] = v;
    else if (typeof v === "string") out[k] = v.replace(/[\r\n]+/g, " ").slice(0, MAX_VALUE_LEN);
    else out[k] = String(v).slice(0, MAX_VALUE_LEN);
    n += 1;
  }
  return out;
}

export interface RecordEventInput {
  eventType: OperationalEventType | string;
  severity?: OperationalSeverity;
  actorUserId?: string | null;
  correlationId?: string | null;
  jobId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Record an operational event. Best-effort: never throws. The correlation id
 * defaults to the current request context's id when not supplied.
 */
export async function recordOperationalEvent(input: RecordEventInput): Promise<void> {
  try {
    const correlationId =
      input.correlationId ?? currentContext()?.correlationId ?? null;
    const severity = input.severity ?? OperationalSeverity.INFO;
    const metadata = sanitizeMetadata(input.metadata);
    await query(
      `INSERT INTO operational_events
         (event_type, severity, actor_user_id, correlation_id, job_id, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        String(input.eventType).slice(0, 100),
        severity,
        input.actorUserId ?? null,
        correlationId,
        input.jobId ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        JSON.stringify(metadata),
      ],
    );
  } catch (err) {
    log.warn(
      { eventType: String(input.eventType), err: (err as Error)?.message },
      "operational event persist failed (ignored)",
    );
  }
}

function toView(row: {
  id: string;
  event_type: string;
  severity: string;
  actor_user_id: string | null;
  correlation_id: string | null;
  job_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, string | number | boolean | null> | null;
  created_at: string;
}): OperationalEventView {
  return {
    id: row.id,
    eventType: row.event_type,
    severity: row.severity,
    actorUserId: row.actor_user_id,
    correlationId: row.correlation_id,
    jobId: row.job_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

export interface ListEventsFilter {
  eventType?: string;
  severity?: string;
  limit: number;
  before?: { createdAt: string; id: string } | null;
}

export async function listOperationalEvents(
  f: ListEventsFilter,
): Promise<{ events: OperationalEventView[]; nextCursor: { createdAt: string; id: string } | null }> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.eventType) {
    params.push(f.eventType);
    where.push(`event_type = $${params.length}`);
  }
  if (f.severity) {
    params.push(f.severity);
    where.push(`severity = $${params.length}`);
  }
  if (f.before) {
    params.push(f.before.createdAt, f.before.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(f.limit);
  const limitParam = `$${params.length}`;
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await query<{
    id: string;
    event_type: string;
    severity: string;
    actor_user_id: string | null;
    correlation_id: string | null;
    job_id: string | null;
    entity_type: string | null;
    entity_id: string | null;
    metadata: Record<string, string | number | boolean | null> | null;
    created_at: string;
    cursor_created_at: string;
  }>(
    `SELECT *, created_at::text AS cursor_created_at
       FROM operational_events
       ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam}`,
    params,
  );
  const events = rows.map(toView);
  const nextCursor =
    rows.length === f.limit
      ? { createdAt: rows[rows.length - 1].cursor_created_at, id: rows[rows.length - 1].id }
      : null;
  return { events, nextCursor };
}

/** Delete operational events older than the configured retention. Audit logs
 *  are a SEPARATE policy and are never touched here. Returns rows removed. */
export async function cleanupOperationalEvents(
  retentionDays = config.observability.operationalEventRetentionDays,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
  const rows = await query<{ id: string }>(
    `DELETE FROM operational_events WHERE created_at <= $1 RETURNING id`,
    [cutoff.toISOString()],
  );
  return rows.length;
}
