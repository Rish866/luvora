import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
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
import { isAccountActive } from "../auth/accountState";
import { presenceRegistry } from "../presence/presenceRegistry";
import {
  recordWsConnection,
  recordWsDisconnect,
  recordWsMessage,
  recordWsError,
  recordWsConnectionRejected,
  recordWsEventRejected,
} from "../observability/websocketMetrics";
import type { WsChannel, WsDispatcher } from "../ws/wsDispatcher";

/**
 * WebSocket chat gateway. Runs on the SAME HTTP server as the REST API (shared
 * port). Authentication happens during the HTTP upgrade using the existing
 * access-token verification; unauthenticated upgrades are rejected before a
 * WebSocket is established.
 */

interface SocketState {
  userId: string;
  /** Per-socket id for presence ref-counting across channels. */
  connectionId: string;
  isAlive: boolean;
  /** Timestamps of recent inbound events for a simple per-connection throttle. */
  recent: number[];
}

// Ping frequently enough that a healthy socket refreshes its presence TTL well
// before it lapses (ping interval ≈ half the presence heartbeat, min 5s). A
// pong refreshes the TTL; several missed pongs within the TTL window trigger a
// reap. Bounded so a very short configured TTL still pings sanely.
const HEARTBEAT_INTERVAL_MS = Math.max(
  5_000,
  Math.floor((config.presence.heartbeatSeconds * 1000) / 2),
);
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

/** Simple sliding-window per-connection throttle. Returns true if allowed.
 *  Window/limit are configurable (config.security.ws.*); defaults preserve the
 *  previous 50 events / 10s behaviour. Process-local by design. */
function allowEvent(state: SocketState): boolean {
  if (!config.rateLimitEnabled) return true;
  const now = Date.now();
  const windowMs = config.security.ws.eventWindowMs;
  state.recent = state.recent.filter((t) => now - t < windowMs);
  if (state.recent.length >= config.security.ws.eventMax) return false;
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

  // Enforce LIVE account state on every inbound action: a socket authenticated
  // before suspension/deactivation must not keep acting (Increment 6).
  if (!(await isAccountActive(userId))) {
    sendError(socket, "ACCOUNT_SUSPENDED", "Your account is not active.");
    try {
      socket.close(4403, "account not active");
    } catch {
      /* ignore */
    }
    return;
  }

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
  // maxPayload caps inbound frame size; `ws` closes oversized frames (1009).
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.security.ws.maxFrameBytes,
  });

  const onConnection: WsChannel["onConnection"] = (socket, _req, userId) => {
    // Per-user concurrent-connection cap (resource-exhaustion defence). The
    // socket already exists post-handshake, so we refuse by closing it.
    if (hub.socketsFor(userId).length >= config.security.ws.maxConnectionsPerUser) {
      recordWsConnectionRejected("chat", "too_many_connections");
      try {
        socket.close(ChatCloseCodes.TOO_MANY_CONNECTIONS, "too many connections");
      } catch {
        /* ignore */
      }
      return;
    }

    const connectionId = `chat:${randomUUID()}`;
    const state: SocketState = { userId, connectionId, isAlive: true, recent: [] };
    stateBySocket.set(socket, state);

    hub.add(userId, socket);
    // Presence: count this socket toward the user's cross-channel presence.
    presenceRegistry.connect(userId, connectionId);
    recordWsConnection("chat");
    logger.info({ userId, sockets: hub.socketCount() }, "chat ws established");

    send(socket, { type: "connection.ready", userId });

    socket.on("pong", () => {
      state.isAlive = true;
      // A live pong refreshes the presence TTL so a healthy connection is never
      // reaped as stale.
      presenceRegistry.heartbeat(userId, connectionId);
    });

    socket.on("message", (data) => {
      // Any inbound activity also counts as a heartbeat for presence TTL.
      presenceRegistry.heartbeat(userId, connectionId);
      recordWsMessage("chat");
      if (!allowEvent(state)) {
        recordWsEventRejected("chat");
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

    socket.on("close", (code) => {
      hub.remove(userId, socket);
      presenceRegistry.disconnect(userId, connectionId);
      stateBySocket.delete(socket);
      recordWsDisconnect("chat", code);
      logger.info({ userId, sockets: hub.socketCount() }, "chat ws closed");
      void emitPresenceToPartner; // reserved for subscription-based presence
    });

    socket.on("error", (err) => {
      recordWsError("chat");
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
