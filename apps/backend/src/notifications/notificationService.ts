import type { PoolClient } from "pg";
import {
  NotificationType,
  NotificationCategory,
  NOTIFICATION_CATEGORY,
  CRITICAL_CATEGORIES,
  NOTIFICATION_DEFAULT_RETENTION_DAYS,
  ALL_PREFERENCE_CATEGORIES,
  type NotificationView,
} from "@luvora/shared";
import * as repo from "./notificationRepository";
import * as users from "../users/userRepository";
import { withTransaction } from "../db/pool";
import { deliverToUser } from "./realtime";
import { recordRealtimeAttempt } from "./deliveryDispatcher";
import { enqueueNotificationPushDelivery } from "../jobs/jobService";
import { logger } from "../logger";

/**
 * Centralized notification service — the ONLY place notifications are created.
 *
 * Responsibilities: validate recipient account state, honour the recipient's
 * category preference (critical SAFETY notifications are never suppressed),
 * generate/accept a deterministic dedupe key, insert (idempotent), and emit the
 * real-time `notification.created` event to the recipient's sockets.
 *
 * It can run standalone (its own insert) or inside a caller transaction (pass
 * `client`) so a state change + its notification commit atomically.
 */

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Deterministic idempotency key (e.g. "match:<id>:created:<userId>"). */
  dedupeKey?: string | null;
  /** Omit for default retention; null for no expiry; a Date for explicit. */
  expiresAt?: Date | null;
}

export interface CreateResult {
  notification: NotificationView | null;
  created: boolean;
  /** Reason a notification was NOT created (preference/account), for logging. */
  skipped?: "preference" | "account";
}

function defaultExpiry(category: NotificationCategory): Date | null {
  // Critical categories never auto-expire; others use default retention.
  if (CRITICAL_CATEGORIES.has(category)) return null;
  return new Date(Date.now() + NOTIFICATION_DEFAULT_RETENTION_DAYS * 24 * 3600 * 1000);
}

/**
 * Create a notification. Returns {created:false, notification:null} when the
 * recipient's preference disables the (non-critical) category or the account is
 * not active — this is a normal, non-error outcome so callers never fail an
 * application action because a notification was suppressed.
 */
export async function create(
  input: CreateNotificationInput,
  client?: PoolClient,
): Promise<CreateResult> {
  const category = NOTIFICATION_CATEGORY[input.type];

  // Recipient account state: never notify disabled/deleted/suspended/deactivated
  // accounts. (A reactivation SAFETY notice is created BEFORE/AS the account
  // returns to ACTIVE, so it is not suppressed here.)
  const recipient = await users.findById(input.userId);
  if (!recipient || recipient.is_disabled || recipient.account_status !== "ACTIVE") {
    return { notification: null, created: false, skipped: "account" };
  }

  // Preference check — critical categories bypass it entirely.
  if (!CRITICAL_CATEGORIES.has(category)) {
    const enabled = await repo.isCategoryEnabled(input.userId, category);
    if (!enabled) {
      return { notification: null, created: false, skipped: "preference" };
    }
  }

  const expiresAt =
    input.expiresAt === undefined ? defaultExpiry(category) : input.expiresAt;

  const insertInput = {
    userId: input.userId,
    type: input.type,
    category,
    title: input.title,
    body: input.body ?? "",
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    dedupeKey: input.dedupeKey ?? null,
    expiresAt,
  };

  // OUTBOX PATTERN: the notification INSERT and its durable push-delivery job
  // commit in the SAME transaction, so a committed notification is NEVER left
  // without its enqueued delivery job (and vice versa). SAFETY delivery is
  // enqueued at high priority. When the caller already supplies a transaction
  // `client`, we join it; otherwise we open one here.
  const highPriority = CRITICAL_CATEGORIES.has(category);
  const runInTxn = async (c: PoolClient): Promise<{ row: repo.NotificationRow; created: boolean }> => {
    const res = await repo.insertNotification(insertInput, c);
    if (res.created) {
      await enqueueNotificationPushDelivery(res.row.id, { high: highPriority }, c);
    }
    return res;
  };

  const { row, created } = client
    ? await runInTxn(client)
    : await withTransaction(runInTxn);

  const view = repo.toView(row);

  // Post-commit, best-effort REALTIME path (WebSocket optimization). This is NOT
  // the authoritative delivery — the durable job handles push. We only run it
  // for a standalone create (no caller client); a transactional caller should
  // emit post-commit via emit(). Push is intentionally NOT done inline anymore.
  if (created && !client) {
    emit(input.userId, view);
    void recordRealtimeAttempt(view.id).catch(() => undefined);
  }

  return { notification: view, created };
}

/** Deliver a `notification.created` event to the recipient's sockets. Call
 *  this AFTER commit when `create` was used with a transaction client. */
export function emit(userId: string, notification: NotificationView): void {
  try {
    deliverToUser(userId, { type: "notification.created", notification });
  } catch (err) {
    // Delivery is best-effort; persistence already succeeded.
    logger.warn({ err: (err as Error).message }, "notification realtime emit failed");
  }
}

// ---- Preferences ----

export async function getPreferences(userId: string) {
  const [stored, push] = await Promise.all([
    repo.listPreferences(userId),
    repo.listPushPreferences(userId),
  ]);
  return repo.toPreferenceViews(stored, push, ALL_PREFERENCE_CATEGORIES);
}

export async function setPreference(
  userId: string,
  category: NotificationCategory,
  enabled: boolean,
): Promise<void> {
  await repo.upsertPreference(userId, category, enabled);
}

/** Set the PUSH delivery preference for a category. SAFETY cannot be disabled
 *  (guarded in the route, same as the in-app preference). */
export async function setPushPreference(
  userId: string,
  category: NotificationCategory,
  pushEnabled: boolean,
): Promise<void> {
  await repo.upsertPushPreference(userId, category, pushEnabled);
}
