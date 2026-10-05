import { z } from "zod";
import {
  MESSAGE_MAX_LENGTH,
  type ChatMessage,
} from "@luvora/shared";
import { Errors } from "../http/errors";
import * as chatRepo from "./chatRepository";
import {
  authorizeByConversation,
  authorizeByMatch,
  type ChatContext,
} from "./chatAuthorization";
import { encodeCursor, decodeCursor } from "./chatCursor";

/**
 * Chat application logic. Both the HTTP routes and the WebSocket gateway call
 * these functions, so validation, authorization, and persistence behave
 * identically regardless of transport (§49/§50).
 */

export const MESSAGE_HISTORY_LIMIT_MIN = 1;
export const MESSAGE_HISTORY_LIMIT_MAX = 100;
export const MESSAGE_HISTORY_LIMIT_DEFAULT = 50;

export const historyQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(MESSAGE_HISTORY_LIMIT_MIN)
    .max(MESSAGE_HISTORY_LIMIT_MAX)
    .default(MESSAGE_HISTORY_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
});

export const sendBodySchema = z.object({
  body: z.string(),
  clientMessageId: z.string().uuid().optional(),
});

function toChatMessage(row: chatRepo.MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    clientMessageId: row.client_message_id,
    createdAt: row.created_at,
  };
}

/**
 * Validate a message body: reject empty / whitespace-only, enforce the max
 * length in Unicode code points. Returns the normalized body (trimmed of outer
 * whitespace but preserving inner content and Unicode).
 */
export function validateBody(raw: unknown): string {
  if (typeof raw !== "string") throw Errors.messageEmpty();
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw Errors.messageEmpty();
  // Count Unicode code points (not UTF-16 units) so emoji count as expected.
  const codePoints = [...trimmed].length;
  if (codePoints > MESSAGE_MAX_LENGTH) throw Errors.messageTooLong();
  return trimmed;
}

export interface CreateMessageInput {
  authenticatedUserId: string;
  /** Exactly one of matchId / conversationId identifies the target. */
  matchId?: string;
  conversationId?: string;
  body: unknown;
  clientMessageId?: string | null;
}

export interface CreateMessageResult {
  message: ChatMessage;
  context: ChatContext;
}

/**
 * The single authoritative message-creation path. Authorizes, validates,
 * persists, and returns the canonical message. The sender id is ALWAYS the
 * authenticated user — any client-supplied sender id is ignored.
 */
export async function createMessage(
  input: CreateMessageInput,
): Promise<CreateMessageResult> {
  const context = input.matchId
    ? await authorizeByMatch(input.authenticatedUserId, input.matchId)
    : await authorizeByConversation(
        input.authenticatedUserId,
        input.conversationId!,
      );

  const body = validateBody(input.body);

  const row = await chatRepo.insertMessage({
    conversationId: context.conversationId,
    senderId: input.authenticatedUserId, // authoritative identity
    body,
    clientMessageId: input.clientMessageId ?? null,
  });

  return { message: toChatMessage(row), context };
}

export interface HistoryResult {
  messages: ChatMessage[];
  nextCursor: string | null;
  conversationId: string;
}

/** Paginated history (oldest→newest within the returned page). `nextCursor`
 *  pages further back into history. */
export async function getHistoryByMatch(input: {
  authenticatedUserId: string;
  matchId: string;
  limit: number;
  cursorRaw?: string;
}): Promise<HistoryResult> {
  const context = await authorizeByMatch(
    input.authenticatedUserId,
    input.matchId,
  );

  let before = null as ReturnType<typeof decodeCursor>;
  if (input.cursorRaw) {
    before = decodeCursor(input.cursorRaw);
    if (!before) throw Errors.invalidCursor();
  }

  const rowsDesc = await chatRepo.listMessages({
    conversationId: context.conversationId,
    limit: input.limit,
    before,
  });

  // Query returned newest→oldest; the next (older) page continues before the
  // oldest row we just fetched.
  const nextCursor =
    rowsDesc.length === input.limit
      ? encodeCursor({
          createdAt:
            rowsDesc[rowsDesc.length - 1].cursor_created_at ??
            rowsDesc[rowsDesc.length - 1].created_at,
          id: rowsDesc[rowsDesc.length - 1].id,
        })
      : null;

  // Present oldest→newest.
  const messages = [...rowsDesc].reverse().map(toChatMessage);
  return { messages, nextCursor, conversationId: context.conversationId };
}

export interface MarkReadResult {
  context: ChatContext;
  conversationId: string;
  messageId: string;
}

/** Mark the conversation read through a specific message. Validates that the
 *  message belongs to the conversation. */
export async function markRead(input: {
  authenticatedUserId: string;
  conversationId: string;
  messageId: string;
}): Promise<MarkReadResult> {
  const context = await authorizeByConversation(
    input.authenticatedUserId,
    input.conversationId,
  );
  const belongs = await chatRepo.messageBelongsToConversation(
    input.messageId,
    context.conversationId,
  );
  if (!belongs) {
    throw Errors.chatNotAuthorized();
  }
  await chatRepo.setReadMarker({
    conversationId: context.conversationId,
    userId: input.authenticatedUserId,
    lastReadMessageId: input.messageId,
  });
  return {
    context,
    conversationId: context.conversationId,
    messageId: input.messageId,
  };
}

/** Authorize a conversation for an ephemeral action (typing). Returns context
 *  for recipient routing; persists nothing. */
export async function authorizeEphemeral(
  authenticatedUserId: string,
  conversationId: string,
): Promise<ChatContext> {
  return authorizeByConversation(authenticatedUserId, conversationId);
}
