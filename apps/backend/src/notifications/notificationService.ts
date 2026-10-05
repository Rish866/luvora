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
import { deliverToUser } from "./realtime";
import { dispatchPush, recordRealtimeAttempt } from "./deliveryDispatcher";
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

  const { row, created } = await repo.insertNotification(
    {
      userId: input.userId,
      type: input.type,
      category,
      title: input.title,
      body: input.body ?? "",
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      expiresAt,
    },
    client,
  );

  const view = repo.toView(row);

  // Delivery pipeline runs only for a genuinely NEW notification (dedup means a
  // repeated event does not re-deliver). We run it AFTER a standalone insert;
  // when inside a caller transaction, the caller should call deliver()
  // post-commit (see emit/deliver). To avoid pre-commit delivery, we only
  // auto-deliver when NOT given a client.
  if (created && !client) {
    void deliver(input.userId, view, category);
  }

  return { notification: view, created };
}

/**
 * Run the best-effort delivery pipeline for a persisted notification:
 *   1. real-time `notification.created` to the recipient's sockets (optimization)
 *   2. record the realtime delivery attempt
 *   3. push to the recipient's registered devices (honouring push preference)
 *
 * Never throws — PostgreSQL persistence already succeeded and must not be
 * affected by any delivery failure. Call this AFTER commit when `create` was
 * used with a transaction client.
 */
export async function deliver(
  userId: string,
  notification: NotificationView,
  category?: NotificationCategory,
): Promise<void> {
  emit(userId, notification);
  await recordRealtimeAttempt(notification.id).catch(() => undefined);
  const cat = category ?? NOTIFICATION_CATEGORY[notification.type];
  const pushAllowed = await isPushAllowed(userId, cat).catch(() => false);
  await dispatchPush(userId, notification, pushAllowed).catch(() => undefined);
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

/** Whether PUSH delivery is permitted for this (user, category). Critical
 *  SAFETY notifications always push; others honour the push preference. */
async function isPushAllowed(
  userId: string,
  category: NotificationCategory,
): Promise<boolean> {
  if (CRITICAL_CATEGORIES.has(category)) return true;
  return repo.isPushEnabled(userId, category);
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
