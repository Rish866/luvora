import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { Errors } from "../http/errors";
import { query } from "../db/pool";
import * as repo from "./sessionRepository";
import * as service from "./sessionService";
import * as gameplay from "./gameplayService";
import { gameHub } from "./gameConnectionRegistry";
import * as notifications from "../notifications/notificationService";
import { NotificationType } from "@luvora/shared";

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
    // Notify the invitee of the fantasy invitation (no scenario/consent detail).
    await notifications.create({
      userId: inviteeId,
      type: NotificationType.FANTASY_INVITE,
      title: "Fantasy invitation",
      body: "You've been invited to a fantasy.",
      entityType: "session",
      entityId: session.id,
      dedupeKey: `fantasy:${session.id}:invite:${inviteeId}`,
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

// ---- Increment 4: data-driven gameplay ----

const sessionIdParam = z.object({ id: z.string().uuid() });
const choiceIdParam = z.object({ id: z.string().uuid(), choiceId: z.string().uuid() });

/** Authoritative gameplay state (reconnect-safe; DB-sourced). */
sessionRouter.get(
  "/:id/state",
  asyncHandler(async (req, res) => {
    const { id } = sessionIdParam.parse(req.params);
    const state = await gameplay.getState(id, req.userId!);
    ok(res, { state });
  }),
);

/** Broadcast a game state change to both participants of a session. */
async function broadcastGameState(
  sessionId: string,
  event: Parameters<typeof gameHub.broadcastToUsers>[1],
): Promise<void> {
  const s = await repo.getSession(sessionId);
  if (s) gameHub.broadcastToUsers([s.initiator_id, s.invitee_id], event);
}

/** Select a published scenario for a consented (PLAYING) session. */
sessionRouter.post(
  "/:id/scenario",
  asyncHandler(async (req, res) => {
    const { id } = sessionIdParam.parse(req.params);
    const { scenarioId } = gameplay.selectScenarioSchema.parse(req.body);
    const state = await gameplay.selectScenario(id, req.userId!, scenarioId);
    await broadcastGameState(id, { type: "game.state.changed", state });
    ok(res, { state }, 201);
  }),
);

/** Submit a choice (by id). Idempotent via clientActionId. */
sessionRouter.post(
  "/:id/choices/:choiceId",
  asyncHandler(async (req, res) => {
    const { id, choiceId } = choiceIdParam.parse(req.params);
    const { clientActionId } = gameplay.chooseSchema.parse(req.body);
    const result = await gameplay.choose(id, req.userId!, choiceId, clientActionId);
    // Persist-then-broadcast to both participants.
    const event = result.completed
      ? ({ type: "game.completed", state: result.state } as const)
      : ({ type: "game.state.changed", state: result.state } as const);
    gameHub.broadcastToUsers(result.participants, event);
    ok(res, { state: result.state });
  }),
);

sessionRouter.post(
  "/:id/pause",
  asyncHandler(async (req, res) => {
    const { id } = sessionIdParam.parse(req.params);
    const state = await gameplay.pause(id, req.userId!);
    await broadcastGameState(id, { type: "game.state.changed", state });
    ok(res, { state });
  }),
);

sessionRouter.post(
  "/:id/resume",
  asyncHandler(async (req, res) => {
    const { id } = sessionIdParam.parse(req.params);
    const state = await gameplay.resume(id, req.userId!);
    await broadcastGameState(id, { type: "game.state.changed", state });
    ok(res, { state });
  }),
);
