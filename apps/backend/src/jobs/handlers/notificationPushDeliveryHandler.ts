import { JobType } from "@luvora/shared";
import type { JobHandler, JobHandlerContext, JobResult } from "../JobHandler";
import { JobResults } from "../JobHandler";
import { deliverPushForNotificationId } from "../../notifications/deliveryDispatcher";
import { logger } from "../../logger";

/**
 * Handler for NOTIFICATION_PUSH_DELIVERY. Payload: { notificationId }.
 *
 * Reuses the Increment 8 delivery pipeline (`deliverPushForNotificationId`),
 * which is idempotent via the `notification_deliveries` unique constraint, and
 * maps the aggregated outcome to the job retry policy:
 *   - temporary device failures → retryable (the worker backs off)
 *   - permanent failures / all delivered / nothing to do → success
 * A permanently invalid token revokes its device inside the pipeline.
 */
export class NotificationPushDeliveryHandler
  implements JobHandler<{ notificationId?: unknown }>
{
  readonly type = JobType.NOTIFICATION_PUSH_DELIVERY;

  async handle(
    payload: { notificationId?: unknown },
    ctx: JobHandlerContext,
  ): Promise<JobResult> {
    const notificationId =
      typeof payload.notificationId === "string" ? payload.notificationId : null;
    if (!notificationId) {
      // Malformed payload is a permanent error — retrying can't fix it.
      return JobResults.permanent("INVALID_PAYLOAD", "missing notificationId");
    }

    const outcome = await deliverPushForNotificationId(notificationId);
    logger.debug(
      { jobId: ctx.jobId, workerId: ctx.workerId, notificationId, outcome: outcome.kind },
      "push delivery handler outcome",
    );

    if (outcome.kind === "retry") {
      return JobResults.retry(outcome.errorCode, "temporary push delivery failure");
    }
    // "done" and "skip" are both success for the job (nothing left to retry).
    return JobResults.success();
  }
}
