import { randomUUID } from "node:crypto";
import type { ServerRealtimeEvent } from "@luvora/shared";
import { hub } from "../chat/connectionRegistry";
import { gameHub } from "../fantasy/gameConnectionRegistry";
import { getRealtimeBus } from "./bus/realtimeBusProvider";
import type { RealtimeEnvelope } from "./bus/RealtimeBus";

/**
 * Real-time delivery for notification + presence events (Increment 7, extended
 * for cross-instance delivery in Increment 8).
 *
 * These events are user-scoped (not conversation-scoped). `deliverToUser`
 * PUBLISHES the event on the realtime bus; a per-process subscriber
 * (`attachRealtimeSink`) fans each envelope out to the sockets THIS process
 * holds for the target user, across BOTH channels (/ws/chat and /ws/game).
 *
 * With the default in-process bus this behaves exactly as before. With a
 * distributed bus, an event produced on instance A reaches the recipient's
 * socket on instance B. Delivery remains a best-effort OPTIMIZATION; PostgreSQL
 * is the source of truth for notifications and the PresenceBackend for presence.
 *
 * Duplicate protection: each envelope carries a deterministic `eventId`; a sink
 * drops an envelope it has already delivered, so a bus that delivers more than
 * once never double-sends to a socket (and never creates DB rows — this path
 * only reads sockets).
 */

/** Compute a deterministic de-dup id for an event. */
function eventIdFor(userId: string, event: ServerRealtimeEvent): string {
  if (event.type === "notification.created") {
    // One logical event per notification per recipient.
    return `notif:${event.notification.id}:${userId}`;
  }
  // presence.changed can legitimately repeat (online→offline→online); include a
  // random suffix so distinct transitions are distinct, while a single publish
  // still has one id used for cross-instance de-dup of THAT publish.
  return `presence:${event.userId}:${event.status}:${randomUUID()}`;
}

/** Publish a user-scoped realtime event to the bus (fan-out happens in sinks). */
export function deliverToUser(userId: string, event: ServerRealtimeEvent): void {
  const envelope: RealtimeEnvelope = {
    eventId: eventIdFor(userId, event),
    userId,
    event,
  };
  getRealtimeBus().publish(envelope);
}

/** Fan a bus envelope out to the sockets this process holds for the user. */
function deliverLocally(userId: string, event: ServerRealtimeEvent): void {
  // The hubs' sendToUser only serializes + sends; the realtime event is a
  // distinct but equally safe payload, so we cast through unknown to reuse
  // their safe send paths without widening their public event types.
  (hub.sendToUser as (u: string, e: unknown) => void)(userId, event);
  (gameHub.sendToUser as (u: string, e: unknown) => void)(userId, event);
}

/**
 * Subscribe this process to the realtime bus so published envelopes are
 * delivered to local sockets. Idempotent; returns an unsubscribe function.
 * Called once at app creation (see createApp).
 */
let unsubscribe: (() => void) | null = null;
const seen = new Set<string>();
const SEEN_MAX = 5000;

export function attachRealtimeSink(): () => void {
  if (unsubscribe) return unsubscribe;
  unsubscribe = getRealtimeBus().subscribe((envelope) => {
    // Drop duplicates (a distributed bus may deliver more than once).
    if (seen.has(envelope.eventId)) return;
    seen.add(envelope.eventId);
    if (seen.size > SEEN_MAX) {
      // Bound memory: clear the oldest half-ish by rebuilding the set.
      seen.clear();
    }
    deliverLocally(envelope.userId, envelope.event);
  });
  return unsubscribe;
}

/** Test helper: detach the sink and clear de-dup state. */
export function resetRealtimeSink(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  seen.clear();
}
