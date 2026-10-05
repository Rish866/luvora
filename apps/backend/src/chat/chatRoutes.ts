import { Router } from "express";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { makeRateLimiter } from "../http/rateLimiter";
import { abuseLimit, AbuseRules } from "../http/abuseGuardMiddleware";
import { config } from "../config";
import { matchIdParamSchema } from "../discovery/discoverySchemas";
import * as chat from "./chatService";
import { hub } from "./connectionRegistry";

/**
 * Private chat REST API, mounted at /api/matches/:matchId/messages.
 *
 * Uses mergeParams so :matchId from the parent mount is available. All access
 * flows through chatService, which authorizes via the match relationship.
 */
export const chatRouter = Router({ mergeParams: true });
chatRouter.use(requireAuth);

// A dedicated limiter for message creation (reuses the project's limiter;
// pass-through under test). Separate from the global limiter so chat sending
// has its own budget.
const sendLimiter = makeRateLimiter(config.rateLimit.max);
// AbuseGuard per-user send cap (effective under test; process-local).
const sendAbuseLimit = abuseLimit({
  scope: "chat-send",
  rule: AbuseRules.chatSend,
  by: ["user"],
});

// GET /api/matches/:matchId/messages?limit=&cursor=
chatRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { matchId } = matchIdParamSchema.parse(req.params);
    const { limit, cursor } = chat.historyQuerySchema.parse(req.query);
    const result = await chat.getHistoryByMatch({
      authenticatedUserId: req.userId!,
      matchId,
      limit,
      cursorRaw: cursor,
    });
    ok(res, {
      conversationId: result.conversationId,
      messages: result.messages,
      nextCursor: result.nextCursor,
    });
  }),
);

// POST /api/matches/:matchId/messages
chatRouter.post(
  "/",
  sendLimiter,
  sendAbuseLimit,
  asyncHandler(async (req, res) => {
    const { matchId } = matchIdParamSchema.parse(req.params);
    const { body, clientMessageId, attachmentIds } = chat.sendBodySchema.parse(req.body);
    const { message, context } = await chat.createMessage({
      authenticatedUserId: req.userId!,
      matchId,
      body,
      clientMessageId: clientMessageId ?? null,
      attachmentIds,
    });
    // Deliver in real time to any connected sockets of both participants.
    hub.broadcastToUsers([context.userId, context.partnerId], {
      type: "message.created",
      message,
    });
    ok(res, { message }, 201);
  }),
);
