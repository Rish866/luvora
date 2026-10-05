import {
  DeliveryChannel,
  PushFailureKind,
  PUSH_MAX_DELIVERY_ATTEMPTS,
  type NotificationView,
  type PushPayload,
} from "@luvora/shared";
import { logger } from "../logger";
import * as deviceRepo from "./deviceRepository";
import * as deliveryRepo from "./deliveryRepository";
import { getPushProvider } from "./push/pushProviders";
import type { PushProvider } from "./push/PushProvider";

/**
 * Push delivery dispatcher (Increment 8).
 *
 * Takes an ALREADY-PERSISTED notification and attempts best-effort push
 * delivery to each of the recipient's active devices. PostgreSQL remains the
 * source of truth: this never creates/alters the notification itself and never
 * throws into the caller — a provider outage must not fail an application
 * action or roll back the notification.
 *
 * Guarantees:
 *  - Idempotent: delivery rows are keyed on (notification, device, channel) via
 *    a DB unique index, so repeated dispatch of the same notification does not
 *    duplicate deliveries (and already-DELIVERED rows are skipped).
 *  - Privacy: the push payload carries ONLY opaque references (ids/category),
 *    never the title/body text, message content, consent, media keys, etc.
 *  - Permanent failures (invalid token) revoke the device and never retry.
 *  - Temporary failures retry up to PUSH_MAX_DELIVERY_ATTEMPTS, then stop.
 */

/** Build the minimal, privacy-safe push payload from a safe NotificationView.
 *  Note: title/body are intentionally OMITTED so no human-readable content
 *  leaves the server; the client re-fetches via the authenticated feed. */
export function toPushPayload(n: NotificationView): PushPayload {
  return {
    type: n.type,
    notificationId: n.id,
    category: n.category,
    entityType: n.entityType,
    entityId: n.entityId,
  };
}

/** Attempt one send against a delivery row that already exists. Updates the row
 *  based on the result. Returns the resulting status for diagnostics. */
async function attempt(
  provider: PushProvider,
  deliveryId: string,
  payload: PushPayload,
  device: deviceRepo.DeviceRow,
): Promise<void> {
  let result;
  try {
    result = await provider.send(payload, {
      deviceId: device.id,
      platform: device.platform,
      token: device.token,
    });
  } catch (err) {
    // A provider that throws (e.g. an unconfigured real provider) is treated as
    // a temporary failure — do NOT revoke the device over a server-side gap.
    const code = sanitizeError((err as Error)?.message);
    await deliveryRepo.markFailed(deliveryId, code);
    logger.warn({ deliveryId, errorCode: code }, "push provider threw; marked failed");
    return;
  }

  if (result.ok) {
    await deliveryRepo.markDelivered(deliveryId, result.providerMessageId);
    return;
  }

  if (result.failure === PushFailureKind.PERMANENT) {
    // Permanently invalid token (or an explicit disabled no-op). Revoke the
    // device only for a true invalid-token signal; a globally-disabled provider
    // should not wipe the user's device registration.
    await deliveryRepo.markRevoked(deliveryId, result.errorCode);
    if (result.errorCode !== "PUSH_DISABLED") {
      await deviceRepo.revokeById(device.id);
      logger.info({ deviceFingerprint: device.token_fingerprint }, "device revoked (invalid token)");
    }
    return;
  }

  // Temporary failure — eligible for a bounded retry.
  await deliveryRepo.markFailed(deliveryId, result.errorCode);
}

/** Short, sanitized error code from an arbitrary provider error message —
 *  never persists a full provider response (may contain sensitive data). */
function sanitizeError(message: string | undefined): string {
  if (!message) return "PROVIDER_ERROR";
  // Keep only a short, uppercase, token-free code.
  const code = message.slice(0, 60).replace(/[^A-Za-z0-9_]+/g, "_").toUpperCase();
  return code.slice(0, 40) || "PROVIDER_ERROR";
}

/**
 * Dispatch push for a freshly-created notification to all of the recipient's
 * active devices. Best-effort; swallows all errors.
 *
 * @param pushAllowed whether the recipient permits PUSH for this category
 *   (SAFETY always allowed; other categories honour push_enabled). When false,
 *   no delivery rows are created and nothing is sent — the in-app notification
 *   is unaffected.
 */
export async function dispatchPush(
  userId: string,
  notification: NotificationView,
  pushAllowed: boolean,
): Promise<void> {
  if (!pushAllowed) return;
  try {
    const provider = getPushProvider();
    const devices = await deviceRepo.listActiveWithTokenForUser(userId);
    if (devices.length === 0) return;
    const payload = toPushPayload(notification);
    for (const device of devices) {
      const { row, created } = await deliveryRepo.ensureDelivery({
        notificationId: notification.id,
        deviceId: device.id,
        channel: DeliveryChannel.PUSH,
      });
      // Only act on a fresh PENDING row; an existing DELIVERED/REVOKED row means
      // this (notification, device) was already handled — stay idempotent.
      if (!created && row.status !== "PENDING") continue;
      await attempt(provider, row.id, payload, device);
    }
  } catch (err) {
    // Delivery is best-effort; never propagate.
    logger.warn({ err: (err as Error).message, userId }, "push dispatch failed (ignored)");
  }
}

/**
 * Record that a REALTIME (WebSocket) delivery was attempted for a notification.
 * This is a single device-less row per notification; it documents that the
 * best-effort realtime path ran. Idempotent.
 */
export async function recordRealtimeAttempt(notificationId: string): Promise<void> {
  try {
    const { row, created } = await deliveryRepo.ensureDelivery({
      notificationId,
      deviceId: null,
      channel: DeliveryChannel.REALTIME,
    });
    if (created || row.status === "PENDING") {
      await deliveryRepo.markDelivered(row.id, null);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "realtime delivery record failed (ignored)");
  }
}

/**
 * Retry temporarily-failed PUSH deliveries, bounded by PUSH_MAX_DELIVERY_ATTEMPTS.
 * A plain callable a future worker/scheduler can invoke; no cron infrastructure
 * is introduced. Returns a summary for diagnostics/tests.
 */
export async function retryFailedDeliveries(
  limit = 100,
): Promise<{ retried: number; delivered: number; revoked: number; exhausted: number }> {
  const provider = getPushProvider();
  const rows = await deliveryRepo.listRetryable(PUSH_MAX_DELIVERY_ATTEMPTS, limit);
  let delivered = 0;
  let revoked = 0;
  let exhausted = 0;
  for (const row of rows) {
    if (!row.device_id) continue; // only PUSH rows are retryable
    const device = (await deviceRepo.getById(row.device_id)) ?? null;
    if (!device || device.revoked_at) {
      // Device gone/revoked meanwhile — stop retrying.
      await deliveryRepo.markRevoked(row.id, "DEVICE_REVOKED");
      revoked += 1;
      continue;
    }
    const notification = await loadNotificationView(row.notification_id);
    if (!notification) continue;
    await attempt(provider, row.id, toPushPayload(notification), device);
    const after = await deliveryRepo.listForNotification(row.notification_id);
    const updated = after.find((d) => d.id === row.id);
    if (updated?.status === "DELIVERED") delivered += 1;
    else if (updated?.status === "REVOKED") revoked += 1;
    else if (updated && updated.attempt_count >= PUSH_MAX_DELIVERY_ATTEMPTS) exhausted += 1;
  }
  return { retried: rows.length, delivered, revoked, exhausted };
}

/** Load a safe NotificationView by id (for retry payload rebuilds). */
async function loadNotificationView(
  notificationId: string,
): Promise<NotificationView | null> {
  // Imported lazily to avoid a cycle with the notification repository.
  const repo = await import("./notificationRepository");
  const row = await repo.getById(notificationId);
  return row ? repo.toView(row) : null;
}
