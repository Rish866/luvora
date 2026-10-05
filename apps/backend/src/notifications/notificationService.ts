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

  // Real-time delivery only for a genuinely new notification. We emit AFTER a
  // standalone insert; when inside a caller transaction, the caller should emit
  // post-commit (see emit()). To keep this simple and avoid pre-commit
  // delivery, we only auto-emit when NOT given a client.
  if (created && !client) {
    emit(input.userId, view);
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
  const stored = await repo.listPreferences(userId);
  return repo.toPreferenceViews(stored, ALL_PREFERENCE_CATEGORIES);
}

export async function setPreference(
  userId: string,
  category: NotificationCategory,
  enabled: boolean,
): Promise<void> {
  await repo.upsertPreference(userId, category, enabled);
}
