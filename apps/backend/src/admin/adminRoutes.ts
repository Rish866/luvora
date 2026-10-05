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
import { audit } from "./auditService";
import * as deviceRepo from "../notifications/deviceRepository";
import * as deliveryRepo from "../notifications/deliveryRepository";
import * as jobRepo from "../jobs/jobRepository";
import * as jobService from "../jobs/jobService";
import { JobStatus, JobType } from "@luvora/shared";
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

// ======================= DEVICE / DELIVERY DIAGNOSTICS (admin only) ============
//
// Admins may inspect a user's registered devices + the latest delivery status
// for support/safety — but NEVER the raw push token. The DTO exposes only
// id/platform/provider/fingerprint/active/timestamps + last delivery status.
// The inspection itself is audited.

adminRouter.get(
  "/users/:id/devices",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const rows = await deviceRepo.listForUser(id);
    const devices = await Promise.all(
      rows.map(async (row) => {
        const deliveries = await deliveryRepo.listForDevice(row.id);
        const latest = deliveries[0];
        return {
          ...deviceRepo.toView(row), // never includes the raw token
          lastDeliveryStatus: latest ? latest.status : null,
          lastDeliveryErrorCode: latest ? latest.last_error_code : null,
          lastDeliveryAt: latest ? latest.updated_at : null,
        };
      }),
    );
    await audit({
      actorUserId: req.userId!,
      action: "user.devices_inspected",
      targetType: "USER",
      targetId: id,
      metadata: { deviceCount: devices.length },
      ...ctxOf(req),
    });
    ok(res, { devices });
  }),
);

// ======================= BACKGROUND JOB DIAGNOSTICS (admin only) ===============
//
// Admins may inspect the durable job queue for operations/safety: list jobs
// (filterable, paginated), view one job, see dead-letter jobs, and read queue
// metrics. Responses expose only a REDACTED payload summary (ids/flags) — never
// the raw payload or any secret. Read-only; no client can enqueue/cancel here.

const jobListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
  status: z.nativeEnum(JobStatus).optional(),
  jobType: z.nativeEnum(JobType).optional(),
});

adminRouter.get(
  "/jobs",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = jobListQuerySchema.parse(req.query);
    let before = null as ReturnType<typeof decodeCursor>;
    if (q.cursor) {
      before = decodeCursor(q.cursor);
      if (!before) throw Errors.invalidCursor();
    }
    const rows = await jobRepo.listJobs({
      status: q.status,
      jobType: q.jobType,
      limit: q.limit,
      before,
    });
    const nextCursor =
      rows.length === q.limit
        ? encodeCursor({ createdAt: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id })
        : null;
    ok(res, { jobs: rows.map(jobService.toView), nextCursor });
  }),
);

adminRouter.get(
  "/jobs/metrics",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const snapshot = await jobService.metricsSnapshot();
    ok(res, snapshot);
  }),
);

// Worker health for THIS process (null when no embedded worker runs here — the
// API is still healthy without a worker). Never exposed unauthenticated.
adminRouter.get(
  "/jobs/worker",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const { getWorkerHealth } = await import("../jobs/workerRegistry");
    ok(res, { worker: getWorkerHealth() });
  }),
);

adminRouter.get(
  "/jobs/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = uuidParam("id").parse(req.params);
    const row = await jobRepo.getById(id);
    if (!row) throw Errors.jobNotFound();
    ok(res, { job: jobService.toView(row) });
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
