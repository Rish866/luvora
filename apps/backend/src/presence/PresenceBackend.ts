/**
 * Presence backend abstraction (Increment 8).
 *
 * Increment 7 shipped a single process-local registry. This interface factors
 * out presence state so a DISTRIBUTED backend (e.g. Redis with TTL keys +
 * pub/sub) can be dropped in for horizontal scaling WITHOUT changing the
 * gateways or the presence service. The local implementation
 * (LocalPresenceBackend) remains the default and preserves all Increment 7
 * behaviour exactly.
 *
 * Connections are identified by a per-socket `connectionId` so the backend can
 * ref-count accurately across BOTH WebSocket channels (/ws/chat, /ws/game) and
 * expire stale entries on a heartbeat/TTL model (so a crashed process does not
 * leave a user ONLINE forever).
 */
export type PresenceTransition = "ONLINE" | "OFFLINE" | "NONE";

export type TransitionListener = (
  userId: string,
  status: "ONLINE" | "OFFLINE",
) => void;

export interface PresenceBackend {
  /** A socket connected. Returns the transition (ONLINE on the user's first
   *  connection, else NONE). */
  connect(userId: string, connectionId: string): PresenceTransition;

  /** A socket disconnected. Returns the transition (OFFLINE on the user's last
   *  connection, else NONE). */
  disconnect(userId: string, connectionId: string): PresenceTransition;

  /** Refresh the TTL for a live connection (called on each WS heartbeat). */
  heartbeat(userId: string, connectionId: string): void;

  /** Expire connections whose TTL has lapsed (no heartbeat within the window).
   *  Returns the users who transitioned to OFFLINE as a result. A crashed
   *  process that never sends `disconnect` is reclaimed this way. */
  reapExpired(now?: number): string[];

  isOnline(userId: string): boolean;

  /** Register a transition observer (last-seen persistence + presence.changed). */
  onTransition(listener: TransitionListener): void;

  /** Diagnostics only — never exposed via any API. */
  onlineUserCount(): number;

  /** Test helper: reset all state. */
  reset(): void;
}
