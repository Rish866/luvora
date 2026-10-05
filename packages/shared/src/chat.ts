/**
 * Private chat + WebSocket protocol (Increment 3).
 *
 * These types are the single source of truth for the realtime protocol shared
 * between the backend and future clients. Both directions use discriminated
 * unions keyed on `type`; the server validates every inbound event against
 * these shapes and rejects anything else.
 */

/** Server-side maximum message size, in Unicode code points. */
export const MESSAGE_MAX_LENGTH = 4000;

import type { AttachmentView } from "./media";

/** A persisted chat message as exposed to clients (safe fields only). */
export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  /** Echo of the client idempotency key, if one was supplied. */
  clientMessageId: string | null;
  createdAt: string;
  /** Safe attachment DTOs (Increment 5). Empty when the message has none. */
  attachments: AttachmentView[];
}

// ---------------------------------------------------------------------------
// Client -> Server events
// ---------------------------------------------------------------------------

export interface MessageSendEvent {
  type: "message.send";
  conversationId: string;
  /** Optional when attachments are present. */
  body?: string;
  /** Optional idempotency key (UUID). Never becomes the authoritative id. */
  clientMessageId?: string;
  /** Optional attachment media ids owned by the sender (Increment 5). */
  attachmentIds?: string[];
}

export interface MessageReadEvent {
  type: "message.read";
  conversationId: string;
  messageId: string;
}

export interface TypingStartEvent {
  type: "typing.start";
  conversationId: string;
}

export interface TypingStopEvent {
  type: "typing.stop";
  conversationId: string;
}

export type ClientChatEvent =
  | MessageSendEvent
  | MessageReadEvent
  | TypingStartEvent
  | TypingStopEvent;

export type ClientChatEventType = ClientChatEvent["type"];

// ---------------------------------------------------------------------------
// Server -> Client events
// ---------------------------------------------------------------------------

export interface ConnectionReadyServerEvent {
  type: "connection.ready";
  userId: string;
}

export interface MessageCreatedServerEvent {
  type: "message.created";
  message: ChatMessage;
}

export interface MessageReadServerEvent {
  type: "message.read";
  conversationId: string;
  messageId: string;
  /** The user who read — always the authenticated identity, never client input. */
  userId: string;
}

export interface TypingServerEvent {
  type: "typing";
  conversationId: string;
  userId: string;
  state: "start" | "stop";
}

export interface PresenceServerEvent {
  type: "presence";
  conversationId: string;
  userId: string;
  state: "online" | "offline";
}

/** Sent when a conversation becomes unavailable to this connection (e.g. a
 *  block invalidated the match). Clients should stop using it. */
export interface ChatBlockedServerEvent {
  type: "chat.blocked";
  conversationId: string;
}

export interface ChatErrorServerEvent {
  type: "error";
  code: string;
  message: string;
  /** Correlates the error with the client event that caused it, when known. */
  clientMessageId?: string;
}

export type ServerChatEvent =
  | ConnectionReadyServerEvent
  | MessageCreatedServerEvent
  | MessageReadServerEvent
  | TypingServerEvent
  | PresenceServerEvent
  | ChatBlockedServerEvent
  | ChatErrorServerEvent;

export type ServerChatEventType = ServerChatEvent["type"];

/** WebSocket close codes used by the realtime gateways (application range
 *  4000+). Shared by the chat and fantasy-game channels. */
export const ChatCloseCodes = {
  UNAUTHENTICATED: 4401,
  ACCOUNT_NOT_ACTIVE: 4403,
  /** The user already has the maximum number of concurrent connections. */
  TOO_MANY_CONNECTIONS: 4429,
  INTERNAL: 4500,
} as const;
