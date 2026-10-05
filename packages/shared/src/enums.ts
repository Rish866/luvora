/** Minimum age required to use the platform. Enforced server-side. */
export const MINIMUM_AGE = 18;

/** Current consent policy version. Stored with every consent response so we can
 *  prove exactly which policy a user agreed to, and migrate safely. */
export const CONSENT_VERSION = "1.0.0";

/** Lifecycle of a two-player fantasy session. Transitions are enforced
 *  server-side (see SESSION_TRANSITIONS in stateMachine.ts). */
export enum SessionState {
  WAITING = "WAITING",
  INVITED = "INVITED",
  ACCEPTED = "ACCEPTED",
  CONSENT = "CONSENT",
  PLAYING = "PLAYING",
  PAUSED = "PAUSED",
  COMPLETED = "COMPLETED",
  ABANDONED = "ABANDONED",
  REPORTED = "REPORTED",
}

/** State of a match between two users. */
export enum MatchState {
  ACTIVE = "ACTIVE",
  UNMATCHED = "UNMATCHED",
  BLOCKED = "BLOCKED",
}

/** A single player's answer to a consent category. MAYBE is treated as
 *  "only if the partner also said YES" by the compatibility resolver, and like
 *  NO it is NEVER revealed to the partner. */
export enum ConsentResponseValue {
  YES = "YES",
  MAYBE = "MAYBE",
  NO = "NO",
}

/** Per-player readiness within the consent stage. */
export enum ConsentStatus {
  PENDING = "PENDING",
  SUBMITTED = "SUBMITTED",
  CONFIRMED = "CONFIRMED",
}

/** Image/media moderation lifecycle. */
export enum MediaModerationState {
  UPLOADING = "UPLOADING",
  MODERATION_PENDING = "MODERATION_PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
}

/** Report lifecycle. */
export enum ReportStatus {
  OPEN = "OPEN",
  REVIEWING = "REVIEWING",
  RESOLVED = "RESOLVED",
  DISMISSED = "DISMISSED",
}

/** Admin RBAC roles. Normal users have none of these. */
export enum AdminRole {
  SUPER_ADMIN = "SUPER_ADMIN",
  MODERATOR = "MODERATOR",
  SUPPORT = "SUPPORT",
  CONTENT_ADMIN = "CONTENT_ADMIN",
}

/** Report reason categories. */
export enum ReportReason {
  HARASSMENT = "HARASSMENT",
  FAKE_PROFILE = "FAKE_PROFILE",
  SPAM = "SPAM",
  INAPPROPRIATE_CONTENT = "INAPPROPRIATE_CONTENT",
  NON_CONSENSUAL_BEHAVIOR = "NON_CONSENSUAL_BEHAVIOR",
  THREATS = "THREATS",
  HATE = "HATE",
  ILLEGAL_CONTENT = "ILLEGAL_CONTENT",
  OTHER = "OTHER",
}
