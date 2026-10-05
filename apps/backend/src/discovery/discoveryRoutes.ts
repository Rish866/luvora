import { Router } from "express";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { abuseLimit, AbuseRules } from "../http/abuseGuardMiddleware";
import * as service from "./discoveryService";
import { feedQuerySchema, userIdParamSchema } from "./discoverySchemas";

/** /api/discovery — authenticated discovery feed + like/pass actions. */
export const discoveryRouter = Router();
discoveryRouter.use(requireAuth);

// Per-user throttle on swipe actions (spam/abuse defence). Process-local.
const actionLimit = abuseLimit({
  scope: "discovery-action",
  rule: AbuseRules.discoveryAction,
  by: ["user"],
});

// GET /api/discovery?limit=&cursor=
discoveryRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, cursor } = feedQuerySchema.parse(req.query);
    const page = await service.getFeed({
      viewerId: req.userId!,
      limit,
      cursorRaw: cursor,
    });
    ok(res, { candidates: page.candidates, nextCursor: page.nextCursor });
  }),
);

// POST /api/discovery/:userId/like
discoveryRouter.post(
  "/:userId/like",
  actionLimit,
  asyncHandler(async (req, res) => {
    const { userId } = userIdParamSchema.parse(req.params);
    const result = await service.like(req.userId!, userId);
    ok(res, result);
  }),
);

// POST /api/discovery/:userId/pass
discoveryRouter.post(
  "/:userId/pass",
  actionLimit,
  asyncHandler(async (req, res) => {
    const { userId } = userIdParamSchema.parse(req.params);
    const result = await service.pass(req.userId!, userId);
    ok(res, result);
  }),
);
