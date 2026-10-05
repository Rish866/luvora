import { PushProviderKind, PushFailureKind } from "@luvora/shared";
import type { PushProvider, PushSendResult } from "./PushProvider";

/**
 * The safe default provider: performs NO push delivery at all. Every send is a
 * PERMANENT no-op failure with an explicit code, so the dispatcher records that
 * push was attempted-but-disabled rather than silently pretending to deliver.
 *
 * This is the default whenever NOTIFICATION_PUSH_ENABLED is false (dev/test and
 * any deployment without a configured provider). The in-app PostgreSQL
 * notification and the WebSocket event are unaffected.
 */
export class DisabledPushProvider implements PushProvider {
  readonly kind = PushProviderKind.DISABLED;

  async send(): Promise<PushSendResult> {
    return {
      ok: false,
      // DISABLED is terminal (never retry) but does NOT revoke the device — the
      // dispatcher treats "provider disabled" as a non-revoking terminal state.
      failure: PushFailureKind.PERMANENT,
      errorCode: "PUSH_DISABLED",
    };
  }
}
