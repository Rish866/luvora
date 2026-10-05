import type { WebSocket } from "ws";
import type { ServerChatEvent } from "@luvora/shared";

/**
 * Process-local WebSocket connection registry.
 *
 * Keys are ALWAYS the server-verified authenticated user id (never a
 * client-provided id). A user may hold multiple concurrent sockets (phone,
 * browser, tablet); all are tracked so a message reaches every authorized
 * connection.
 *
 * LIMITATION: this state is per-process. In a multi-instance deployment,
 * presence and real-time delivery would need a shared pub/sub (e.g. Redis).
 * That is intentionally deferred (see docs/INCREMENTS.md Increment 8).
 */
export class ConnectionHub {
  private readonly userSockets = new Map<string, Set<WebSocket>>();

  /** Register a socket for a user. Returns true if this is the user's first
   *  socket (i.e. a 0→1 transition, meaning they just came online). */
  add(userId: string, socket: WebSocket): boolean {
    let set = this.userSockets.get(userId);
    const wasEmpty = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.userSockets.set(userId, set);
    }
    set.add(socket);
    return wasEmpty;
  }

  /** Remove a socket. Returns true if the user has no sockets left (1→0
   *  transition, meaning they just went offline). */
  remove(userId: string, socket: WebSocket): boolean {
    const set = this.userSockets.get(userId);
    if (!set) return false;
    set.delete(socket);
    if (set.size === 0) {
      this.userSockets.delete(userId);
      return true;
    }
    return false;
  }

  isOnline(userId: string): boolean {
    const set = this.userSockets.get(userId);
    return !!set && set.size > 0;
  }

  socketsFor(userId: string): WebSocket[] {
    return [...(this.userSockets.get(userId) ?? [])];
  }

  /** Send an event to every socket of a single user. */
  sendToUser(userId: string, event: ServerChatEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.socketsFor(userId)) {
      safeSend(socket, payload);
    }
  }

  /** Send an event to every socket of each listed user (deduplicated). */
  broadcastToUsers(userIds: string[], event: ServerChatEvent): void {
    const payload = JSON.stringify(event);
    const seen = new Set<string>();
    for (const userId of userIds) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      for (const socket of this.socketsFor(userId)) {
        safeSend(socket, payload);
      }
    }
  }

  /** Total number of tracked sockets (for diagnostics/health). */
  socketCount(): number {
    let n = 0;
    for (const set of this.userSockets.values()) n += set.size;
    return n;
  }

  /** Close and drop all sockets for a single user (used on suspend/deactivate).
   *  Returns the number of sockets closed. */
  closeUser(userId: string, code = 4403, reason = "account suspended"): number {
    const set = this.userSockets.get(userId);
    if (!set) return 0;
    let n = 0;
    for (const socket of [...set]) {
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
      n += 1;
    }
    this.userSockets.delete(userId);
    return n;
  }

  /** Close and drop all sockets (used on graceful shutdown). */
  closeAll(code = 1001, reason = "server shutting down"): void {
    for (const set of this.userSockets.values()) {
      for (const socket of set) {
        try {
          socket.close(code, reason);
        } catch {
          /* ignore */
        }
      }
    }
    this.userSockets.clear();
  }
}

/** OPEN readyState constant without importing the enum at module load. */
const WS_OPEN = 1;

function safeSend(socket: WebSocket, payload: string): void {
  try {
    if (socket.readyState === WS_OPEN) {
      socket.send(payload);
    }
  } catch {
    /* never let a dead socket break a broadcast */
  }
}

/** Shared singleton hub for the process. */
export const hub = new ConnectionHub();
