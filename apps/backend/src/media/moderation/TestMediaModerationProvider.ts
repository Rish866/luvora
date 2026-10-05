import type {
  MediaModerationProvider,
  MediaModerationInput,
  ModerationResult,
} from "./MediaModerationProvider";

/**
 * Deterministic DEV/TEST moderation provider. Performs NO real content safety
 * analysis. It uses harmless embedded markers so tests can exercise each path:
 *  - "LUVORA-TEST-REJECT"       -> REJECTED
 *  - "LUVORA-TEST-REVIEW"       -> NEEDS_REVIEW
 *  - otherwise                  -> APPROVED
 *
 * Production MUST replace this with a real MediaModerationProvider.
 */
export class TestMediaModerationProvider implements MediaModerationProvider {
  // The dev stub approves all images. It performs NO real content analysis.
  // Tests that need REJECTED/NEEDS_REVIEW inject a fake provider via
  // setMediaProviders(), since image normalization strips any in-band markers.
  async moderate(_input: MediaModerationInput): Promise<ModerationResult> {
    return { status: "APPROVED" };
  }
}

/** Disabled moderation: everything needs manual review (safe default when no
 *  provider is configured — media never auto-approves). */
export class DisabledMediaModerationProvider implements MediaModerationProvider {
  async moderate(): Promise<ModerationResult> {
    return { status: "NEEDS_REVIEW", reason: "moderation-disabled" };
  }
}
