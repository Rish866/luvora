import type { PoolClient } from "pg";
import * as auditRepo from "./auditRepository";

/**
 * Audit helpers with mandatory metadata sanitization.
 *
 * Any key whose name hints at a secret or sensitive content is stripped before
 * an audit record is written, so tokens / passwords / message bodies / raw
 * bytes can never leak into the audit log even if a caller passes them by
 * mistake. Values are also size-bounded.
 */
const FORBIDDEN_KEY = /(password|token|secret|authorization|cookie|refresh|body|bytes|content|exif|storage_?key|email)/i;
const MAX_VALUE_LEN = 500;

export function sanitizeMetadata(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEY.test(key)) continue; // drop sensitive keys entirely
    if (value === null || value === undefined) {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value.length > MAX_VALUE_LEN ? value.slice(0, MAX_VALUE_LEN) : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else {
      // Reject nested objects/arrays to keep metadata flat + safe.
      out[key] = String(value).slice(0, MAX_VALUE_LEN);
    }
  }
  return out;
}

export interface AuditContext {
  actorUserId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export async function audit(ctx: AuditContext, client?: PoolClient): Promise<void> {
  await auditRepo.writeAudit(
    {
      actorUserId: ctx.actorUserId,
      action: ctx.action,
      targetType: ctx.targetType ?? null,
      targetId: ctx.targetId ?? null,
      metadata: sanitizeMetadata(ctx.metadata),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    },
    client,
  );
}
