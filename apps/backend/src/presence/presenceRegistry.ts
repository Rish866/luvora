import { config } from "../config";
import type { PresenceBackend } from "./PresenceBackend";
import { LocalPresenceBackend } from "./LocalPresenceBackend";
import { DistributedPresenceBackend } from "./DistributedPresenceBackend";

/**
 * The process's active presence backend (Increment 8).
 *
 * Increment 7 exported a `presenceRegistry` singleton that the gateways and the
 * presence service use. We keep that exported name for backward compatibility,
 * but it is now a `PresenceBackend` selected by configuration:
 *   - PRESENCE_BACKEND=local       → LocalPresenceBackend (default)
 *   - PRESENCE_BACKEND=distributed → DistributedPresenceBackend (placeholder;
 *       degrades to local until a shared-store client is wired)
 *
 * Re-exported types let callers depend on the abstraction, not the impl.
 */
export type { PresenceBackend, PresenceTransition, TransitionListener } from "./PresenceBackend";

function buildBackend(): PresenceBackend {
  const ttlMs = config.presence.ttlSeconds * 1000;
  if (config.presence.backend === "distributed") {
    return new DistributedPresenceBackend(ttlMs, config.presence.redisUrl);
  }
  return new LocalPresenceBackend(ttlMs);
}

/** Shared singleton presence backend for the process. */
export const presenceRegistry: PresenceBackend = buildBackend();
