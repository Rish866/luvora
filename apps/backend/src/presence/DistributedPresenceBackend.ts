import type {
  PresenceBackend,
  PresenceTransition,
  TransitionListener,
} from "./PresenceBackend";
import { LocalPresenceBackend } from "./LocalPresenceBackend";
import { logger } from "../logger";

/**
 * Distributed presence backend — ARCHITECTURAL PLACEHOLDER (Increment 8).
 *
 * This marks exactly where a shared-store presence implementation (e.g. Redis)
 * would live so that presence is consistent across multiple backend instances.
 * It is NOT a working distributed implementation: there is no Redis dependency,
 * no network client, and no cross-instance pub/sub here.
 *
 * Intended production design (documented, not implemented):
 *   - Each connection writes a key `presence:{userId}:{connectionId}` with a
 *     TTL ~= PRESENCE_TTL_SECONDS, refreshed on every heartbeat.
 *   - `isOnline` = any key under `presence:{userId}:*` exists.
 *   - ONLINE/OFFLINE transitions are published on a channel so other instances
 *     can fan out `presence.changed` to their locally-connected observers.
 *   - Key expiry (TTL) reclaims presence when a process crashes without a clean
 *     disconnect — no central reaper required.
 *
 * Until that is built, selecting PRESENCE_BACKEND=distributed WITHOUT a wired
 * client degrades safely to the in-process LocalPresenceBackend (single-instance
 * correctness preserved) and logs a clear warning. Redis is NEVER a mandatory
 * dependency and is NOT required for tests.
 */
export class DistributedPresenceBackend implements PresenceBackend {
  private readonly delegate: LocalPresenceBackend;

  constructor(ttlMs: number, redisUrl: string) {
    this.delegate = new LocalPresenceBackend(ttlMs);
    if (!redisUrl) {
      logger.warn(
        "PRESENCE_BACKEND=distributed selected but REDIS_URL is empty and no " +
          "shared-store client is wired; falling back to process-local presence " +
          "(single-instance only).",
      );
    } else {
      logger.warn(
        "PRESENCE_BACKEND=distributed is an architectural placeholder; the Redis " +
          "integration is not implemented. Using process-local presence.",
      );
    }
  }

  connect(userId: string, connectionId: string): PresenceTransition {
    return this.delegate.connect(userId, connectionId);
  }
  disconnect(userId: string, connectionId: string): PresenceTransition {
    return this.delegate.disconnect(userId, connectionId);
  }
  heartbeat(userId: string, connectionId: string): void {
    this.delegate.heartbeat(userId, connectionId);
  }
  reapExpired(now?: number): string[] {
    return this.delegate.reapExpired(now);
  }
  isOnline(userId: string): boolean {
    return this.delegate.isOnline(userId);
  }
  onTransition(listener: TransitionListener): void {
    this.delegate.onTransition(listener);
  }
  onlineUserCount(): number {
    return this.delegate.onlineUserCount();
  }
  reset(): void {
    this.delegate.reset();
  }
}
