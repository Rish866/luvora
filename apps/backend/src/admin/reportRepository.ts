import { query } from "../db/pool";
import type { PoolClient } from "pg";
import {
  ReportTargetType,
  type SafetyReportView,
} from "@luvora/shared";

/** Data access for the unified safety-report system. Parameterized SQL only. */

export interface SafetyReportRow {
  id: string;
  reporter_user_id: string;
  target_type: ReportTargetType;
  target_user_id: string | null;
  target_media_id: string | null;
  target_message_id: string | null;
  target_session_id: string | null;
  reason: string;
  description: string | null;
  status: string;
  priority: string;
  assigned_to: string | null;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

function targetId(row: SafetyReportRow): string {
  return (
    row.target_user_id ??
    row.target_media_id ??
    row.target_message_id ??
    row.target_session_id ??
    ""
  );
}

export function toView(row: SafetyReportRow): SafetyReportView {
  return {
    id: row.id,
    reporterUserId: row.reporter_user_id,
    targetType: row.target_type,
    targetId: targetId(row),
    reason: row.reason as SafetyReportView["reason"],
    description: row.description,
    status: row.status as SafetyReportView["status"],
    priority: row.priority as SafetyReportView["priority"],
    assignedTo: row.assigned_to,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

/** The column that holds the typed target for a given target type. */
function targetColumn(type: ReportTargetType): string {
  switch (type) {
    case ReportTargetType.USER:
      return "target_user_id";
    case ReportTargetType.MEDIA:
      return "target_media_id";
    case ReportTargetType.MESSAGE:
      return "target_message_id";
    case ReportTargetType.SESSION:
      return "target_session_id";
  }
}

export async function createReport(input: {
  reporterUserId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  description: string | null;
}): Promise<{ created: boolean; row: SafetyReportRow | null }> {
  // The target column is chosen from a fixed allow-list (never interpolated
  // from user input), so this is injection-safe.
  const col = targetColumn(input.targetType);
  const rows = await query<SafetyReportRow>(
    `INSERT INTO safety_reports (reporter_user_id, target_type, ${col}, reason, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [input.reporterUserId, input.targetType, input.targetId, input.reason, input.description],
  );
  return { created: rows.length > 0, row: rows[0] ?? null };
}

export async function getById(id: string): Promise<SafetyReportRow | null> {
  const rows = await query<SafetyReportRow>(
    `SELECT * FROM safety_reports WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Lock a report row within a transaction. */
export async function lockById(
  client: PoolClient,
  id: string,
): Promise<SafetyReportRow | null> {
  const { rows } = await client.query<SafetyReportRow>(
    `SELECT * FROM safety_reports WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ?? null;
}

export interface ReportFilter {
  status?: string;
  priority?: string;
  targetType?: string;
  assignedTo?: string;
  limit: number;
  before: { createdAt: string; id: string } | null;
}

export async function listReports(filter: ReportFilter): Promise<{
  rows: SafetyReportRow[];
  nextCursor: { createdAt: string; id: string } | null;
}> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };
  if (filter.status) add("status = $?", filter.status);
  if (filter.priority) add("priority = $?", filter.priority);
  if (filter.targetType) add("target_type = $?", filter.targetType);
  if (filter.assignedTo) add("assigned_to = $?", filter.assignedTo);
  if (filter.before) {
    params.push(filter.before.createdAt, filter.before.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(filter.limit);
  const limitParam = `$${params.length}`;
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await query<SafetyReportRow & { cursor_created_at: string }>(
    `SELECT *, created_at::text AS cursor_created_at
       FROM safety_reports
       ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam}`,
    params,
  );
  const nextCursor =
    rows.length === filter.limit
      ? {
          createdAt: (rows[rows.length - 1] as SafetyReportRow & { cursor_created_at: string }).cursor_created_at,
          id: rows[rows.length - 1].id,
        }
      : null;
  return { rows, nextCursor };
}

export async function assignReport(
  client: PoolClient,
  id: string,
  moderatorId: string,
): Promise<void> {
  await client.query(
    `UPDATE safety_reports SET status = 'IN_REVIEW', assigned_to = $2 WHERE id = $1`,
    [id, moderatorId],
  );
}

export async function resolveReport(
  client: PoolClient,
  input: { id: string; status: string; resolution: string | null; resolvedBy: string },
): Promise<void> {
  await client.query(
    `UPDATE safety_reports
        SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now()
      WHERE id = $1`,
    [input.id, input.status, input.resolution, input.resolvedBy],
  );
}
