import { Router } from "express";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import * as service from "./scenarioService";

/** /api/scenarios — read-only published scenario library (auth required). */
export const scenarioRouter = Router();
scenarioRouter.use(requireAuth);

// GET /api/scenarios?limit=&cursor=
scenarioRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, cursor } = service.libraryQuerySchema.parse(req.query);
    const page = await service.listScenarios({ limit, cursorRaw: cursor });
    ok(res, { scenarios: page.scenarios, nextCursor: page.nextCursor });
  }),
);

// GET /api/scenarios/:scenarioId
scenarioRouter.get(
  "/:scenarioId",
  asyncHandler(async (req, res) => {
    const { scenarioId } = service.scenarioIdParamSchema.parse(req.params);
    const scenario = await service.getScenario(scenarioId);
    ok(res, { scenario });
  }),
);
