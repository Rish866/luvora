import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  ChatCloseCodes,
  type ServerChatEvent,
} from "@luvora/shared";
import { logger } from "../logger";
import { config } from "../config";
import { AppError, Errors } from "../http/errors";
import { hub } from "./connectionRegistry";
import { clientChatEventSchema } from "./chatEventSchemas";
import * as chat from "./chatService";
import type { WsChannel, WsDispatcher } from "../ws/wsDispatcher";

/**
 * WebSocket chat gateway. Runs on the SAME HTTP server as the REST API (shared
 * port). Authentication happens during the HTTP upgrade using the existing
 * access-token verification; unauthenticated upgrades are rejected before a
 * WebSocket is established.
 */

interface SocketState {
  userId: string;
  isAlive: boolean;
  /** Timestamps of recent inbound events for a simple per-connection throttle. */
  recent: number[];
}

const HEARTBEAT_INTERVAL_MS = 30_000;
// Per-connection inbound event throttle (sliding window).
const WS_RATE_WINDOW_MS = 10_000;
const WS_RATE_MAX = 50;

// Associate per-socket state without leaking it into the registry.
const stateBySocket = new WeakMap<WebSocket, SocketState>();

function send(socket: WebSocket, event: ServerChatEvent): void {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  } catch {
    /* ignore */
  }
}

function sendError(
  socket: WebSocket,
  code: string,
  message: string,
  clientMessageId?: string,
): void {
  send(socket, { type: "error", code, message, ...(clientMessageId ? { clientMessageId } : {}) });
}

/** Simple sliding-window per-connection throttle. Returns true if allowed. */
function allowEvent(state: SocketState): boolean {
  if (!config.rateLimitEnabled) return true;
  const now = Date.now();
  state.recent = state.recent.filter((t) => now - t < WS_RATE_WINDOW_MS);
  if (state.recent.length >= WS_RATE_MAX) return false;
  state.recent.push(now);
  return true;
}

async function handleEvent(
  socket: WebSocket,
  state: SocketState,
  raw: unknown,
): Promise<void> {
  const parsed = clientChatEventSchema.safeParse(raw);
  if (!parsed.success) {
    sendError(
      socket,
      "INVALID_WEBSOCKET_MESSAGE",
      "Invalid or unsupported event.",
    );
    return;
  }
  const event = parsed.data;
  const userId = state.userId;

  try {
    switch (event.type) {
      case "message.send": {
        const { message, context } = await chat.createMessage({
          authenticatedUserId: userId, // authoritative; client senderId ignored
          conversationId: event.conversationId,
          body: event.body,
          clientMessageId: event.clientMessageId ?? null,
          attachmentIds: event.attachmentIds,
        });
        // Persisted first, THEN broadcast to both participants' sockets.
        hub.broadcastToUsers([context.userId, context.partnerId], {
          type: "message.created",
          message,
        });
        break;
      }
      case "message.read": {
        const result = await chat.markRead({
          authenticatedUserId: userId,
          conversationId: event.conversationId,
          messageId: event.messageId,
        });
        // Notify the partner that this user read up to messageId.
        hub.sendToUser(result.context.partnerId, {
          type: "message.read",
          conversationId: result.conversationId,
          messageId: result.messageId,
          userId,
        });
        break;
      }
      case "typing.start":
      case "typing.stop": {
        const context = await chat.authorizeEphemeral(
          userId,
          event.conversationId,
        );
        hub.sendToUser(context.partnerId, {
          type: "typing",
          conversationId: context.conversationId,
          userId,
          state: event.type === "typing.start" ? "start" : "stop",
        });
        break;
      }
    }
  } catch (err) {
    if (err instanceof AppError) {
      sendError(socket, err.code, err.message);
    } else {
      logger.error({ err }, "websocket event handling error");
      const internal = Errors.internal();
      sendError(socket, internal.code, internal.message);
    }
  }
}

/** Notify a user's sockets that a conversation became blocked, so stale
 *  connections stop using it. Called when a block invalidates a match. */
export function notifyConversationBlocked(
  userIds: string[],
  conversationId: string,
): void {
  hub.broadcastToUsers(userIds, { type: "chat.blocked", conversationId });
}

/** Emit presence to the partner on a conversation's two sockets. We only emit
 *  presence to the matched partner (never globally). */
function emitPresenceToPartner(
  partnerId: string,
  conversationId: string,
  userId: string,
  stateName: "online" | "offline",
): void {
  hub.sendToUser(partnerId, {
    type: "presence",
    conversationId,
    userId,
    state: stateName,
  });
}

export interface ChatGateway {
  wss: WebSocketServer;
  close(): Promise<void>;
}

/** Register the chat channel ("/ws/chat") on the shared WS dispatcher. */
export function attachChatGateway(dispatcher: WsDispatcher): ChatGateway {
  const wss = new WebSocketServer({ noServer: true });

  const onConnection: WsChannel["onConnection"] = (socket, _req, userId) => {
    const state: SocketState = { userId, isAlive: true, recent: [] };
    stateBySocket.set(socket, state);

    hub.add(userId, socket);
    logger.info({ userId, sockets: hub.socketCount() }, "chat ws established");

    send(socket, { type: "connection.ready", userId });

    socket.on("pong", () => {
      state.isAlive = true;
    });

    socket.on("message", (data) => {
      if (!allowEvent(state)) {
        sendError(socket, "RATE_LIMITED", "Too many messages. Slow down.");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        sendError(socket, "INVALID_WEBSOCKET_MESSAGE", "Malformed JSON.");
        return;
      }
      void handleEvent(socket, state, parsed);
    });

    socket.on("close", () => {
      hub.remove(userId, socket);
      stateBySocket.delete(socket);
      logger.info({ userId, sockets: hub.socketCount() }, "chat ws closed");
      void emitPresenceToPartner; // reserved for subscription-based presence
    });

    socket.on("error", (err) => {
      logger.warn({ err: err.message }, "chat ws error");
      try {
        socket.close(ChatCloseCodes.INTERNAL);
      } catch {
        /* ignore */
      }
    });
  };

  // Heartbeat: terminate sockets that stop responding to pings.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const state = stateBySocket.get(socket);
      if (!state) continue;
      if (!state.isAlive) {
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      state.isAlive = false;
      try {
        socket.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  dispatcher.register({ path: "/ws/chat", wss, onConnection });

  return {
    wss,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        hub.closeAll();
        wss.close(() => resolve());
      }),
  };
}
