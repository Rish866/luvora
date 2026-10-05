import crypto from "node:crypto";
import { query } from "../db/pool";
import { config } from "../config";
import {
  SecuritySeverity,
  SECURITY_EVENT_RETENTION_DAYS,
  type SecurityEventType,
  type SecurityEventView,
} from "@luvora/shared";
import { currentContext } from "../observability/requestContext";
import { metrics } from "../observability/metrics";
import { log } from "../observability/logger";

/**
 * Durable security-event recording (Increment 11). Best-effort: never throws
 * into the caller — a telemetry write must not break a security-sensitive
 * request. Low-volume + significant events only (high-frequency abuse counters
 * live in the AbuseGuard). Metadata is sanitized; the client source is stored
 * only as a salted, truncated fingerprint — never the raw IP.
 */

// Per-deployment salt derived from a secret already in config (never logged,
// never leaves the process). Makes the IP fingerprint non-reversible across
// deployments and resistant to precomputation.
const FINGERPRINT_SALT = crypto
  .createHash("sha256")
  .update("luvora-secfp:" + config.jwt.accessSecret)
  .digest("hex");

/** Non-reversible, truncated fingerprint of a client source (e.g. IP). Returns
 *  null for an empty/unknown source so we never store a placeholder. */
export function sourceFingerprint(source: string | undefined | null): string | null {
  if (!source || source === "unknown") return null;
  return crypto
    .createHash("sha256")
    .update(FINGERPRINT_SALT + ":" + source)
    .digest("hex")
    .slice(0, 16);
}

const FORBIDDEN_KEY = /(password|token|secret|authorization|cookie|refresh|body|consent|storage|credential|email|ip)/i;
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

export interface RecordSecurityEventInput {
  eventType: SecurityEventType | string;
  severity?: SecuritySeverity;
  userId?: string | null;
  category?: string | null;
  /** Raw client source (IP). Hashed to a fingerprint before persistence. */
  source?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordSecurityEvent(input: RecordSecurityEventInput): Promise<void> {
  // Count every security event (bounded labels: type + severity).
  try {
    metrics.incr("security_events_total", {
      event_type: String(input.eventType).slice(0, 60),
      severity: String(input.severity ?? SecuritySeverity.INFO),
    });
  } catch {
    /* best-effort */
  }
  try {
    const correlationId = input.correlationId ?? currentContext()?.correlationId ?? null;
    await query(
      `INSERT INTO security_events
         (user_id, event_type, severity, category, source_fingerprint, correlation_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        input.userId ?? null,
        String(input.eventType).slice(0, 60),
        input.severity ?? SecuritySeverity.INFO,
        input.category ?? null,
        sourceFingerprint(input.source),
        correlationId,
        JSON.stringify(sanitizeMetadata(input.metadata)),
      ],
    );
  } catch (err) {
    log.warn(
      { eventType: String(input.eventType), err: (err as Error)?.message },
      "security event persist failed (ignored)",
    );
  }
}

function toView(row: {
  id: string;
  user_id: string | null;
  event_type: string;
  severity: string;
  category: string | null;
  source_fingerprint: string | null;
  correlation_id: string | null;
  metadata: Record<string, string | number | boolean | null> | null;
  created_at: string;
}): SecurityEventView {
  return {
    id: row.id,
    userId: row.user_id,
    eventType: row.event_type,
    severity: row.severity,
    category: row.category,
    sourceFingerprint: row.source_fingerprint,
    correlationId: row.correlation_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

export interface ListSecurityEventsFilter {
  eventType?: string;
  category?: string;
  severity?: string;
  limit: number;
  before?: { createdAt: string; id: string } | null;
}

export async function listSecurityEvents(f: ListSecurityEventsFilter): Promise<{
  events: SecurityEventView[];
  nextCursor: { createdAt: string; id: string } | null;
}> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (f.eventType) {
    params.push(f.eventType);
    where.push(`event_type = $${params.length}`);
  }
  if (f.category) {
    params.push(f.category);
    where.push(`category = $${params.length}`);
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
    user_id: string | null;
    event_type: string;
    severity: string;
    category: string | null;
    source_fingerprint: string | null;
    correlation_id: string | null;
    metadata: Record<string, string | number | boolean | null> | null;
    created_at: string;
    cursor_created_at: string;
  }>(
    `SELECT *, created_at::text AS cursor_created_at
       FROM security_events
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

/** Delete security events older than the retention window. Returns rows removed.
 *  A SEPARATE policy from audit logs, which are never deleted here. */
export async function cleanupSecurityEvents(
  retentionDays = SECURITY_EVENT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
  const rows = await query<{ id: string }>(
    `DELETE FROM security_events WHERE created_at <= $1 RETURNING id`,
    [cutoff.toISOString()],
  );
  return rows.length;
}
