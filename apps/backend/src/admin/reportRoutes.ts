import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { makeRateLimiter } from "../http/rateLimiter";
import { config } from "../config";
import { ReportTargetType } from "@luvora/shared";
import * as reportService from "./reportService";

/**
 * User-facing safety reporting, mounted at /api/reports. Reports are private
 * safety records; the reporter's identity is never exposed to the reported
 * party. Rate-limited and dedup-constrained against spam.
 */
export const reportRouter = Router();
reportRouter.use(requireAuth);

const reportLimiter = makeRateLimiter(config.rateLimit.authMax);

function ctxOf(req: { ip?: string; headers: Record<string, unknown> }) {
  return {
    ip: req.ip ?? null,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? (req.headers["user-agent"] as string)
        : null,
  };
}

function makeReportHandler(targetType: ReportTargetType, paramName: string) {
  const paramSchema = z.object({ [paramName]: z.string().uuid() });
  return asyncHandler(async (req, res) => {
    const params = paramSchema.parse(req.params);
    const body = reportService.createReportSchema.parse(req.body);
    const result = await reportService.createReport({
      reporterId: req.userId!,
      targetType,
      targetId: params[paramName],
      reason: body.reason,
      description: body.description,
      ...ctxOf(req),
    });
    ok(res, { reported: true, reportId: result.reportId }, 201);
  });
}

reportRouter.post("/user/:userId", reportLimiter, makeReportHandler(ReportTargetType.USER, "userId"));
reportRouter.post("/media/:mediaId", reportLimiter, makeReportHandler(ReportTargetType.MEDIA, "mediaId"));
reportRouter.post("/message/:messageId", reportLimiter, makeReportHandler(ReportTargetType.MESSAGE, "messageId"));
reportRouter.post("/session/:sessionId", reportLimiter, makeReportHandler(ReportTargetType.SESSION, "sessionId"));
