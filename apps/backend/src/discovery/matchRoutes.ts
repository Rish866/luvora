import { Router } from "express";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import * as service from "./discoveryService";
import { matchIdParamSchema } from "./discoverySchemas";

/** /api/matches — authenticated match list + detail (participant-only). */
export const matchRouter = Router();
matchRouter.use(requireAuth);

// GET /api/matches
matchRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const matches = await service.listMatches(req.userId!);
    ok(res, { matches });
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
