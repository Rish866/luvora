/**
 * Admin / safety / moderation shared types (Increment 6).
 *
 * Roles and account state are SERVER-CONTROLLED. The client can never set its
 * own role or account status; these types describe the contract only.
 */

export enum UserRole {
  USER = "USER",
  MODERATOR = "MODERATOR",
  ADMIN = "ADMIN",
}

/** Role hierarchy for `requireRole` checks (higher includes lower). */
export const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.USER]: 0,
  [UserRole.MODERATOR]: 1,
  [UserRole.ADMIN]: 2,
};

export enum AccountStatus {
  ACTIVE = "ACTIVE",
  SUSPENDED = "SUSPENDED",
  DEACTIVATED = "DEACTIVATED",
}

/** Report target types supported by the unified safety-report system. */
export enum ReportTargetType {
  USER = "USER",
  MEDIA = "MEDIA",
  MESSAGE = "MESSAGE",
  SESSION = "SESSION",
}

/** Controlled report reasons. */
export enum ReportReasonCode {
  CSAM = "CSAM",
  NONCONSENSUAL = "NONCONSENSUAL",
  VIOLENCE = "VIOLENCE",
  HARASSMENT = "HARASSMENT",
  SPAM = "SPAM",
  HATE = "HATE",
  SELF_HARM = "SELF_HARM",
  OTHER = "OTHER",
}

export enum SafetyReportStatus {
  OPEN = "OPEN",
  IN_REVIEW = "IN_REVIEW",
  RESOLVED = "RESOLVED",
  DISMISSED = "DISMISSED",
}

export enum ReportPriority {
  LOW = "LOW",
  NORMAL = "NORMAL",
  HIGH = "HIGH",
  URGENT = "URGENT",
}

/** Allowed safety-report state transitions (server-enforced). */
export const REPORT_TRANSITIONS: Record<SafetyReportStatus, SafetyReportStatus[]> = {
  [SafetyReportStatus.OPEN]: [
    SafetyReportStatus.IN_REVIEW,
    SafetyReportStatus.RESOLVED,
    SafetyReportStatus.DISMISSED,
  ],
  [SafetyReportStatus.IN_REVIEW]: [
    SafetyReportStatus.RESOLVED,
    SafetyReportStatus.DISMISSED,
  ],
  // Terminal.
  [SafetyReportStatus.RESOLVED]: [],
  [SafetyReportStatus.DISMISSED]: [],
};

export function canTransitionReport(
  from: SafetyReportStatus,
  to: SafetyReportStatus,
): boolean {
  return REPORT_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Allowed moderation-status transitions for media (admin/moderator-driven).
 * Mirrors the Increment 5 MediaModerationStatus values.
 */
export const MEDIA_MODERATION_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["APPROVED", "REJECTED", "NEEDS_REVIEW"],
  NEEDS_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["REJECTED", "NEEDS_REVIEW"], // allow quarantine/re-review after approval
  REJECTED: ["NEEDS_REVIEW"], // allow re-opening a rejection for review
};

export function canModerateMedia(from: string, to: string): boolean {
  return MEDIA_MODERATION_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---- Public-ish DTOs (admin/moderator responses; still sanitized) ----

/** A safety report as shown to a moderator (never exposes reporter identity to
 *  the reported user — this DTO is for privileged review only). */
export interface SafetyReportView {
  id: string;
  reporterUserId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReasonCode;
  description: string | null;
  status: SafetyReportStatus;
  priority: ReportPriority;
  assignedTo: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface AuditLogView {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ModerationActionView {
  id: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  reportId: string | null;
  createdAt: string;
}

/** Max suspension duration the server accepts (sanity bound). */
export const MAX_SUSPENSION_HOURS = 24 * 365; // 1 year
