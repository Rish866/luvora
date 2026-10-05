import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { requireModerator, requireAdmin } from "../http/rbac";
import { makeRateLimiter } from "../http/rateLimiter";
import { config } from "../config";
import { Errors } from "../http/errors";
import { SafetyReportStatus } from "@luvora/shared";
import * as reportService from "./reportService";
import * as reportRepo from "./reportRepository";
import * as adminMedia from "./adminMediaService";
import * as userSafety from "./userSafetyService";
import * as auditRepo from "./auditRepository";
import { encodeCursor, decodeCursor } from "./adminCursor";

/**
 * Admin / moderator control plane, mounted at /api/admin. Every route requires
 * authentication AND a server-side role (moderator or admin). The role comes
 * only from the authenticated DB record (req.userRole), never from client input.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth);

const adminLimiter = makeRateLimiter(config.rateLimit.max);

const uuidParam = (name: string) => z.object({ [name]: z.string().uuid() });
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  targetType: z.string().optional(),
  assignedTo: z.string().uuid().optional(),
});

function ctxOf(req: { ip?: string; headers: Record<string, unknown> }) {
  return {
    ip: req.ip ?? null,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? (req.headers["user-agent"] as string)
        : null,
  };
}

// ======================= MODERATION QUEUE (reports) =======================

/** GET /api/admin/reports — moderator+; keyset-paginated, filterable. */
adminRouter.get(
  "/reports",
  requireModerator,
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    let before = null as ReturnType<typeof decodeCursor>;
    if (q.cursor) {
      before = decodeCursor(q.cursor);
      if (!before) throw Errors.invalidCursor();
    }
    const { rows, nextCursor } = await reportRepo.listReports({
      status: q.status,
      priority: q.priority,
      targetType: q.targetType,
      assignedTo: q.assignedTo,
      limit: q.limit,
      before,
    });
    ok(res, {
      reports: rows.map(reportRepo.toView),
      nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
    });
  }),
);

/** Alias: the "moderation queue" is the open/in-review report list. */
adminRouter.get(
  "/moderation/queue",
  requireModerator,
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    let before = null as ReturnType<typeof decodeCursor>;
    if (q.cursor) {
      before = decodeCursor(q.cursor);
      if (!before) throw Errors.invalidCursor();
    }
    const { rows, nextCursor } = await reportRepo.listReports({
      status: q.status ?? SafetyReportStatus.OPEN,
      priority: q.priority,
      targetType: q.targetType,
      limit: q.limit,
      before,
    });
    ok(res, {
      reports: rows.map(reportRepo.toView),
      nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
    });
  }),
);

adminRouter.get(
  "/reports/:id",
  requireModerator,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const report = await reportService.getReport(id);
    ok(res, { report });
  }),
);

adminRouter.post(
  "/reports/:id/assign",
  requireModerator,
  adminLimiter,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const report = await reportService.assignReport(req.userId!, id, ctxOf(req));
    ok(res, { report });
  }),
);

adminRouter.post(
  "/reports/:id/resolve",
  requireModerator,
  adminLimiter,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const input = reportService.resolveReportSchema.parse(req.body);
    const report = await reportService.resolveReport({
      moderatorId: req.userId!,
      reportId: id,
      status: input.status,
      resolution: input.resolution,
      ...ctxOf(req),
    });
    ok(res, { report });
  }),
);

// ======================= MEDIA MODERATION =======================

adminRouter.get(
  "/media/:id",
  requireModerator,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const media = await adminMedia.getForReview(id);
    const actions = await auditRepo.listModerationActionsForTarget("MEDIA", id);
    ok(res, { media, actions });
  }),
);

function streamReview(variant: "original" | "thumbnail") {
  return asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const { data, mimeType } = await adminMedia.getReviewBytes(id, variant);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    res.status(200).end(data);
  });
}
adminRouter.get("/media/:id/content", requireModerator, streamReview("original"));
adminRouter.get("/media/:id/thumbnail", requireModerator, streamReview("thumbnail"));

adminRouter.post(
  "/media/:id/approve",
  requireModerator,
  adminLimiter,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const media = await adminMedia.approve(req.userId!, id, ctxOf(req));
    ok(res, { media });
  }),
);

adminRouter.post(
  "/media/:id/reject",
  requireModerator,
  adminLimiter,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const { reason } = adminMedia.reasonSchema.parse(req.body);
    const media = await adminMedia.reject(req.userId!, id, reason, ctxOf(req));
    ok(res, { media });
  }),
);

adminRouter.post(
  "/media/:id/quarantine",
  requireModerator,
  adminLimiter,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const { reason } = adminMedia.reasonSchema.parse(req.body);
    const media = await adminMedia.quarantine(req.userId!, id, reason, ctxOf(req));
    ok(res, { media });
  }),
);

// ======================= USER SAFETY (admin only) =======================

adminRouter.post(
  "/users/:id/suspend",
  requireAdmin,
  adminLimiter,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const input = userSafety.suspendSchema.parse(req.body);
    const result = await userSafety.suspend({
      actorId: req.userId!,
      targetId: id,
      reason: input.reason,
      durationHours: input.durationHours,
      ctx: ctxOf(req),
    });
    ok(res, result);
  }),
);

adminRouter.post(
  "/users/:id/unsuspend",
  requireAdmin,
  adminLimiter,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const result = await userSafety.unsuspend({ actorId: req.userId!, targetId: id, ctx: ctxOf(req) });
    ok(res, result);
  }),
);

adminRouter.post(
  "/users/:id/deactivate",
  requireAdmin,
  adminLimiter,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const input = userSafety.suspendSchema.pick({ reason: true }).parse(req.body);
    const result = await userSafety.deactivate({
      actorId: req.userId!,
      targetId: id,
      reason: input.reason,
      ctx: ctxOf(req),
    });
    ok(res, result);
  }),
);

adminRouter.post(
  "/users/:id/reactivate",
  requireAdmin,
  adminLimiter,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const result = await userSafety.reactivate({ actorId: req.userId!, targetId: id, ctx: ctxOf(req) });
    ok(res, result);
  }),
);

// ======================= ROLE MANAGEMENT (admin only) =======================

adminRouter.get(
  "/users/:id/role",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const result = await userSafety.getRole(id);
    ok(res, result);
  }),
);

adminRouter.post(
  "/users/:id/role",
  requireAdmin,
  adminLimiter,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const { role } = userSafety.roleSchema.parse(req.body);
    const result = await userSafety.setRole({
      actorId: req.userId!,
      targetId: id,
      role,
      ctx: ctxOf(req),
    });
    ok(res, result);
  }),
);

// ======================= AUDIT LOGS (admin only, read-only) =======================

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
  actorUserId: z.string().uuid().optional(),
  action: z.string().max(100).optional(),
  targetType: z.string().max(50).optional(),
  targetId: z.string().uuid().optional(),
});

adminRouter.get(
  "/audit-logs",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = auditQuerySchema.parse(req.query);
    let before = null as ReturnType<typeof decodeCursor>;
    if (q.cursor) {
      before = decodeCursor(q.cursor);
      if (!before) throw Errors.invalidCursor();
    }
    const { rows, nextCursor } = await auditRepo.listAudit({
      actorUserId: q.actorUserId,
      action: q.action,
      targetType: q.targetType,
      targetId: q.targetId,
      limit: q.limit,
      before,
    });
    ok(res, { logs: rows, nextCursor: nextCursor ? encodeCursor(nextCursor) : null });
  }),
);
