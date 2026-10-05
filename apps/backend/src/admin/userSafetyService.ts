import { z } from "zod";
import { UserRole, AccountStatus, MAX_SUSPENSION_HOURS } from "@luvora/shared";
import { Errors } from "../http/errors";
import * as users from "../users/userRepository";
import * as sessions from "../auth/authSessionRepository";
import { hub } from "../chat/connectionRegistry";
import { gameHub } from "../fantasy/gameConnectionRegistry";
import { audit } from "./auditService";
import { writeModerationAction } from "./auditRepository";
import * as notifications from "../notifications/notificationService";
import { NotificationType } from "@luvora/shared";

/**
 * Account safety actions (admin-only). Each action validates the target and
 * current state, applies the change, revokes the user's auth sessions, closes
 * their live WebSocket connections, and records moderation + audit entries.
 */

export const suspendSchema = z.object({
  reason: z.string().min(1).max(2000),
  durationHours: z.number().int().positive().max(MAX_SUSPENSION_HOURS).optional(),
});

export const roleSchema = z.object({
  role: z.nativeEnum(UserRole),
});

interface Ctx {
  ip?: string | null;
  userAgent?: string | null;
}

/** Revoke all auth sessions and close all live sockets for a user. */
async function revokeAll(userId: string): Promise<void> {
  await sessions.revokeAllForUser(userId);
  hub.closeUser(userId);
  gameHub.closeUser(userId);
}

export async function suspend(input: {
  actorId: string;
  targetId: string;
  reason: string;
  durationHours?: number;
  ctx?: Ctx;
}): Promise<{ status: AccountStatus; suspendedUntil: string | null }> {
  if (input.actorId === input.targetId) throw Errors.cannotSuspendSelf();
  const target = await users.findById(input.targetId);
  if (!target) throw Errors.adminUserNotFound();

  const suspendedUntil = input.durationHours
    ? new Date(Date.now() + input.durationHours * 3600 * 1000)
    : null;

  // Create the SAFETY notification BEFORE suspending — once suspended the
  // account is non-ACTIVE and the notification service would suppress it. The
  // notification is deliberately minimal: no reporter/moderator identity, no
  // report content, no internal notes.
  await notifications.create({
    userId: input.targetId,
    type: NotificationType.SAFETY_ACTION,
    title: "Account suspended",
    body: "Your account has been suspended by the Luvora safety team.",
    entityType: "account",
    entityId: null,
    dedupeKey: null,
    expiresAt: null,
  });

  await users.suspendUser(input.targetId, suspendedUntil, input.reason);
  await revokeAll(input.targetId);

  await writeModerationAction({
    actorUserId: input.actorId,
    action: "user.suspended",
    targetType: "USER",
    targetId: input.targetId,
    reason: input.reason,
  });
  await audit({
    actorUserId: input.actorId,
    action: "user.suspended",
    targetType: "USER",
    targetId: input.targetId,
    metadata: { durationHours: input.durationHours ?? null },
    ip: input.ctx?.ip ?? null,
    userAgent: input.ctx?.userAgent ?? null,
  });

  return {
    status: AccountStatus.SUSPENDED,
    suspendedUntil: suspendedUntil ? suspendedUntil.toISOString() : null,
  };
}

export async function unsuspend(input: {
  actorId: string;
  targetId: string;
  ctx?: Ctx;
}): Promise<{ status: AccountStatus }> {
  const target = await users.findById(input.targetId);
  if (!target) throw Errors.adminUserNotFound();

  await users.unsuspendUser(input.targetId);
  await notifications.create({
    userId: input.targetId,
    type: NotificationType.SAFETY_ACTION,
    title: "Suspension lifted",
    body: "Your account suspension has been lifted.",
    entityType: "account",
    entityId: null,
    dedupeKey: null,
    expiresAt: null,
  });
  await writeModerationAction({
    actorUserId: input.actorId,
    action: "user.unsuspended",
    targetType: "USER",
    targetId: input.targetId,
  });
  await audit({
    actorUserId: input.actorId,
    action: "user.unsuspended",
    targetType: "USER",
    targetId: input.targetId,
    ip: input.ctx?.ip ?? null,
    userAgent: input.ctx?.userAgent ?? null,
  });
  return { status: AccountStatus.ACTIVE };
}

export async function deactivate(input: {
  actorId: string;
  targetId: string;
  reason: string;
  ctx?: Ctx;
}): Promise<{ status: AccountStatus }> {
  if (input.actorId === input.targetId) throw Errors.cannotSuspendSelf();
  const target = await users.findById(input.targetId);
  if (!target) throw Errors.adminUserNotFound();

  // Protect the last admin from being locked out.
  if (target.role === UserRole.ADMIN) {
    const admins = await users.countByRole(UserRole.ADMIN);
    if (admins <= 1) throw Errors.lastAdmin();
  }

  await users.deactivateUser(input.targetId, input.reason);
  await revokeAll(input.targetId);

  await writeModerationAction({
    actorUserId: input.actorId,
    action: "user.deactivated",
    targetType: "USER",
    targetId: input.targetId,
    reason: input.reason,
  });
  await audit({
    actorUserId: input.actorId,
    action: "user.deactivated",
    targetType: "USER",
    targetId: input.targetId,
    ip: input.ctx?.ip ?? null,
    userAgent: input.ctx?.userAgent ?? null,
  });
  return { status: AccountStatus.DEACTIVATED };
}

export async function reactivate(input: {
  actorId: string;
  targetId: string;
  ctx?: Ctx;
}): Promise<{ status: AccountStatus }> {
  const target = await users.findById(input.targetId);
  if (!target) throw Errors.adminUserNotFound();
  await users.reactivateUser(input.targetId);
  // Account is ACTIVE again, so the safety notification is delivered normally.
  await notifications.create({
    userId: input.targetId,
    type: NotificationType.SAFETY_ACTION,
    title: "Account reactivated",
    body: "Your account has been reactivated.",
    entityType: "account",
    entityId: null,
    dedupeKey: null,
    expiresAt: null,
  });
  await writeModerationAction({
    actorUserId: input.actorId,
    action: "user.reactivated",
    targetType: "USER",
    targetId: input.targetId,
  });
  await audit({
    actorUserId: input.actorId,
    action: "user.reactivated",
    targetType: "USER",
    targetId: input.targetId,
    ip: input.ctx?.ip ?? null,
    userAgent: input.ctx?.userAgent ?? null,
  });
  return { status: AccountStatus.ACTIVE };
}

// ---- Role management (admin-only) ----

export async function setRole(input: {
  actorId: string;
  targetId: string;
  role: UserRole;
  ctx?: Ctx;
}): Promise<{ role: UserRole }> {
  const target = await users.findById(input.targetId);
  if (!target) throw Errors.adminUserNotFound();

  // Demoting the last admin would leave the platform with no administrator.
  if (target.role === UserRole.ADMIN && input.role !== UserRole.ADMIN) {
    const admins = await users.countByRole(UserRole.ADMIN);
    if (admins <= 1) throw Errors.lastAdmin();
  }

  await users.setRole(input.targetId, input.role);
  await writeModerationAction({
    actorUserId: input.actorId,
    action: "user.role_changed",
    targetType: "USER",
    targetId: input.targetId,
    reason: input.role,
  });
  await audit({
    actorUserId: input.actorId,
    action: "user.role_changed",
    targetType: "USER",
    targetId: input.targetId,
    metadata: { role: input.role, previousRole: target.role },
    ip: input.ctx?.ip ?? null,
    userAgent: input.ctx?.userAgent ?? null,
  });
  // A role change can affect privileges mid-session; revoke sessions so the new
  // role is picked up on next auth (defense in depth; requireAuth also reads
  // the live role each request).
  await sessions.revokeAllForUser(input.targetId);
  return { role: input.role };
}

export async function getRole(targetId: string): Promise<{ role: string }> {
  const target = await users.findById(targetId);
  if (!target) throw Errors.adminUserNotFound();
  return { role: target.role };
}
