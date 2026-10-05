import { z } from "zod";
import {
  ReportTargetType,
  ReportReasonCode,
  SafetyReportStatus,
  canTransitionReport,
  type SafetyReportView,
} from "@luvora/shared";
import { Errors } from "../http/errors";
import { query, withTransaction } from "../db/pool";
import * as reportRepo from "./reportRepository";
import * as users from "../users/userRepository";
import { audit } from "./auditService";
import { writeModerationAction } from "./auditRepository";

/**
 * Safety reporting. Users create private reports against supported targets;
 * moderators review and resolve them. Reporter identity is never exposed to a
 * reported user, and target existence is validated without leaking the
 * existence of private content the reporter cannot see.
 */

export const createReportSchema = z.object({
  reason: z.nativeEnum(ReportReasonCode),
  description: z.string().max(2000).optional(),
});

export const resolveReportSchema = z.object({
  status: z.enum([SafetyReportStatus.RESOLVED, SafetyReportStatus.DISMISSED]),
  resolution: z.string().max(2000).optional(),
});

/** Validate that the target exists and the reporter may reference it. Returns
 *  nothing; throws the appropriate error otherwise. */
async function validateTarget(
  reporterId: string,
  targetType: ReportTargetType,
  targetId: string,
): Promise<void> {
  switch (targetType) {
    case ReportTargetType.USER: {
      if (targetId === reporterId) throw Errors.cannotTargetSelf();
      const u = await users.findById(targetId);
      if (!u) throw Errors.invalidReportTarget();
      return;
    }
    case ReportTargetType.MEDIA: {
      // The reporter must be able to see the media (owner or an authorized
      // conversation participant), so reporting can't be used to probe for the
      // existence of private media. We reuse the media authorization rule.
      const rows = await query(
        `SELECT 1 FROM media_assets m
          WHERE m.id = $1 AND m.deleted_at IS NULL AND (
            m.owner_id = $2 OR EXISTS (
              SELECT 1 FROM message_attachments att
                JOIN messages msg ON msg.id = att.message_id
                JOIN conversations conv ON conv.id = msg.conversation_id
                JOIN matches mt ON mt.id = conv.match_id
               WHERE att.media_id = m.id
                 AND ($2 = mt.user_a OR $2 = mt.user_b)
            )
          ) LIMIT 1`,
        [targetId, reporterId],
      );
      if (rows.length === 0) throw Errors.invalidReportTarget();
      return;
    }
    case ReportTargetType.MESSAGE: {
      // Reporter must be a participant of the conversation the message is in.
      const rows = await query(
        `SELECT 1 FROM messages msg
            JOIN conversations conv ON conv.id = msg.conversation_id
            JOIN matches mt ON mt.id = conv.match_id
           WHERE msg.id = $1 AND ($2 = mt.user_a OR $2 = mt.user_b) LIMIT 1`,
        [targetId, reporterId],
      );
      if (rows.length === 0) throw Errors.invalidReportTarget();
      return;
    }
    case ReportTargetType.SESSION: {
      const rows = await query(
        `SELECT 1 FROM fantasy_sessions s
           WHERE s.id = $1 AND ($2 = s.initiator_id OR $2 = s.invitee_id) LIMIT 1`,
        [targetId, reporterId],
      );
      if (rows.length === 0) throw Errors.invalidReportTarget();
      return;
    }
  }
}

export async function createReport(input: {
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReasonCode;
  description?: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ reportId: string | null; duplicate: boolean }> {
  await validateTarget(input.reporterId, input.targetType, input.targetId);

  const { created, row } = await reportRepo.createReport({
    reporterUserId: input.reporterId,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason,
    description: input.description ?? null,
  });

  if (!created) {
    // An open/in-review report by this reporter against this target already
    // exists — deterministic, non-leaky.
    throw Errors.duplicateReport();
  }

  // Audit the report creation. Reporter identity stays in the private audit log
  // / report record; it is never surfaced to the reported user.
  await audit({
    actorUserId: input.reporterId,
    action: "report.created",
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: { reason: input.reason, reportId: row!.id },
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return { reportId: row!.id, duplicate: false };
}

// ---- Moderator/admin review ----

export async function getReport(id: string): Promise<SafetyReportView> {
  const row = await reportRepo.getById(id);
  if (!row) throw Errors.reportNotFound();
  return reportRepo.toView(row);
}

export async function assignReport(
  moderatorId: string,
  reportId: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<SafetyReportView> {
  return withTransaction(async (client) => {
    const row = await reportRepo.lockById(client, reportId);
    if (!row) throw Errors.reportNotFound();
    if (!canTransitionReport(row.status as SafetyReportStatus, SafetyReportStatus.IN_REVIEW)) {
      throw Errors.reportInvalidTransition();
    }
    await reportRepo.assignReport(client, reportId, moderatorId);
    await writeModerationAction(
      { actorUserId: moderatorId, action: "report.assigned", targetType: "REPORT", targetId: reportId },
      client,
    );
    await audit(
      {
        actorUserId: moderatorId,
        action: "report.assigned",
        targetType: "REPORT",
        targetId: reportId,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      },
      client,
    );
    const updated = await reportRepo.lockById(client, reportId);
    return reportRepo.toView(updated!);
  });
}

export async function resolveReport(input: {
  moderatorId: string;
  reportId: string;
  status: SafetyReportStatus;
  resolution?: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SafetyReportView> {
  return withTransaction(async (client) => {
    const row = await reportRepo.lockById(client, input.reportId);
    if (!row) throw Errors.reportNotFound();
    if (!canTransitionReport(row.status as SafetyReportStatus, input.status)) {
      throw Errors.reportInvalidTransition();
    }
    await reportRepo.resolveReport(client, {
      id: input.reportId,
      status: input.status,
      resolution: input.resolution ?? null,
      resolvedBy: input.moderatorId,
    });
    await writeModerationAction(
      {
        actorUserId: input.moderatorId,
        action: `report.${input.status.toLowerCase()}`,
        targetType: "REPORT",
        targetId: input.reportId,
        reason: input.resolution ?? null,
      },
      client,
    );
    await audit(
      {
        actorUserId: input.moderatorId,
        action: `report.${input.status.toLowerCase()}`,
        targetType: "REPORT",
        targetId: input.reportId,
        metadata: { status: input.status },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
      client,
    );
    const updated = await reportRepo.lockById(client, input.reportId);
    return reportRepo.toView(updated!);
  });
}
