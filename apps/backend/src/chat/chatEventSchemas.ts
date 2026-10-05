import { z } from "zod";

/**
 * Zod schemas for inbound (client → server) WebSocket events. Every incoming
 * frame is parsed and validated against these before any action is taken, so
 * malformed input is rejected with a structured error and never crashes the
 * process or reaches SQL unchecked.
 */

const messageSend = z.object({
  type: z.literal("message.send"),
  conversationId: z.string().uuid(),
  body: z.string().optional(),
  clientMessageId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).optional(),
});

const messageRead = z.object({
  type: z.literal("message.read"),
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
});

const typingStart = z.object({
  type: z.literal("typing.start"),
  conversationId: z.string().uuid(),
});

const typingStop = z.object({
  type: z.literal("typing.stop"),
  conversationId: z.string().uuid(),
});

export const clientChatEventSchema = z.discriminatedUnion("type", [
  messageSend,
  messageRead,
  typingStart,
  typingStop,
]);

export type ParsedClientChatEvent = z.infer<typeof clientChatEventSchema>;
