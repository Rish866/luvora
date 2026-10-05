import { logger } from "../logger";
import * as repo from "./notificationRepository";
import * as deviceRepo from "./deviceRepository";
import * as deliveryRepo from "./deliveryRepository";

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

/** Days a revoked device / terminal delivery record is retained before cleanup. */
export const DELIVERY_RETENTION_DAYS = 30;

/**
 * Operational cleanup for the delivery layer (Increment 8): remove long-revoked
 * devices and terminal (DELIVERED/REVOKED) delivery records older than the
 * retention window. Idempotent; never touches notifications (handled above) and
 * never touches a device/delivery still within retention.
 */
export async function cleanupDeliveryRecords(
  retentionDays = DELIVERY_RETENTION_DAYS,
): Promise<{ devicesRemoved: number; deliveriesRemoved: number }> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
  const devicesRemoved = await deviceRepo.deleteRevokedBefore(cutoff);
  const deliveriesRemoved = await deliveryRepo.deleteTerminalBefore(cutoff);
  if (devicesRemoved > 0 || deliveriesRemoved > 0) {
    logger.info({ devicesRemoved, deliveriesRemoved }, "cleaned up delivery records");
  }
  return { devicesRemoved, deliveriesRemoved };
}

if (require.main === module) {
  Promise.all([cleanupExpiredNotifications(), cleanupDeliveryRecords()])
    .then(([n, d]) => {
      // eslint-disable-next-line no-console
      console.log(
        `Removed ${n.removed} expired notifications, ${d.devicesRemoved} revoked ` +
          `devices, ${d.deliveriesRemoved} terminal deliveries.`,
      );
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, "notification/delivery cleanup failed");
      process.exit(1);
    });
}
