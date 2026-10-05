/**
 * Provider-independent content-safety / moderation abstraction.
 *
 * Production can plug in an external content-safety service WITHOUT changing
 * media business logic. The bundled TestMediaModerationProvider is a
 * deterministic development stub — it performs NO real AI moderation and must
 * never be presented as such.
 */
export type ModerationStatus = "APPROVED" | "REJECTED" | "NEEDS_REVIEW";

export interface ModerationResult {
  status: ModerationStatus;
  reason?: string;
}

export interface MediaModerationInput {
  data: Buffer;
  mimeType: string;
  width: number | null;
  height: number | null;
}

export interface MediaModerationProvider {
  moderate(input: MediaModerationInput): Promise<ModerationResult>;
}
