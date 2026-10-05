import { query } from "../db/pool";
import {
  DeliveryChannel,
  DeliveryStatus,
  type NotificationDeliveryView,
} from "@luvora/shared";

/**
 * Data access for notification deliveries. Delivery rows are created
 * idempotently via the unique (notification_id, channel, coalesced device_id)
 * index, so concurrent dispatch attempts never produce duplicate logical
 * deliveries. All status updates are scoped to a delivery id.
 */

export interface DeliveryRow {
  id: string;
  notification_id: string;
  device_id: string | null;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  attempt_count: number;
  provider_message_id: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export function toView(row: DeliveryRow): NotificationDeliveryView {
  return {
    id: row.id,
    notificationId: row.notification_id,
    deviceId: row.device_id,
    channel: row.channel,
    status: row.status,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

/**
 * Ensure a PENDING delivery row exists for (notification, device, channel).
 * Returns the row (new or existing) and whether it was newly created. Race-safe
 * via ON CONFLICT DO NOTHING on the unique index.
 */
export async function ensureDelivery(input: {
  notificationId: string;
  deviceId: string | null;
  channel: DeliveryChannel;
}): Promise<{ row: DeliveryRow; created: boolean }> {
  const inserted = await query<DeliveryRow>(
    `INSERT INTO notification_deliveries (notification_id, device_id, channel, status)
     VALUES ($1, $2, $3, 'PENDING')
     ON CONFLICT (notification_id, channel, COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO NOTHING
     RETURNING *`,
    [input.notificationId, input.deviceId, input.channel],
  );
  if (inserted[0]) return { row: inserted[0], created: true };

  const existing = await query<DeliveryRow>(
    `SELECT * FROM notification_deliveries
      WHERE notification_id = $1 AND channel = $2
        AND COALESCE(device_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [input.notificationId, input.channel, input.deviceId],
  );
  return { row: existing[0], created: false };
}

/** Mark a delivery delivered (increment attempt count, clear error). */
export async function markDelivered(
  id: string,
  providerMessageId: string | null,
): Promise<void> {
  await query(
    `UPDATE notification_deliveries
        SET status = 'DELIVERED',
            attempt_count = attempt_count + 1,
            provider_message_id = $2,
            last_error_code = NULL,
            delivered_at = now()
      WHERE id = $1`,
    [id, providerMessageId],
  );
}

/** Mark a temporary failure (eligible for a bounded retry). */
export async function markFailed(id: string, errorCode: string): Promise<void> {
  await query(
    `UPDATE notification_deliveries
        SET status = 'FAILED',
            attempt_count = attempt_count + 1,
            last_error_code = $2
      WHERE id = $1`,
    [id, errorCode],
  );
}

/** Mark a permanent failure (device revoked / terminal; never retried). */
export async function markRevoked(id: string, errorCode: string): Promise<void> {
  await query(
    `UPDATE notification_deliveries
        SET status = 'REVOKED',
            attempt_count = attempt_count + 1,
            last_error_code = $2
      WHERE id = $1`,
    [id, errorCode],
  );
}

export async function markSent(id: string): Promise<void> {
  await query(
    `UPDATE notification_deliveries SET status = 'SENT' WHERE id = $1`,
    [id],
  );
}

export async function listForNotification(notificationId: string): Promise<DeliveryRow[]> {
  return query<DeliveryRow>(
    `SELECT * FROM notification_deliveries WHERE notification_id = $1 ORDER BY created_at`,
    [notificationId],
  );
}

export async function listForDevice(deviceId: string): Promise<DeliveryRow[]> {
  return query<DeliveryRow>(
    `SELECT * FROM notification_deliveries WHERE device_id = $1 ORDER BY created_at DESC`,
    [deviceId],
  );
}

/** Rows still eligible for a bounded retry (FAILED and under the attempt cap). */
export async function listRetryable(maxAttempts: number, limit = 100): Promise<DeliveryRow[]> {
  return query<DeliveryRow>(
    `SELECT * FROM notification_deliveries
      WHERE status = 'FAILED' AND attempt_count < $1
      ORDER BY updated_at ASC
      LIMIT $2`,
    [maxAttempts, limit],
  );
}

/** Delete delivery rows for notifications that no longer exist is handled by the
 *  FK ON DELETE CASCADE. This removes terminal (DELIVERED/REVOKED) rows older
 *  than the cutoff to keep the table bounded. */
export async function deleteTerminalBefore(cutoff: Date): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM notification_deliveries
      WHERE status IN ('DELIVERED','REVOKED') AND updated_at <= $1
      RETURNING id`,
    [cutoff.toISOString()],
  );
  return rows.length;
}
