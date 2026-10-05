import { z } from "zod";
import {
  MESSAGE_MAX_LENGTH,
  type ChatMessage,
  type AttachmentView,
} from "@luvora/shared";
import { NotificationType } from "@luvora/shared";
import { Errors } from "../http/errors";
import * as chatRepo from "./chatRepository";
import * as mediaRepo from "../media/mediaRepository";
import { toAttachmentView } from "../media/mediaService";
import * as notifications from "../notifications/notificationService";
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
  // Body is optional when the message carries attachments.
  body: z.string().optional().default(""),
  clientMessageId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).optional(),
});

function toChatMessage(
  row: chatRepo.MessageRow,
  attachments: AttachmentView[] = [],
): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.body,
    clientMessageId: row.client_message_id,
    createdAt: row.created_at,
    attachments,
  };
}

/**
 * Validate a message body. A message must have EITHER non-empty text OR at
 * least one attachment. When text is present it is trimmed and length-checked
 * (Unicode code points). Returns the normalized body (may be "" if attachments
 * carry the message).
 */
export function validateBody(raw: unknown, hasAttachments = false): string {
  const str = typeof raw === "string" ? raw : "";
  const trimmed = str.trim();
  if (trimmed.length === 0) {
    if (hasAttachments) return ""; // attachment-only message is allowed
    throw Errors.messageEmpty();
  }
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
  attachmentIds?: string[];
}

export interface CreateMessageResult {
  message: ChatMessage;
  context: ChatContext;
}

/** Serialize the attachments for a single message id (safe DTOs, in order). */
async function loadAttachmentViews(messageId: string): Promise<AttachmentView[]> {
  const rows = await mediaRepo.listAttachmentsForMessages([messageId]);
  return rows.map(toAttachmentView);
}

/**
 * The single authoritative message-creation path. Authorizes, validates,
 * persists (message + attachments transactionally), and returns the canonical
 * message. The sender id is ALWAYS the authenticated user — any client-supplied
 * sender/owner id is ignored. Attachment ownership, READY+APPROVED state, and
 * limits are enforced inside the same transaction.
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

  const attachmentIds = input.attachmentIds ?? [];
  const body = validateBody(input.body, attachmentIds.length > 0);

  const row = await chatRepo.insertMessageWithAttachments({
    conversationId: context.conversationId,
    senderId: input.authenticatedUserId, // authoritative identity
    body,
    clientMessageId: input.clientMessageId ?? null,
    attachmentIds,
  });

  const attachments = await loadAttachmentViews(row.id);

  // Notify the RECIPIENT (never the sender). The notification references the
  // conversation only — it never carries the message body (privacy). Deduped
  // per (message, recipient) so an idempotent resend doesn't double-notify.
  await notifications.create({
    userId: context.partnerId,
    type: NotificationType.MESSAGE_RECEIVED,
    title: "New message",
    body: "You have a new message.",
    entityType: "conversation",
    entityId: context.conversationId,
    dedupeKey: `message:${row.id}:received:${context.partnerId}`,
  });

  return { message: toChatMessage(row, attachments), context };
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

  // Present oldest→newest. Batch-load attachments for the whole page (no N+1).
  const ordered = [...rowsDesc].reverse();
  const attachmentRows = await mediaRepo.listAttachmentsForMessages(
    ordered.map((m) => m.id),
  );
  const byMessage = new Map<string, AttachmentView[]>();
  for (const r of attachmentRows) {
    const list = byMessage.get(r.message_id) ?? [];
    list.push(toAttachmentView(r));
    byMessage.set(r.message_id, list);
  }
  const messages = ordered.map((m) => toChatMessage(m, byMessage.get(m.id) ?? []));
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

// ---- Inbox contract (Increment 15) ----

export interface ReadResult {
  conversationId: string;
  /** The message the caller's read marker now points at (null if no messages). */
  lastReadMessageId: string | null;
  /** The caller's unread count after reading (always 0 on success). */
  unreadCount: number;
  /** The other participant, so the caller/gateway can emit a read receipt. */
  partnerId: string;
}

/**
 * REST read-receipt: mark the WHOLE conversation read for the caller, advancing
 * their read marker to the newest message. Reuses the SAME read-state model and
 * authorization as the WebSocket `message.read` handler, so REST and WS never
 * diverge. Idempotent: repeated calls are safe and leave unread at 0.
 *
 * Authorization: the caller must be an eligible participant (ACTIVE match, no
 * block) — enforced by authorizeByConversation. A user can therefore never mark
 * another user's conversation read.
 */
export async function readConversation(input: {
  authenticatedUserId: string;
  conversationId: string;
}): Promise<ReadResult> {
  const context = await authorizeByConversation(
    input.authenticatedUserId,
    input.conversationId,
  );
  const { lastReadMessageId } = await chatRepo.markConversationRead({
    conversationId: context.conversationId,
    userId: input.authenticatedUserId,
  });
  return {
    conversationId: context.conversationId,
    lastReadMessageId,
    unreadCount: 0,
    partnerId: context.partnerId,
  };
}

/** The caller's unread count for a single conversation (authorized). */
export async function conversationUnreadCount(input: {
  authenticatedUserId: string;
  conversationId: string;
}): Promise<{ conversationId: string; unreadCount: number }> {
  const context = await authorizeByConversation(
    input.authenticatedUserId,
    input.conversationId,
  );
  const unreadCount = await chatRepo.unreadCountForConversation({
    conversationId: context.conversationId,
    viewerId: input.authenticatedUserId,
  });
  return { conversationId: context.conversationId, unreadCount };
}
