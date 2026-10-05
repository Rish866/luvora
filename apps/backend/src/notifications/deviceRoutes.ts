import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { Errors } from "../http/errors";
import { makeRateLimiter } from "../http/rateLimiter";
import { config } from "../config";
import { DevicePlatform, PushProviderKind } from "@luvora/shared";
import * as deviceRepo from "./deviceRepository";

/**
 * Device registration API, mounted at /api/notifications/devices.
 *
 * The authenticated caller ALWAYS owns the registration — `userId` is never
 * read from the body. Raw push tokens are never returned (list/response DTOs
 * expose only a fingerprint + metadata). Registration + removal are
 * rate-limited with the shared limiter.
 */
export const deviceRouter = Router();
deviceRouter.use(requireAuth);

// Dedicated rate limit for device operations (reuses the shared limiter infra).
const deviceLimiter = makeRateLimiter(config.notifications.deviceRateLimitMax);

const registerSchema = z.object({
  platform: z.nativeEnum(DevicePlatform),
  provider: z.nativeEnum(PushProviderKind),
  // A push token is opaque; bound its length to reject obviously-malformed input
  // without logging/echoing it.
  token: z.string().min(8).max(4096),
  label: z.string().max(100).optional().nullable(),
});

const idParam = z.object({ id: z.string().uuid() });

// POST /api/notifications/devices — register (idempotent) the caller's device.
deviceRouter.post(
  "/",
  deviceLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const row = await deviceRepo.register({
      userId: req.userId!, // authoritative owner; body userId (if any) ignored
      platform: body.platform,
      provider: body.provider,
      token: body.token,
      label: body.label ?? null,
    });
    ok(res, { device: deviceRepo.toView(row) }, 201);
  }),
);

// GET /api/notifications/devices — list the caller's devices (safe metadata).
deviceRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await deviceRepo.listForUser(req.userId!);
    ok(res, { devices: rows.map(deviceRepo.toView) });
  }),
);

// DELETE /api/notifications/devices/:id — revoke the caller's device.
deviceRouter.delete(
  "/:id",
  deviceLimiter,
  asyncHandler(async (req, res) => {
    const { id } = idParam.parse(req.params);
    const revoked = await deviceRepo.revokeOwned(req.userId!, id);
    if (!revoked) {
      // Either does not exist OR belongs to another user — same opaque error so
      // a device id cannot be probed via IDOR.
      throw Errors.deviceNotFound();
    }
    ok(res, { revoked: true });
  }),
);
