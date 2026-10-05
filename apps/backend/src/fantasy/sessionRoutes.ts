import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { Errors } from "../http/errors";
import { query } from "../db/pool";
import * as repo from "./sessionRepository";
import * as service from "./sessionService";

export const sessionRouter = Router();
sessionRouter.use(requireAuth);

const inviteSchema = z.object({
  matchId: z.string().uuid(),
  scenarioId: z.string().min(1),
  scenarioVersion: z.string().min(1).default("v1"),
});

interface MatchRow {
  id: string;
  user_a: string;
  user_b: string;
  state: string;
}

/** Create a fantasy invitation within an ACTIVE match the caller belongs to. */
sessionRouter.post(
  "/invite",
  asyncHandler(async (req, res) => {
    const input = inviteSchema.parse(req.body);
    const userId = req.userId!;

    const rows = await query<MatchRow>(
      `SELECT id, user_a, user_b, state FROM matches WHERE id = $1`,
      [input.matchId],
    );
    const match = rows[0];
    if (!match) throw Errors.notFound("Match not found.");
    if (match.user_a !== userId && match.user_b !== userId) {
      throw Errors.unauthorized("You are not part of this match.");
    }
    if (match.state !== "ACTIVE") {
      throw Errors.conflict("This match is not active.");
    }

    const inviteeId = match.user_a === userId ? match.user_b : match.user_a;
    const session = await repo.createInvite({
      matchId: match.id,
      scenarioId: input.scenarioId,
      scenarioVersion: input.scenarioVersion,
      initiatorId: userId,
      inviteeId,
    });
    ok(res, { sessionId: session.id, state: session.state }, 201);
  }),
);

sessionRouter.post(
  "/:id/accept",
  asyncHandler(async (req, res) => {
    const session = await service.acceptInvite(req.params.id, req.userId!);
    ok(res, { sessionId: session.id, state: session.state });
  }),
);

sessionRouter.post(
  "/:id/decline",
  asyncHandler(async (req, res) => {
    const session = await service.declineOrAbandon(req.params.id, req.userId!);
    ok(res, { sessionId: session.id, state: session.state });
  }),
);

sessionRouter.post(
  "/:id/consent",
  asyncHandler(async (req, res) => {
    const input = service.submitConsentSchema.parse(req.body);
    const view = await service.submitConsent(req.params.id, req.userId!, input);
    ok(res, view);
  }),
);

sessionRouter.get(
  "/:id/consent",
  asyncHandler(async (req, res) => {
    const view = await service.getConsentView(req.params.id, req.userId!);
    ok(res, view);
  }),
);

sessionRouter.post(
  "/:id/leave",
  asyncHandler(async (req, res) => {
    const session = await service.leaveSession(req.params.id, req.userId!);
    ok(res, { sessionId: session.id, state: session.state });
  }),
);
