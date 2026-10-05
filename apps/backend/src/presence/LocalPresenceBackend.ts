import type {
  PresenceBackend,
  PresenceTransition,
  TransitionListener,
} from "./PresenceBackend";

/**
 * Process-local presence backend (the default). Replaces the Increment 7
 * PresenceRegistry while preserving its exact ONLINE/OFFLINE semantics, and adds
 * a heartbeat/TTL model so a connection that disappears WITHOUT a clean
 * disconnect (process crash, dropped socket) is eventually reclaimed.
 *
 * State: per user, a map of connectionId → lastSeen(ms). A user is ONLINE while
 * they hold ANY live connection across BOTH channels, and OFFLINE only when the
 * final one is removed (by explicit disconnect OR TTL reap).
 *
 * LIMITATION: per-process only. A multi-instance deployment needs a shared
 * store/pub-sub (e.g. Redis); the DistributedPresenceBackend placeholder marks
 * where that plugs in. The persistent `users.last_seen_at` is written only on
 * the ONLINE→OFFLINE transition (handled by the presence service listener).
 */
export class LocalPresenceBackend implements PresenceBackend {
  /** userId → (connectionId → lastHeartbeat ms). */
  private readonly conns = new Map<string, Map<string, number>>();
  private readonly listeners = new Set<TransitionListener>();

  constructor(private readonly ttlMs: number) {}

  onTransition(listener: TransitionListener): void {
    this.listeners.add(listener);
  }

  private notify(userId: string, status: "ONLINE" | "OFFLINE"): void {
    for (const l of this.listeners) {
      try {
        l(userId, status);
      } catch {
        /* a listener must never break presence accounting */
      }
    }
  }

  connect(userId: string, connectionId: string): PresenceTransition {
    let set = this.conns.get(userId);
    const wasEmpty = !set || set.size === 0;
    if (!set) {
      set = new Map();
      this.conns.set(userId, set);
    }
    set.set(connectionId, Date.now());
    if (wasEmpty) {
      this.notify(userId, "ONLINE");
      return "ONLINE";
    }
    return "NONE";
  }

  disconnect(userId: string, connectionId: string): PresenceTransition {
    const set = this.conns.get(userId);
    if (!set) return "NONE";
    const had = set.delete(connectionId);
    if (set.size === 0) {
      this.conns.delete(userId);
      if (had) {
        this.notify(userId, "OFFLINE");
        return "OFFLINE";
      }
    }
    return "NONE";
  }

  heartbeat(userId: string, connectionId: string): void {
    const set = this.conns.get(userId);
    if (set && set.has(connectionId)) set.set(connectionId, Date.now());
  }

  reapExpired(now = Date.now()): string[] {
    const wentOffline: string[] = [];
    for (const [userId, set] of this.conns) {
      for (const [connId, lastSeen] of set) {
        if (now - lastSeen > this.ttlMs) set.delete(connId);
      }
      if (set.size === 0) {
        this.conns.delete(userId);
        this.notify(userId, "OFFLINE");
        wentOffline.push(userId);
      }
    }
    return wentOffline;
  }

  isOnline(userId: string): boolean {
    const set = this.conns.get(userId);
    return !!set && set.size > 0;
  }

  onlineUserCount(): number {
    return this.conns.size;
  }

  reset(): void {
    this.conns.clear();
  }
}
