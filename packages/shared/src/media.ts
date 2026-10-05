/**
 * Media + attachment shared types (Increment 5).
 *
 * Public DTOs expose only safe fields. Storage keys, SHA-256, detected-vs-
 * declared MIME internals, scanner/moderation internals, EXIF, and original
 * server paths are NEVER included in these shapes.
 */

/** Upload/processing lifecycle (server-controlled). */
export enum MediaStatus {
  UPLOADING = "UPLOADING",
  UPLOADED = "UPLOADED",
  PROCESSING = "PROCESSING",
  READY = "READY",
  QUARANTINED = "QUARANTINED",
  REJECTED = "REJECTED",
  DELETED = "DELETED",
}

/** Moderation lifecycle (independent of upload status). */
export enum MediaModerationStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  NEEDS_REVIEW = "NEEDS_REVIEW",
}

/** Context an asset is created for; restricts where it may be attached. */
export enum MediaContext {
  CHAT = "chat",
  SESSION = "session",
  PROFILE = "profile",
}

/** The image MIME types accepted for upload in Increment 5. */
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** Report reason enum (controlled vocabulary). */
export enum MediaReportReason {
  CSAM = "CSAM",
  NONCONSENSUAL = "NONCONSENSUAL",
  VIOLENCE = "VIOLENCE",
  HARASSMENT = "HARASSMENT",
  SPAM = "SPAM",
  OTHER = "OTHER",
}

/**
 * Response to an upload-intent creation. `uploadUrl` is an application URL to
 * PUT the bytes to — never a raw storage path.
 */
export interface UploadIntent {
  mediaId: string;
  status: MediaStatus;
  uploadUrl: string;
  maxBytes: number;
}

/** Owner-facing media detail (a bit more than the attachment DTO, but still no
 *  storage internals). */
export interface MediaAssetView {
  id: string;
  status: MediaStatus;
  moderationStatus: MediaModerationStatus;
  mimeType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  /** Authenticated application URL to fetch the (normalized) bytes. */
  url: string;
  /** Authenticated application URL to fetch the thumbnail, if generated. */
  thumbnailUrl: string | null;
}

/**
 * Safe attachment DTO embedded in chat message payloads. Exposes only what a
 * recipient needs to render the image. No storage key / EXIF / filename.
 */
export interface AttachmentView {
  id: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  url: string;
  thumbnailUrl: string | null;
}

/** Chat message with optional attachments (extends the Increment 3 shape). */
export interface ChatMessageWithAttachments {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  clientMessageId: string | null;
  createdAt: string;
  attachments: AttachmentView[];
}

/** Default media limits (safe fallbacks; overridable via env). */
export const MEDIA_DEFAULTS = {
  MAX_BYTES: 10 * 1024 * 1024, // 10 MB
  MAX_WIDTH: 8000,
  MAX_HEIGHT: 8000,
  MAX_ATTACHMENTS_PER_MESSAGE: 5,
  MAX_TOTAL_MESSAGE_BYTES: 25 * 1024 * 1024,
  THUMBNAIL_SIZE: 320, // longest edge, px
  SIGNED_URL_TTL_SECONDS: 300,
} as const;
