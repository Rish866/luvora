import { config } from "../config";
import type { MediaStorage } from "./storage/MediaStorage";
import { LocalMediaStorage } from "./storage/LocalMediaStorage";
import type { MediaScanner } from "./scanning/MediaScanner";
import { TestMediaScanner, DisabledMediaScanner } from "./scanning/TestMediaScanner";
import type { MediaModerationProvider } from "./moderation/MediaModerationProvider";
import {
  TestMediaModerationProvider,
  DisabledMediaModerationProvider,
} from "./moderation/TestMediaModerationProvider";

/**
 * Dependency injection for media providers. The media service reads storage,
 * scanner, and moderation from here, so tests can override them with fakes
 * (e.g. an INFECTED scanner) without touching business logic. Production wires
 * real adapters by setting these once at startup.
 */
export interface MediaProviders {
  storage: MediaStorage;
  scanner: MediaScanner;
  moderation: MediaModerationProvider;
}

function buildDefault(): MediaProviders {
  const storage =
    config.media.storageProvider === "local"
      ? new LocalMediaStorage(config.media.localStoragePath)
      : new LocalMediaStorage(config.media.localStoragePath);

  const scanner =
    config.media.scanMode === "test" ? new TestMediaScanner() : new DisabledMediaScanner();

  const moderation =
    config.media.moderationMode === "test"
      ? new TestMediaModerationProvider()
      : new DisabledMediaModerationProvider();

  return { storage, scanner, moderation };
}

let providers: MediaProviders = buildDefault();

export function getMediaProviders(): MediaProviders {
  return providers;
}

/** Override providers (used in tests to inject fakes). */
export function setMediaProviders(next: Partial<MediaProviders>): void {
  providers = { ...providers, ...next };
}

/** Reset to the configured defaults (used in test teardown). */
export function resetMediaProviders(): void {
  providers = buildDefault();
}
