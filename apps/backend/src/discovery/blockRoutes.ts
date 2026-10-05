import { Router } from "express";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { abuseLimit, AbuseRules } from "../http/abuseGuardMiddleware";
import * as service from "./discoveryService";
import { userIdParamSchema } from "./discoverySchemas";

/** /api/users/:userId/block — authenticated block / unblock. */
export const userBlockRouter = Router();
userBlockRouter.use(requireAuth);

const blockLimit = abuseLimit({
  scope: "user-block",
  rule: AbuseRules.discoveryAction,
  by: ["user"],
});

// POST /api/users/:userId/block  (idempotent)
userBlockRouter.post(
  "/:userId/block",
  blockLimit,
  asyncHandler(async (req, res) => {
    const { userId } = userIdParamSchema.parse(req.params);
    await service.block(req.userId!, userId);
    ok(res, { blocked: true, userId });
  }),
);

// DELETE /api/users/:userId/block  (idempotent; never recreates a match)
userBlockRouter.delete(
  "/:userId/block",
  blockLimit,
  asyncHandler(async (req, res) => {
    const { userId } = userIdParamSchema.parse(req.params);
    await service.unblock(req.userId!, userId);
    ok(res, { blocked: false, userId });
  }),
);
