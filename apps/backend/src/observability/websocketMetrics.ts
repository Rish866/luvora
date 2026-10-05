import { metrics } from "./metrics";
import { hub } from "../chat/connectionRegistry";
import { gameHub } from "../fantasy/gameConnectionRegistry";

/**
 * WebSocket metrics helpers (Increment 10). Channel labels are a BOUNDED set
 * ("chat" | "game"); close codes are normalized to a bounded set so an attacker
 * can't explode cardinality via arbitrary close reasons. Never records tokens
 * (WS URLs may carry ?access_token — we only ever label by channel/event/code).
 */
export type WsChannelLabel = "chat" | "game";

/** Known close-code buckets (keeps cardinality bounded). */
function closeCodeLabel(code: number | undefined): string {
  if (code === undefined) return "unknown";
  // Only a small allow-list of codes we actually emit / care about.
  switch (code) {
    case 1000:
      return "1000"; // normal
    case 1001:
      return "1001"; // going away / shutdown
    case 4403:
      return "4403"; // account not active
    case 4500:
      return "4500"; // internal
    default:
      // Bucket everything else coarsely.
      if (code >= 4000) return "4xxx";
      if (code >= 1000) return "1xxx";
      return "other";
  }
}

export function recordWsConnection(channel: WsChannelLabel): void {
  try {
    metrics.incr("websocket_connections_total", { channel });
  } catch {
    /* best-effort */
  }
}

export function recordWsDisconnect(channel: WsChannelLabel, code?: number): void {
  try {
    metrics.incr("websocket_disconnects_total", { channel, code: closeCodeLabel(code) });
  } catch {
    /* best-effort */
  }
}

export function recordWsMessage(channel: WsChannelLabel): void {
  try {
    metrics.incr("websocket_messages_total", { channel });
  } catch {
    /* best-effort */
  }
}

export function recordWsError(channel: WsChannelLabel): void {
  try {
    metrics.incr("websocket_errors_total", { channel });
  } catch {
    /* best-effort */
  }
}

/** A connection was refused because the user exceeded the per-user cap. */
export function recordWsConnectionRejected(channel: WsChannelLabel, reason: string): void {
  try {
    metrics.incr("ws_connections_rejected_total", { channel, reason });
  } catch {
    /* best-effort */
  }
}

/** An inbound event was dropped by the per-connection rate throttle. */
export function recordWsEventRejected(channel: WsChannelLabel): void {
  try {
    metrics.incr("ws_events_rejected_total", { channel });
  } catch {
    /* best-effort */
  }
}

/** Current active connections across both channels (gauge-style snapshot for
 *  health/diagnostics; derived from the live registries, not a counter). */
export function activeWebsocketConnections(): { chat: number; game: number; total: number } {
  const chat = hub.socketCount();
  const game = gameHub.socketCount();
  return { chat, game, total: chat + game };
}
