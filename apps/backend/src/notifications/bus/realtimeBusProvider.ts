import { config } from "../../config";
import type { RealtimeBus } from "./RealtimeBus";
import { LocalRealtimeBus } from "./LocalRealtimeBus";
import { DistributedRealtimeBus } from "./DistributedRealtimeBus";

/**
 * DI for the realtime bus — mirrors the push/media provider pattern. The active
 * bus is selected by REALTIME_BUS; the default is the in-process LocalRealtimeBus.
 * Tests can inject a single shared bus into two app "instances" to simulate
 * cross-instance delivery without Redis.
 */
function buildDefault(): RealtimeBus {
  if (config.realtime.bus === "distributed") {
    return new DistributedRealtimeBus(config.realtime.redisUrl);
  }
  return new LocalRealtimeBus();
}

let bus: RealtimeBus = buildDefault();

export function getRealtimeBus(): RealtimeBus {
  return bus;
}

/** Override the bus (tests: share one bus across simulated instances). */
export function setRealtimeBus(next: RealtimeBus): void {
  bus = next;
}

export function resetRealtimeBus(): void {
  bus = buildDefault();
}
