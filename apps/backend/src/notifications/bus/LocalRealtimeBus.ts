import { EventEmitter } from "node:events";
import type { RealtimeBus, RealtimeEnvelope, RealtimeSubscriber } from "./RealtimeBus";

/**
 * In-process realtime bus (the default). A simple EventEmitter: publish emits an
 * envelope that every subscriber in THIS process receives synchronously. With a
 * single instance this is sufficient; the DistributedRealtimeBus placeholder
 * marks where a Redis pub/sub implementation plugs in for multi-instance fan-out.
 *
 * For tests, a SINGLE shared LocalRealtimeBus instance can be injected into two
 * separate app "instances" to simulate a cross-instance bus without Redis.
 */
export class LocalRealtimeBus implements RealtimeBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many gateways/instances may subscribe; avoid the default 10-listener warn.
    this.emitter.setMaxListeners(0);
  }

  publish(envelope: RealtimeEnvelope): void {
    this.emitter.emit("event", envelope);
  }

  subscribe(subscriber: RealtimeSubscriber): () => void {
    this.emitter.on("event", subscriber);
    return () => this.emitter.off("event", subscriber);
  }
}
