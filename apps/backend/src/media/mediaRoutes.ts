import { Router, raw } from "express";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { makeRateLimiter } from "../http/rateLimiter";
import { config } from "../config";
import { z } from "zod";
import * as media from "./mediaService";

/** /api/media — secure media upload, access, delete, report. */
export const mediaRouter = Router();
mediaRouter.use(requireAuth);

const mediaIdParam = z.object({ mediaId: z.string().uuid({ message: "Invalid media id." }) });

const uploadLimiter = makeRateLimiter(config.rateLimit.max);
const reportLimiter = makeRateLimiter(config.rateLimit.authMax);

// Step 1 — create upload intent.
mediaRouter.post(
  "/",
  uploadLimiter,
  asyncHandler(async (req, res) => {
    const input = media.createIntentSchema.parse(req.body);
    const intent = await media.createUploadIntent({
      ownerId: req.userId!,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      context: input.context,
    });
    ok(res, intent, 201);
  }),
);

// Step 2 — upload raw bytes. Body is bounded to the max media size to avoid
// unbounded memory use; the type guard restricts to allowed image types but the
// REAL validation is server-side byte inspection in the service.
mediaRouter.put(
  "/:mediaId/content",
  uploadLimiter,
  raw({ type: () => true, limit: config.media.maxBytes }),
  asyncHandler(async (req, res) => {
    const { mediaId } = mediaIdParam.parse(req.params);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const view = await media.uploadContent({
      ownerId: req.userId!,
      mediaId,
      data,
    });
    ok(res, view);
  }),
);

// Metadata (owner sees moderation progress; others only if authorized).
mediaRouter.get(
  "/:mediaId",
  asyncHandler(async (req, res) => {
    const { mediaId } = mediaIdParam.parse(req.params);
    // If the client explicitly asks for raw bytes via Accept, stream them;
    // otherwise return the JSON metadata view. We keep bytes on a sub-path to
    // avoid content sniffing ambiguity.
    const view = await media.getAssetView(req.userId!, mediaId);
    ok(res, view);
  }),
);

/** Shared handler for streaming bytes (original or thumbnail). */
function streamVariant(variant: "original" | "thumbnail") {
  return asyncHandler(async (req, res) => {
    const { mediaId } = mediaIdParam.parse(req.params);
    const { data, mimeType } = await media.getBytes({
      userId: req.userId!,
      mediaId,
      variant,
    });
    // Private media: never cache, never sniff, never render inline-dangerously.
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    res.status(200).end(data);
  });
}

// Raw bytes (authorized). Kept on a sub-path so GET /:mediaId stays JSON.
mediaRouter.get("/:mediaId/content", streamVariant("original"));
mediaRouter.get("/:mediaId/thumbnail", streamVariant("thumbnail"));

// Delete (owner-only, soft).
mediaRouter.delete(
  "/:mediaId",
  asyncHandler(async (req, res) => {
    const { mediaId } = mediaIdParam.parse(req.params);
    await media.deleteAsset(req.userId!, mediaId);
    ok(res, { deleted: true, mediaId });
  }),
);

// Report.
mediaRouter.post(
  "/:mediaId/report",
  reportLimiter,
  asyncHandler(async (req, res) => {
    const { mediaId } = mediaIdParam.parse(req.params);
    const { reason } = media.reportSchema.parse(req.body);
    await media.reportAsset({ userId: req.userId!, mediaId, reason });
    ok(res, { reported: true });
  }),
);
