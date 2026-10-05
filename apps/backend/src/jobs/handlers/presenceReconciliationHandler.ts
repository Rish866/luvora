import { JobType } from "@luvora/shared";
import type { JobHandler, JobHandlerContext, JobResult } from "../JobHandler";
import { JobResults } from "../JobHandler";
import { reapNow } from "../../presence/presenceService";
import { logger } from "../../logger";

/**
 * Handler for PRESENCE_RECONCILIATION — a durable periodic backstop for the
 * in-process presence reaper (Increment 8). It reaps connections whose TTL has
 * lapsed (a crashed process / missed WS disconnect that the in-memory callback
 * never cleaned up), transitioning only users with NO remaining live connection
 * to OFFLINE and persisting last-seen.
 *
 * Multi-connection safety is preserved: the backend's ref-count means a user
 * with another active (recently-heartbeated) connection is NOT reaped — it only
 * removes connections past the TTL and only emits OFFLINE on the final removal.
 * A single-instance process can only see its own connections; cross-instance
 * reconciliation would require the distributed presence backend (not shipped).
 */
export class PresenceReconciliationHandler implements JobHandler {
  readonly type = JobType.PRESENCE_RECONCILIATION;

  async handle(_payload: Record<string, unknown>, ctx: JobHandlerContext): Promise<JobResult> {
    try {
      const offline = reapNow();
      if (offline.length > 0) {
        logger.info(
          { jobId: ctx.jobId, reaped: offline.length },
          "presence reconciliation reaped stale connections",
        );
      }
      return JobResults.success();
    } catch (err) {
      return JobResults.retry("RECONCILIATION_FAILED", (err as Error).message);
    }
  }
}
