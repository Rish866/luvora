import { Router } from "express";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import * as service from "./discoveryService";
import { matchIdParamSchema } from "./discoverySchemas";

/** /api/matches — authenticated match list + detail (participant-only). */
export const matchRouter = Router();
matchRouter.use(requireAuth);

// GET /api/matches — the inbox: matches enriched with conversation id, last
// message, and unread count, plus a total unread across all matches.
matchRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { matches, totalUnreadCount } = await service.listMatches(req.userId!);
    ok(res, { matches, totalUnreadCount });
  }),
);

// GET /api/matches/:matchId — only the two participants may read it.
matchRouter.get(
  "/:matchId",
  asyncHandler(async (req, res) => {
    const { matchId } = matchIdParamSchema.parse(req.params);
    const match = await service.getMatch(matchId, req.userId!);
    ok(res, { match });
  }),
);
