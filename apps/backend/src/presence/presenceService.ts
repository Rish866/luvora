import { PresenceStatus, type PresenceView } from "@luvora/shared";
import { query } from "../db/pool";
import { config } from "../config";
import { Errors } from "../http/errors";
import { logger } from "../logger";
import { presenceRegistry } from "./presenceRegistry";
import { deliverToUser } from "../notifications/realtime";

/**
 * Presence service: privacy-aware visibility + real-time `presence.changed`
 * fan-out to authorized observers.
 *
 * Visibility rule: a user's presence is only visible to users they are matched
 * with (an ACTIVE match) and NOT blocked in either direction — the same
 * relationship the chat system already trusts. Strangers and blocked users
 * never see presence or receive presence events.
 */

/** Users who may observe `userId`'s presence right now: ACTIVE-match partners
 *  with no block in either direction. */
async function authorizedObservers(userId: string): Promise<string[]> {
  const rows = await query<{ other: string }>(
    `SELECT CASE WHEN m.user_a = $1 THEN m.user_b ELSE m.user_a END AS other
       FROM matches m
      WHERE (m.user_a = $1 OR m.user_b = $1)
        AND m.state = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = m.user_a AND b.blocked_id = m.user_b)
              OR (b.blocker_id = m.user_b AND b.blocked_id = m.user_a)
        )`,
    [userId],
  );
  return rows.map((r) => r.other);
}

/** Is `viewer` allowed to see `target`'s presence? (matched + not blocked). */
async function canObserve(viewer: string, target: string): Promise<boolean> {
  if (viewer === target) return true;
  const rows = await query(
    `SELECT 1 FROM matches m
      WHERE m.state = 'ACTIVE'
        AND ((m.user_a = $1 AND m.user_b = $2) OR (m.user_a = $2 AND m.user_b = $1))
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = $2)
              OR (b.blocker_id = $2 AND b.blocked_id = $1)
        )
      LIMIT 1`,
    [viewer, target],
  );
  return rows.length > 0;
}

async function persistLastSeen(userId: string): Promise<string | null> {
  const rows = await query<{ last_seen_at: string }>(
    `UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING last_seen_at`,
    [userId],
  );
  return rows[0]?.last_seen_at ?? null;
}

/**
 * Handle an ONLINE/OFFLINE transition: persist last-seen on OFFLINE, then emit
 * `presence.changed` to the authorized observers who are themselves connected.
 */
async function handleTransition(
  userId: string,
  status: "ONLINE" | "OFFLINE",
): Promise<void> {
  let lastSeenAt: string | null = null;
  if (status === "OFFLINE") {
    lastSeenAt = await persistLastSeen(userId);
  }
  const observers = await authorizedObservers(userId);
  const event =
    status === "ONLINE"
      ? ({ type: "presence.changed", userId, status: PresenceStatus.ONLINE } as const)
      : ({
          type: "presence.changed",
          userId,
          status: PresenceStatus.OFFLINE,
          lastSeenAt,
        } as const);
  for (const observer of observers) {
    deliverToUser(observer, event);
  }
}

/** Register the service as the registry's transition listener. Idempotent. */
let wired = false;
export function initPresence(): void {
  if (wired) return;
  wired = true;
  presenceRegistry.onTransition((userId, status) => {
    void handleTransition(userId, status).catch((err) =>
      logger.warn({ err: (err as Error).message }, "presence transition handling failed"),
    );
  });
  startReaper();
}

/**
 * Periodic TTL reaper: reclaims presence for connections that stopped sending
 * heartbeats (crashed process / dropped socket) so a user is not left ONLINE
 * forever. Transitions flow through the same `onTransition` listener, so a
 * reaped user gets last-seen persistence + a `presence.changed` OFFLINE event.
 *
 * Not started under test (the suite drives presence deterministically and a
 * background timer would introduce flakiness); tests exercise reaping by
 * calling `reapNow()` directly.
 */
let reaper: NodeJS.Timeout | null = null;
function startReaper(): void {
  if (config.isTest) return;
  if (reaper) return;
  const intervalMs = Math.max(1000, config.presence.heartbeatSeconds * 1000);
  reaper = setInterval(() => {
    try {
      presenceRegistry.reapExpired();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "presence reaper failed");
    }
  }, intervalMs);
  reaper.unref();
}

/** Test/ops helper: run one reap pass synchronously. Returns users set OFFLINE. */
export function reapNow(now?: number): string[] {
  return presenceRegistry.reapExpired(now);
}

/** Stop the reaper (graceful shutdown). */
export function stopPresence(): void {
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}

/** Authorized presence lookup for the HTTP API. */
export async function getPresenceFor(
  viewerId: string,
  targetId: string,
): Promise<PresenceView> {
  if (!(await canObserve(viewerId, targetId))) {
    // Do not reveal whether the account exists or is simply not observable.
    throw Errors.presenceNotAuthorized();
  }
  if (presenceRegistry.isOnline(targetId)) {
    return { status: PresenceStatus.ONLINE };
  }
  const rows = await query<{ last_seen_at: string | null }>(
    `SELECT last_seen_at FROM users WHERE id = $1`,
    [targetId],
  );
  return { status: PresenceStatus.OFFLINE, lastSeenAt: rows[0]?.last_seen_at ?? null };
}
