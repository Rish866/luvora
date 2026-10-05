import type { ServerRealtimeEvent } from "@luvora/shared";

/**
 * Realtime event bus abstraction (Increment 8).
 *
 * User-scoped realtime events (`notification.created`, `presence.changed`) are
 * published to the bus; each backend instance subscribes and fans out to the
 * sockets IT holds for the target user. With a single process the bus is an
 * in-memory emitter (LocalRealtimeBus). With multiple instances a distributed
 * bus (e.g. Redis pub/sub) lets an event created on instance A reach the
 * recipient's socket on instance B — all behind this interface.
 *
 * A published envelope carries a deterministic `eventId` so subscribers can
 * drop duplicates (a distributed bus may deliver more than once).
 */
export interface RealtimeEnvelope {
  /** Deterministic id for de-duplication across instances. */
  eventId: string;
  /** The target user whose sockets should receive the event. */
  userId: string;
  event: ServerRealtimeEvent;
}

export type RealtimeSubscriber = (envelope: RealtimeEnvelope) => void;

export interface RealtimeBus {
  publish(envelope: RealtimeEnvelope): void;
  subscribe(subscriber: RealtimeSubscriber): () => void;
}
