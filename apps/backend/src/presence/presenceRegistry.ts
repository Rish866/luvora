/**
 * Process-local presence registry (Increment 7).
 *
 * Aggregates authenticated socket connections across ALL channels (/ws/chat and
 * /ws/game) by user, so a user is ONLINE while they hold ANY relevant socket
 * and only OFFLINE when their FINAL socket closes. Both gateways call
 * connect()/disconnect() on their connection lifecycle.
 *
 * LIMITATION: this is per-process. With multiple backend instances, presence
 * would require a shared store/pub-sub (e.g. Redis). The abstraction (a single
 * registry both gateways notify) makes that migration localized. The persistent
 * `users.last_seen_at` is written only on the ONLINE→OFFLINE transition to avoid
 * per-heartbeat writes.
 */
export type PresenceTransition = "ONLINE" | "OFFLINE" | "NONE";

type TransitionListener = (userId: string, status: "ONLINE" | "OFFLINE") => void;

export class PresenceRegistry {
  /** userId -> live connection count (never negative). */
  private readonly counts = new Map<string, number>();
  private readonly listeners = new Set<TransitionListener>();

  /** Register a transition observer (e.g. to persist last-seen + emit events). */
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

  /** A socket connected. Returns the transition (ONLINE on 0→1, else NONE). */
  connect(userId: string): PresenceTransition {
    const prev = this.counts.get(userId) ?? 0;
    this.counts.set(userId, prev + 1);
    if (prev === 0) {
      this.notify(userId, "ONLINE");
      return "ONLINE";
    }
    return "NONE";
  }

  /** A socket disconnected. Returns the transition (OFFLINE on 1→0, else NONE).
   *  Guards against going negative (double-disconnect / unknown socket). */
  disconnect(userId: string): PresenceTransition {
    const prev = this.counts.get(userId) ?? 0;
    if (prev <= 0) {
      this.counts.delete(userId);
      return "NONE";
    }
    const next = prev - 1;
    if (next === 0) {
      this.counts.delete(userId);
      this.notify(userId, "OFFLINE");
      return "OFFLINE";
    }
    this.counts.set(userId, next);
    return "NONE";
  }

  isOnline(userId: string): boolean {
    return (this.counts.get(userId) ?? 0) > 0;
  }

  /** Diagnostics only — not exposed via any API. */
  onlineUserCount(): number {
    return this.counts.size;
  }

  /** Test helper: reset all state. */
  reset(): void {
    this.counts.clear();
  }
}

/** Shared singleton presence registry for the process. */
export const presenceRegistry = new PresenceRegistry();
