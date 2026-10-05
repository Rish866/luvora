import { ApiError } from "../api/client";

/**
 * Map any thrown value into a safe, user-facing message. Backend AppErrors
 * already carry safe messages (no internals), so we prefer those; otherwise a
 * generic fallback. Never surfaces stack traces or raw server internals.
 */
export function toUserMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err instanceof ApiError) {
    return err.message || fallback;
  }
  return fallback;
}

/** The stable backend error code for a thrown value, if any. */
export function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? err.code : null;
}
