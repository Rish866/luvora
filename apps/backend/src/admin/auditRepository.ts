import { query } from "../db/pool";
import type { PoolClient } from "pg";
import type { AuditLogView, ModerationActionView } from "@luvora/shared";

/**
 * Append-only audit + moderation-action logging. There is deliberately NO
 * update or delete path exposed anywhere in the application.
 *
 * Metadata is sanitized by callers (see auditService.sanitizeMetadata): never
 * tokens, passwords, raw auth headers, message bodies, or binary data.
 */

export interface WriteAuditInput {
  actorUserId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Insert an audit record. Accepts an optional client so it participates in a
 *  surrounding transaction (so a safety action + its audit commit atomically). */
export async function writeAudit(
  input: WriteAuditInput,
  client?: PoolClient,
): Promise<void> {
  const sql = `INSERT INTO audit_logs
       (actor_user_id, action, target_type, target_id, metadata, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`;
  const params = [
    input.actorUserId,
    input.action,
    input.targetType ?? null,
    input.targetId ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.ip ?? null,
    input.userAgent ?? null,
  ];
  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }
}

export interface WriteModerationActionInput {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string | null;
  reportId?: string | null;
}

export async function writeModerationAction(
  input: WriteModerationActionInput,
  client?: PoolClient,
): Promise<void> {
  const sql = `INSERT INTO moderation_actions
       (actor_user_id, action, target_type, target_id, reason, report_id)
     VALUES ($1, $2, $3, $4, $5, $6)`;
  const params = [
    input.actorUserId,
    input.action,
    input.targetType,
    input.targetId,
    input.reason ?? null,
    input.reportId ?? null,
  ];
  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }
}

// ---- Read access (admin-only, keyset-paginated) ----

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  cursor_created_at: string;
}

export interface AuditFilter {
  actorUserId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  limit: number;
  before: { createdAt: string; id: string } | null;
}

export async function listAudit(filter: AuditFilter): Promise<{
  rows: AuditLogView[];
  nextCursor: { createdAt: string; id: string } | null;
}> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };
  if (filter.actorUserId) add("actor_user_id = $?", filter.actorUserId);
  if (filter.action) add("action = $?", filter.action);
  if (filter.targetType) add("target_type = $?", filter.targetType);
  if (filter.targetId) add("target_id = $?", filter.targetId);
  if (filter.before) {
    params.push(filter.before.createdAt, filter.before.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(filter.limit);
  const limitParam = `$${params.length}`;
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await query<AuditRow>(
    `SELECT id, actor_user_id, action, target_type, target_id, metadata,
            created_at, created_at::text AS cursor_created_at
       FROM audit_logs
       ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam}`,
    params,
  );

  const views: AuditLogView[] = rows.map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
  }));
  const nextCursor =
    rows.length === filter.limit
      ? { createdAt: rows[rows.length - 1].cursor_created_at, id: rows[rows.length - 1].id }
      : null;
  return { rows: views, nextCursor };
}

interface ModActionRow {
  id: string;
  actor_user_id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  report_id: string | null;
  created_at: string;
}

export async function listModerationActionsForTarget(
  targetType: string,
  targetId: string,
): Promise<ModerationActionView[]> {
  const rows = await query<ModActionRow>(
    `SELECT * FROM moderation_actions
      WHERE target_type = $1 AND target_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    [targetType, targetId],
  );
  return rows.map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    reason: r.reason,
    reportId: r.report_id,
    createdAt: r.created_at,
  }));
}
