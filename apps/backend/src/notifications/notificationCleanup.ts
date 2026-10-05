import { logger } from "../logger";
import * as repo from "./notificationRepository";

/**
 * Delete expired notifications. A plain, idempotent function a future scheduler
 * can call periodically — no cron infrastructure required. Only rows with a
 * past `expires_at` are removed; critical SAFETY notifications are created with
 * no expiry, so they are never cleaned up here.
 */
export async function cleanupExpiredNotifications(): Promise<{ removed: number }> {
  const removed = await repo.deleteExpired();
  if (removed > 0) {
    logger.info({ removed }, "cleaned up expired notifications");
  }
  return { removed };
}

if (require.main === module) {
  cleanupExpiredNotifications()
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`Removed ${r.removed} expired notifications.`);
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "notification cleanup failed");
      process.exit(1);
    });
}
