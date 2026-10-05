import { WebSocketServer, WebSocket } from "ws";
import { type ServerGameEvent } from "@luvora/shared";
import { logger } from "../logger";
import { config } from "../config";
import { AppError, Errors } from "../http/errors";
import { gameHub } from "./gameConnectionRegistry";
import { clientGameEventSchema } from "./gameEventSchemas";
import * as gameplay from "./gameplayService";
import type { WsChannel, WsDispatcher } from "../ws/wsDispatcher";

/**
 * Gameplay WebSocket gateway (channel "/ws/game"). Server-authoritative:
 *  - `game.subscribe` returns the authoritative DB state (reconnect-safe).
 *  - `game.choose` runs the transactional/idempotent engine, then broadcasts
 *    the resulting state to BOTH participants (persist-then-broadcast).
 * Client-supplied ids are never trusted for authorization; the connection's
 * verified userId is used.
 */

interface SocketState {
  userId: string;
  isAlive: boolean;
  recent: number[];
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_RATE_WINDOW_MS = 10_000;
const WS_RATE_MAX = 50;

const stateBySocket = new WeakMap<WebSocket, SocketState>();

function send(socket: WebSocket, event: ServerGameEvent): void {
  try {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  } catch {
    /* ignore */
  }
}

function sendError(
  socket: WebSocket,
  code: string,
  message: string,
  clientActionId?: string,
): void {
  send(socket, {
    type: "game.error",
    code,
    message,
    ...(clientActionId ? { clientActionId } : {}),
  });
}

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
  const parsed = clientGameEventSchema.safeParse(raw);
  if (!parsed.success) {
    sendError(socket, "INVALID_WEBSOCKET_MESSAGE", "Invalid or unsupported event.");
    return;
  }
  const event = parsed.data;
  const userId = state.userId;

  try {
    switch (event.type) {
      case "game.subscribe": {
        // Authoritative current state from the DB (reconnect-safe).
        const gameState = await gameplay.getState(event.sessionId, userId);
        send(socket, { type: "game.state", state: gameState });
        break;
      }
      case "game.choose": {
        const result = await gameplay.choose(
          event.sessionId,
          userId,
          event.choiceId,
          event.clientActionId,
        );
        // Persist-then-broadcast: deliver the new authoritative state to both
        // participants' sockets.
        const serverEvent: ServerGameEvent = result.completed
          ? { type: "game.completed", state: result.state }
          : { type: "game.state.changed", state: result.state };
        gameHub.broadcastToUsers(result.participants, serverEvent);
        break;
      }
    }
  } catch (err) {
    const clientActionId =
      parsed.success && parsed.data.type === "game.choose"
        ? parsed.data.clientActionId
        : undefined;
    if (err instanceof AppError) {
      sendError(socket, err.code, err.message, clientActionId);
    } else {
      logger.error({ err }, "game ws event error");
      const internal = Errors.internal();
      sendError(socket, internal.code, internal.message, clientActionId);
    }
  }
}

export interface GameGateway {
  wss: WebSocketServer;
  close(): Promise<void>;
}

/** Register the gameplay channel ("/ws/game") on the shared WS dispatcher. */
export function attachGameGateway(dispatcher: WsDispatcher): GameGateway {
  const wss = new WebSocketServer({ noServer: true });

  const onConnection: WsChannel["onConnection"] = (socket, _req, userId) => {
    const state: SocketState = { userId, isAlive: true, recent: [] };
    stateBySocket.set(socket, state);
    gameHub.add(userId, socket);
    logger.info({ userId, sockets: gameHub.socketCount() }, "game ws established");

    send(socket, { type: "game.ready", userId });

    socket.on("pong", () => {
      state.isAlive = true;
    });

    socket.on("message", (data) => {
      if (!allowEvent(state)) {
        sendError(socket, "RATE_LIMITED", "Too many actions. Slow down.");
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
      gameHub.remove(userId, socket);
      stateBySocket.delete(socket);
      logger.info({ userId, sockets: gameHub.socketCount() }, "game ws closed");
    });

    socket.on("error", (err) => {
      logger.warn({ err: err.message }, "game ws error");
      try {
        socket.close(4500);
      } catch {
        /* ignore */
      }
    });
  };

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const st = stateBySocket.get(socket);
      if (!st) continue;
      if (!st.isAlive) {
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      st.isAlive = false;
      try {
        socket.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  dispatcher.register({ path: "/ws/game", wss, onConnection });

  return {
    wss,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        gameHub.closeAll();
        wss.close(() => resolve());
      }),
  };
}
