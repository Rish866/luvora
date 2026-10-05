import type { RealtimeBus, RealtimeEnvelope, RealtimeSubscriber } from "./RealtimeBus";
import { LocalRealtimeBus } from "./LocalRealtimeBus";
import { logger } from "../../logger";

/**
 * Distributed realtime bus — ARCHITECTURAL PLACEHOLDER (Increment 8).
 *
 * Marks where a cross-instance pub/sub (e.g. Redis `PUBLISH`/`SUBSCRIBE`) plugs
 * in so a `notification.created` / `presence.changed` event produced on one
 * backend instance reaches a recipient connected to a DIFFERENT instance. It is
 * NOT a working distributed bus: no Redis dependency, no network client.
 *
 * Production design (documented, not implemented):
 *   - publish → serialize the envelope and `PUBLISH` on a well-known channel.
 *   - subscribe → `SUBSCRIBE` the channel; on message, deserialize and invoke
 *     the local subscriber, which fans out to this instance's sockets.
 *   - the envelope's `eventId` lets subscribers drop duplicate deliveries.
 *
 * Until wired, selecting REALTIME_BUS=distributed degrades safely to the
 * in-process LocalRealtimeBus (single-instance correct) and logs a warning.
 * Redis is NEVER required for tests.
 */
export class DistributedRealtimeBus implements RealtimeBus {
  private readonly delegate = new LocalRealtimeBus();

  constructor(redisUrl: string) {
    logger.warn(
      redisUrl
        ? "REALTIME_BUS=distributed is an architectural placeholder; the Redis " +
            "pub/sub integration is not implemented. Using in-process bus."
        : "REALTIME_BUS=distributed selected but REDIS_URL is empty; using the " +
            "in-process bus (single-instance only).",
    );
  }

  publish(envelope: RealtimeEnvelope): void {
    this.delegate.publish(envelope);
  }
  subscribe(subscriber: RealtimeSubscriber): () => void {
    return this.delegate.subscribe(subscriber);
  }
}
