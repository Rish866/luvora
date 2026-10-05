import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../http/asyncHandler";
import { ok } from "../http/respond";
import { requireAuth } from "../http/authMiddleware";
import { makeRateLimiter } from "../http/rateLimiter";
import { config } from "../config";
import * as chat from "./chatService";
import { hub } from "./connectionRegistry";

/**
 * Conversation-level REST endpoints, mounted at /api/conversations (Increment
 * 15). The inbox read-receipt + per-conversation unread count. These reuse the
 * SAME read-state model (conversation_read_state) and authorization
 * (authorizeByConversation) as the WebSocket `message.read` handler, so REST
 * and WS never produce conflicting state.
 */
export const conversationRouter = Router();
conversationRouter.use(requireAuth);

const idParam = z.object({ conversationId: z.string().uuid({ message: "Invalid conversation id." }) });

// A modest limiter (reuses the shared limiter; pass-through under test).
const readLimiter = makeRateLimiter(config.rateLimit.max);

// POST /api/conversations/:conversationId/read — mark the whole conversation
// read for the caller (idempotent). Returns the resulting read state.
conversationRouter.post(
  "/:conversationId/read",
  readLimiter,
  asyncHandler(async (req, res) => {
    const { conversationId } = idParam.parse(req.params);
    const result = await chat.readConversation({
      authenticatedUserId: req.userId!,
      conversationId,
    });
    // Mirror the WebSocket read receipt so live clients of the OTHER participant
    // observe the same read state (parity between REST and WS paths).
    if (result.lastReadMessageId) {
      hub.sendToUser(result.partnerId, {
        type: "message.read",
        conversationId: result.conversationId,
        messageId: result.lastReadMessageId,
        userId: req.userId!,
      });
    }
    ok(res, {
      conversationId: result.conversationId,
      lastReadMessageId: result.lastReadMessageId,
      unreadCount: result.unreadCount,
    });
  }),
);

// GET /api/conversations/:conversationId/unread-count — the caller's unread
// count for one conversation (authorized).
conversationRouter.get(
  "/:conversationId/unread-count",
  asyncHandler(async (req, res) => {
    const { conversationId } = idParam.parse(req.params);
    const result = await chat.conversationUnreadCount({
      authenticatedUserId: req.userId!,
      conversationId,
    });
    ok(res, result);
  }),
);
