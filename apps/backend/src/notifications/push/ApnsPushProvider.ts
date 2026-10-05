import { PushProviderKind, PushFailureKind } from "@luvora/shared";
import type { PushProvider, PushSendResult } from "./PushProvider";

/**
 * Apple Push Notification service provider — ARCHITECTURAL PLACEHOLDER.
 *
 * Same contract as FcmPushProvider: it exists so a real APNs integration can be
 * plugged in behind the PushProvider interface. It is NOT a working integration
 * (no APNs HTTP/2 client, no key/cert handling, no network call). Until
 * implemented and configured, every attempt returns a TEMPORARY "not
 * configured" failure so devices are not wrongly revoked.
 *
 * To implement for real:
 *   1. Add an APNs HTTP/2 client; load the .p8 key / team id / key id from a
 *      secret manager (NEVER commit).
 *   2. Build a background/data push from PushPayload (no PII in the alert body).
 *   3. Map APNs responses to PERMANENT (BadDeviceToken/Unregistered) vs
 *      TEMPORARY (ServiceUnavailable/TooManyRequests) and return the apns-id.
 */
export class ApnsPushProvider implements PushProvider {
  readonly kind = PushProviderKind.APNS;

  constructor(private readonly configured: boolean) {}

  async send(): Promise<PushSendResult> {
    if (!this.configured) {
      return {
        ok: false,
        failure: PushFailureKind.TEMPORARY,
        errorCode: "APNS_NOT_CONFIGURED",
      };
    }
    throw new Error(
      "ApnsPushProvider.send is not implemented. Integrate an APNs client and " +
        "provide credentials before enabling PUSH_PROVIDER=apns.",
    );
  }
}
