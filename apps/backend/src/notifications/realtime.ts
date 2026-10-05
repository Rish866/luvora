import type { ServerRealtimeEvent } from "@luvora/shared";
import { hub } from "../chat/connectionRegistry";
import { gameHub } from "../fantasy/gameConnectionRegistry";

/**
 * Real-time delivery for notification + presence events.
 *
 * These events are user-scoped (not conversation-scoped), so they are delivered
 * to ALL of a user's authenticated sockets across BOTH channels (/ws/chat and
 * /ws/game). Delivery is a best-effort optimization: PostgreSQL remains the
 * source of truth for notifications, and the in-memory PresenceRegistry for
 * live presence.
 *
 * The two hubs are typed to their own event unions, but at runtime they just
 * JSON-serialize and send; we cast through `unknown` to reuse their safe send
 * paths without widening their public event types.
 */
export function deliverToUser(userId: string, event: ServerRealtimeEvent): void {
  // Cast: the hubs' sendToUser only serializes + sends; the realtime event is a
  // distinct but equally safe payload.
  (hub.sendToUser as (u: string, e: unknown) => void)(userId, event);
  (gameHub.sendToUser as (u: string, e: unknown) => void)(userId, event);
}
