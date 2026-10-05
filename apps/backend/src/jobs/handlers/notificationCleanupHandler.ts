import { JobType } from "@luvora/shared";
import type { JobHandler, JobHandlerContext, JobResult } from "../JobHandler";
import { JobResults } from "../JobHandler";
import {
  cleanupExpiredNotifications,
  cleanupDeliveryRecords,
} from "../../notifications/notificationCleanup";
import { logger } from "../../logger";

/**
 * Handler for NOTIFICATION_CLEANUP. Reuses the Increment 7/8 cleanup functions:
 * deletes expired NON-critical notifications (SAFETY has no expiry and is never
 * removed) and prunes terminal delivery records + long-revoked devices under
 * safe retention. Idempotent (deletes are naturally idempotent). Audit logs and
 * active data are never touched.
 */
export class NotificationCleanupHandler implements JobHandler {
  readonly type = JobType.NOTIFICATION_CLEANUP;

  async handle(_payload: Record<string, unknown>, ctx: JobHandlerContext): Promise<JobResult> {
    try {
      const expired = await cleanupExpiredNotifications();
      const delivery = await cleanupDeliveryRecords();
      logger.info(
        {
          jobId: ctx.jobId,
          notificationsRemoved: expired.removed,
          devicesRemoved: delivery.devicesRemoved,
          deliveriesRemoved: delivery.deliveriesRemoved,
        },
        "notification cleanup job complete",
      );
      return JobResults.success();
    } catch (err) {
      return JobResults.retry("CLEANUP_FAILED", (err as Error).message);
    }
  }
}
