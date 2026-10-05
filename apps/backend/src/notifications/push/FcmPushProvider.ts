import { PushProviderKind, PushFailureKind } from "@luvora/shared";
import type { PushProvider, PushSendResult } from "./PushProvider";

/**
 * Firebase Cloud Messaging provider — ARCHITECTURAL PLACEHOLDER.
 *
 * This class exists so a production FCM integration can be dropped in behind the
 * PushProvider interface WITHOUT touching the dispatcher or service. It is NOT a
 * working integration: there is no Firebase SDK dependency, no credential
 * handling, and no network call here. Until a real `send` is implemented and
 * credentials are configured, every attempt returns a TEMPORARY,
 * clearly-labelled "not configured" failure (temporary so a device is not
 * wrongly revoked just because the server lacks credentials).
 *
 * To implement for real:
 *   1. Add the Firebase Admin SDK (or an HTTP v1 client) as a dependency.
 *   2. Load service-account credentials from a secret manager (NEVER commit).
 *   3. Map PushPayload → an FCM data-only message (no notification body with PII).
 *   4. Translate FCM error codes to PERMANENT (UNREGISTERED/INVALID_ARGUMENT) vs
 *      TEMPORARY (UNAVAILABLE/INTERNAL/quota) and return the message id.
 */
export class FcmPushProvider implements PushProvider {
  readonly kind = PushProviderKind.FCM;

  constructor(private readonly configured: boolean) {}

  async send(): Promise<PushSendResult> {
    if (!this.configured) {
      return {
        ok: false,
        failure: PushFailureKind.TEMPORARY,
        errorCode: "FCM_NOT_CONFIGURED",
      };
    }
    // No real SDK integration ships in this increment. Fail loudly rather than
    // pretend to deliver.
    throw new Error(
      "FcmPushProvider.send is not implemented. Integrate the Firebase SDK and " +
        "provide credentials before enabling PUSH_PROVIDER=fcm.",
    );
  }
}
