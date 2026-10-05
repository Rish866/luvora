import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import * as presence from "./presenceService";

/**
 * Presence lookup mounted at /api/users/:userId/presence. Authenticated;
 * enforces the matched + not-blocked visibility rule. Returns only
 * ONLINE / OFFLINE (+ lastSeenAt) — never socket/device internals.
 */
export const presenceRouter = Router();
presenceRouter.use(requireAuth);

const paramSchema = z.object({ userId: z.string().uuid() });

presenceRouter.get(
  "/:userId/presence",
  asyncHandler(async (req, res) => {
    const { userId } = paramSchema.parse(req.params);
    const view = await presence.getPresenceFor(req.userId!, userId);
    ok(res, view);
  }),
);
