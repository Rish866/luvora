import { z } from "zod";
import crypto from "node:crypto";
import {
  MediaStatus,
  MediaModerationStatus,
  MediaContext,
  MediaReportReason,
  ALLOWED_IMAGE_MIME_TYPES,
  type AllowedImageMimeType,
  type UploadIntent,
  type MediaAssetView,
  type AttachmentView,
} from "@luvora/shared";
import { config } from "../config";
import { Errors } from "../http/errors";
import * as mediaRepo from "./mediaRepository";
import { getMediaProviders } from "./mediaProviders";
import { processImage, probeDimensions } from "./imageProcessor";
import { metrics } from "../observability/metrics";
import { loadAsset, authorizeView, authorizeOwner, authorizeReport } from "./mediaAuthorization";

/**
 * Media application logic: the full secure upload pipeline, access, delete,
 * report, and the attachment validation/serialization reused by chat.
 *
 * Server-authoritative throughout: clients never set status, moderation,
 * dimensions, or detected MIME. The sender/owner identity is always the
 * authenticated user.
 */

export const createIntentSchema = z.object({
  filename: z.string().max(255).optional(),
  mimeType: z.string().max(100),
  sizeBytes: z.number().int().positive(),
  context: z.nativeEnum(MediaContext).default(MediaContext.CHAT),
});

export const reportSchema = z.object({
  reason: z.nativeEnum(MediaReportReason),
});

/** Build the authenticated application URL for an asset's bytes / thumbnail.
 *  Bytes live on the `/content` sub-path so `GET /api/media/:id` can return the
 *  JSON metadata view unambiguously. */
function mediaUrl(id: string): string {
  return `/api/media/${id}/content`;
}
function thumbnailUrl(id: string): string {
  return `/api/media/${id}/thumbnail`;
}

function toAssetView(a: mediaRepo.MediaAssetRow): MediaAssetView {
  return {
    id: a.id,
    status: a.status,
    moderationStatus: a.moderation_status,
    mimeType: a.detected_mime_type,
    byteSize: a.byte_size ? Number(a.byte_size) : null,
    width: a.width,
    height: a.height,
    createdAt: a.created_at,
    url: mediaUrl(a.id),
    thumbnailUrl: a.thumbnail_storage_key ? thumbnailUrl(a.id) : null,
  };
}

/** Step 1: create an upload intent. Validates the DECLARED type/size cheaply
 *  (content is validated for real on upload). Generates an opaque storage key. */
export async function createUploadIntent(input: {
  ownerId: string;
  filename?: string;
  mimeType: string;
  sizeBytes: number;
  context: MediaContext;
}): Promise<UploadIntent> {
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(input.mimeType as AllowedImageMimeType)) {
    throw Errors.mediaTypeNotAllowed();
  }
  if (input.sizeBytes > config.media.maxBytes) {
    throw Errors.mediaTooLarge();
  }

  // Opaque, random, server-generated storage key — never from the filename.
  const storageKey = `media/${crypto.randomUUID()}/original`;

  const row = await mediaRepo.createUploadIntent({
    ownerId: input.ownerId,
    storageKey,
    declaredMime: input.mimeType,
    originalFilename: input.filename ?? null,
    context: input.context,
  });

  return {
    mediaId: row.id,
    status: MediaStatus.UPLOADING,
    uploadUrl: `${mediaUrl(row.id)}/content`,
    maxBytes: config.media.maxBytes,
  };
}

/**
 * Step 2: receive content bytes and run the full pipeline:
 *   ownership + state check → size guard → magic-byte/type detection →
 *   declared-vs-detected agreement → decode + dimension validation → SHA-256 →
 *   malware scan → image normalization + EXIF/GPS strip + thumbnail →
 *   content moderation → persist derived metadata + resolved statuses → store.
 *
 * The asset only becomes READY+APPROVED when every gate passes.
 */
export async function uploadContent(input: {
  ownerId: string;
  mediaId: string;
  data: Buffer;
}): Promise<MediaAssetView> {
  const asset = await loadAsset(input.mediaId);

  // Ownership + still-uploadable.
  if (asset.owner_id !== input.ownerId) throw Errors.mediaNotAuthorized();
  if (asset.status !== MediaStatus.UPLOADING) throw Errors.mediaInvalidState();

  // Size + emptiness guards (bytes already bounded by the route body limit).
  if (input.data.length === 0) throw Errors.mediaInvalidContent();
  if (input.data.length > config.media.maxBytes) throw Errors.mediaTooLarge();

  const { scanner, moderation, storage } = getMediaProviders();

  // Decompression-bomb / oversized-dimension guard: reject with a PRECISE error
  // when the declared pixel count exceeds policy, before the full decode. This
  // complements sharp's own limitInputPixels guard inside processImage.
  const dims = await probeDimensions(input.data);
  if (dims && dims.pixels > config.media.maxPixels) {
    try {
      metrics.incr("media_rejected_total", { reason: "dimensions" });
    } catch {
      /* telemetry best-effort */
    }
    await mediaRepo.setStatus(
      asset.id,
      MediaStatus.REJECTED,
      MediaModerationStatus.REJECTED,
      "dimensions-too-large",
    );
    throw Errors.mediaDimensionsTooLarge();
  }

  // Image inspection + normalization (also enforces dimension/bomb limits and
  // strips metadata). Returns null if the content isn't a valid allowed image.
  const processed = await processImage({
    data: input.data,
    maxWidth: config.media.maxWidth,
    maxHeight: config.media.maxHeight,
    thumbnailSize: config.media.thumbnailSize,
  });
  if (!processed) {
    try {
      metrics.incr("media_rejected_total", { reason: "invalid_image" });
    } catch {
      /* telemetry best-effort */
    }
    await mediaRepo.setStatus(asset.id, MediaStatus.REJECTED, MediaModerationStatus.REJECTED, "invalid-image");
    throw Errors.mediaInvalidContent();
  }

  // Declared-vs-detected MIME must agree (defeats header spoofing).
  if (asset.declared_mime_type && asset.declared_mime_type !== processed.detectedMime) {
    await mediaRepo.setStatus(asset.id, MediaStatus.REJECTED, MediaModerationStatus.REJECTED, "mime-mismatch");
    throw Errors.mediaMimeMismatch();
  }

  // Malware scan on the ORIGINAL bytes.
  const scan = await scanner.scan(input.data);
  if (scan.status === "INFECTED") {
    await mediaRepo.setStatus(asset.id, MediaStatus.QUARANTINED, MediaModerationStatus.REJECTED, "malware");
    throw Errors.mediaRejected("This upload was rejected by a safety scan.");
  }
  if (scan.status === "UNKNOWN" && config.media.unknownScanPolicy === "quarantine") {
    await mediaRepo.setStatus(asset.id, MediaStatus.QUARANTINED, MediaModerationStatus.NEEDS_REVIEW, "scan-unknown");
    throw Errors.mediaRejected("This upload is pending a safety review.");
  }

  // Content moderation on the normalized image.
  const mod = await moderation.moderate({
    data: processed.normalized,
    mimeType: processed.detectedMime,
    width: processed.width,
    height: processed.height,
  });

  // Resolve statuses from the moderation outcome.
  let status: MediaStatus;
  let moderationStatus: MediaModerationStatus;
  if (mod.status === "APPROVED") {
    status = MediaStatus.READY;
    moderationStatus = MediaModerationStatus.APPROVED;
  } else if (mod.status === "REJECTED") {
    status = MediaStatus.REJECTED;
    moderationStatus = MediaModerationStatus.REJECTED;
  } else {
    // NEEDS_REVIEW -> quarantined; not usable until a moderator approves.
    status = MediaStatus.QUARANTINED;
    moderationStatus = MediaModerationStatus.NEEDS_REVIEW;
  }

  // Persist bytes ONLY when the asset is becoming usable or kept for review.
  // Store the normalized image (never the raw original) + thumbnail.
  const thumbKey = `media/${crypto.randomUUID()}/thumbnail`;
  await storage.put(asset.storage_key, processed.normalized, processed.detectedMime);
  await storage.put(thumbKey, processed.thumbnail, processed.detectedMime);

  const finalized = await mediaRepo.finalizeProcessed({
    id: asset.id,
    detectedMime: processed.detectedMime,
    byteSize: processed.normalized.length,
    sha256: processed.sha256,
    width: processed.width,
    height: processed.height,
    thumbnailStorageKey: thumbKey,
    status,
    moderationStatus,
    moderationReason: mod.reason ?? null,
  });
  if (!finalized) {
    // Concurrent finalize already ran; return current state.
    const current = await loadAsset(asset.id);
    return toAssetView(current);
  }

  // Only a READY+APPROVED asset is a successful upload the client can use.
  // REJECTED and QUARANTINED(NEEDS_REVIEW) both signal "not usable" so the
  // client never treats unscanned/unreviewed media as ready.
  if (status === MediaStatus.REJECTED) {
    throw Errors.mediaRejected();
  }
  if (status === MediaStatus.QUARANTINED) {
    throw Errors.mediaRejected("This upload is pending a safety review.");
  }
  return toAssetView(finalized);
}

/** Fetch bytes for an authorized viewer. `variant` selects original/thumbnail. */
export async function getBytes(input: {
  userId: string;
  mediaId: string;
  variant: "original" | "thumbnail";
}): Promise<{ data: Buffer; mimeType: string }> {
  const asset = await loadAsset(input.mediaId);
  await authorizeView(input.userId, asset);

  // Only READY (approved) assets are downloadable by normal users. Owners also
  // cannot download quarantined/rejected content as an image stream.
  if (asset.status !== MediaStatus.READY) {
    throw Errors.mediaNotReady();
  }

  const { storage } = getMediaProviders();
  const key =
    input.variant === "thumbnail" && asset.thumbnail_storage_key
      ? asset.thumbnail_storage_key
      : asset.storage_key;
  let data: Buffer;
  try {
    data = await storage.get(key);
  } catch {
    // Bytes missing from storage (e.g. cleaned up) — treat as not found rather
    // than leaking a storage/filesystem error.
    throw Errors.mediaNotFound();
  }
  return { data, mimeType: asset.detected_mime_type ?? "application/octet-stream" };
}

export async function getAssetView(
  userId: string,
  mediaId: string,
): Promise<MediaAssetView> {
  const asset = await loadAsset(mediaId);
  // The owner sees their asset in any non-deleted state (to observe moderation
  // progress); others only via authorizeView (which requires READY-eligibility
  // through a conversation). We allow owner metadata read here.
  if (asset.owner_id !== userId) {
    await authorizeView(userId, asset);
  } else if (asset.deleted_at) {
    throw Errors.mediaNotFound();
  }
  return toAssetView(asset);
}

export async function deleteAsset(userId: string, mediaId: string): Promise<void> {
  const asset = await loadAsset(mediaId);
  authorizeOwner(userId, asset);

  await mediaRepo.softDelete(asset.id);
  // Best-effort byte removal via the storage abstraction (never touches the FS
  // directly from a route handler).
  const { storage } = getMediaProviders();
  await storage.delete(asset.storage_key).catch(() => undefined);
  if (asset.thumbnail_storage_key) {
    await storage.delete(asset.thumbnail_storage_key).catch(() => undefined);
  }
}

export async function reportAsset(input: {
  userId: string;
  mediaId: string;
  reason: MediaReportReason;
}): Promise<void> {
  const asset = await loadAsset(input.mediaId);
  await authorizeReport(input.userId, asset);

  const { created } = await mediaRepo.createReport({
    mediaId: asset.id,
    reporterId: input.userId,
    reason: input.reason,
  });

  // On a first report of a sensitive category, move the asset to NEEDS_REVIEW
  // and quarantine it (never auto-deleting; a moderator decides). We never
  // reveal report internals to the reporter.
  if (created) {
    const sensitive =
      input.reason === MediaReportReason.CSAM ||
      input.reason === MediaReportReason.NONCONSENSUAL;
    if (sensitive) {
      await mediaRepo.setModerationStatus(
        asset.id,
        MediaModerationStatus.NEEDS_REVIEW,
        MediaStatus.QUARANTINED,
        "reported",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Attachment validation + serialization (used by chat)
// ---------------------------------------------------------------------------

export const MAX_ATTACHMENTS = config.media.maxAttachmentsPerMessage;

/** The attachment-id list schema used in message send payloads. */
export const attachmentIdsSchema = z
  .array(z.string().uuid())
  .max(1000) // hard cap before business-rule check gives a precise error
  .optional();

/** Convert a joined attachment+media row into the safe public DTO. */
export function toAttachmentView(row: mediaRepo.AttachmentWithMediaRow): AttachmentView {
  return {
    id: row.media_id,
    mimeType: row.detected_mime_type ?? "application/octet-stream",
    byteSize: row.byte_size ? Number(row.byte_size) : 0,
    width: row.width,
    height: row.height,
    url: mediaUrl(row.media_id),
    thumbnailUrl: row.thumbnail_storage_key ? thumbnailUrl(row.media_id) : null,
  };
}
