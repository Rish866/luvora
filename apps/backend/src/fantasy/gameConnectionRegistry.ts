import type { WebSocket } from "ws";
import type { ServerGameEvent } from "@luvora/shared";

/**
 * Process-local registry for gameplay WebSocket connections, keyed by the
 * server-verified authenticated user id. Mirrors the chat ConnectionHub but is
 * typed to the game protocol and kept separate so the two channels don't share
 * mutable state. Same multi-instance limitation applies (process-local).
 */
export class GameConnectionHub {
  private readonly userSockets = new Map<string, Set<WebSocket>>();

  add(userId: string, socket: WebSocket): void {
    let set = this.userSockets.get(userId);
    if (!set) {
      set = new Set();
      this.userSockets.set(userId, set);
    }
    set.add(socket);
  }

  remove(userId: string, socket: WebSocket): void {
    const set = this.userSockets.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.userSockets.delete(userId);
  }

  socketsFor(userId: string): WebSocket[] {
    return [...(this.userSockets.get(userId) ?? [])];
  }

  sendToUser(userId: string, event: ServerGameEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.socketsFor(userId)) safeSend(socket, payload);
  }

  /** Deliver to every socket of each listed participant (deduplicated). */
  broadcastToUsers(userIds: string[], event: ServerGameEvent): void {
    const payload = JSON.stringify(event);
    const seen = new Set<string>();
    for (const userId of userIds) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      for (const socket of this.socketsFor(userId)) safeSend(socket, payload);
    }
  }

  socketCount(): number {
    let n = 0;
    for (const set of this.userSockets.values()) n += set.size;
    return n;
  }

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

const WS_OPEN = 1;
function safeSend(socket: WebSocket, payload: string): void {
  try {
    if (socket.readyState === WS_OPEN) socket.send(payload);
  } catch {
    /* ignore dead socket */
  }
}

export const gameHub = new GameConnectionHub();
