import { Errors } from "../http/errors";
import * as users from "../users/userRepository";
import type { UserRow } from "../users/userRepository";
import { AccountStatus } from "@luvora/shared";

/**
 * Server-authoritative account-state enforcement, shared by the HTTP auth
 * middleware and the WebSocket handshake.
 *
 * An expired suspension (suspended_until in the past) auto-lapses to ACTIVE on
 * next check, so suspensions with a duration self-heal without a scheduler. A
 * still-active suspension or a deactivation blocks all authenticated actions.
 */
export interface ActiveUserCheck {
  ok: boolean;
  user?: UserRow;
}

/**
 * Returns the user if they are allowed to act, or throws the appropriate
 * AppError (ACCOUNT_SUSPENDED / ACCOUNT_DEACTIVATED). Returns null if the user
 * does not exist / is deleted / is disabled (caller maps to unauthenticated).
 */
export async function assertAccountActive(userId: string): Promise<UserRow | null> {
  let user = await users.findById(userId);
  if (!user || user.is_disabled) return null;

  if (user.account_status === AccountStatus.SUSPENDED) {
    // Auto-lapse if the suspension window has passed.
    const lapsed = await users.lapseExpiredSuspension(userId);
    if (lapsed) {
      user = await users.findById(userId);
      if (!user || user.is_disabled) return null;
    } else {
      throw Errors.accountSuspended();
    }
  }

  if (user.account_status === AccountStatus.DEACTIVATED) {
    throw Errors.accountDeactivated();
  }

  return user;
}

/** Boolean-returning variant for the WS handshake (no throw). */
export async function isAccountActive(userId: string): Promise<boolean> {
  try {
    const user = await assertAccountActive(userId);
    return user !== null;
  } catch {
    return false;
  }
}
