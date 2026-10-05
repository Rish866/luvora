import type { PushPayload, PushFailureKind, PushProviderKind } from "@luvora/shared";

/**
 * Provider-independent push delivery abstraction (Increment 8).
 *
 * A provider receives a MINIMAL, already-sanitized payload plus the delivery
 * target (platform + raw token). It must never be handed message bodies,
 * consent answers, media keys, or any secret beyond the device token it needs
 * to call its own backend. Concrete providers (FCM/APNs/WebPush) live behind
 * this interface so the application never binds to a vendor SDK.
 */

/** The target device for a single push send. */
export interface PushTarget {
  deviceId: string;
  platform: string;
  /** Raw provider token — used ONLY to call the provider; never logged/returned. */
  token: string;
}

/** Result of a single send attempt. */
export type PushSendResult =
  | { ok: true; providerMessageId: string | null }
  | {
      ok: false;
      /** PERMANENT ⇒ revoke device, never retry. TEMPORARY ⇒ bounded retry. */
      failure: PushFailureKind;
      /** Short, sanitized error code (never a raw provider response). */
      errorCode: string;
    };

export interface PushProvider {
  /** Which provider kind this is (for diagnostics; never trusts client input). */
  readonly kind: PushProviderKind;
  /** Attempt to deliver one notification to one device. Best-effort. */
  send(payload: PushPayload, target: PushTarget): Promise<PushSendResult>;
}
