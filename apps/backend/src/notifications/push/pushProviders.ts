import { config } from "../../config";
import type { PushProvider } from "./PushProvider";
import { DisabledPushProvider } from "./DisabledPushProvider";
import { TestPushProvider } from "./TestPushProvider";
import { FcmPushProvider } from "./FcmPushProvider";
import { ApnsPushProvider } from "./ApnsPushProvider";

/**
 * Dependency injection for the push provider — mirrors the media providers
 * pattern (src/media/mediaProviders.ts). The delivery dispatcher reads the
 * active provider from here so tests can inject a TestPushProvider without
 * touching business logic. The configured default is the DisabledPushProvider
 * (safe: no external delivery) unless NOTIFICATION_PUSH_ENABLED=true selects a
 * concrete provider.
 */
function buildDefault(): PushProvider {
  switch (config.notifications.pushProvider) {
    case "test":
      return new TestPushProvider();
    case "fcm":
      return new FcmPushProvider(config.notifications.fcm.configured);
    case "apns":
      return new ApnsPushProvider(config.notifications.apns.configured);
    case "disabled":
    default:
      return new DisabledPushProvider();
  }
}

let provider: PushProvider = buildDefault();

export function getPushProvider(): PushProvider {
  return provider;
}

/** Override the push provider (used in tests to inject a TestPushProvider). */
export function setPushProvider(next: PushProvider): void {
  provider = next;
}

/** Reset to the configured default (used in test teardown). */
export function resetPushProvider(): void {
  provider = buildDefault();
}
