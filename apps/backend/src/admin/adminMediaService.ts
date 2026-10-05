import { z } from "zod";
import {
  MediaStatus,
  MediaModerationStatus,
  canModerateMedia,
  type MediaAssetView,
} from "@luvora/shared";
import { Errors } from "../http/errors";
import { withTransaction } from "../db/pool";
import type { MediaAssetRow } from "../media/mediaRepository";
import { getMediaProviders } from "../media/mediaProviders";
import { audit } from "./auditService";
import { writeModerationAction } from "./auditRepository";

/**
 * Admin/moderator media moderation. Each decision runs in a transaction that
 * locks the media row, validates the moderation transition, updates moderation
 * + upload status consistently, and records both a moderation action and an
 * audit entry (persist-then-nothing-leaks). Clients can never set state
 * directly — only call these intent endpoints.
 */

export const reasonSchema = z.object({
  reason: z.string().min(1).max(2000),
});

function toAdminView(a: MediaAssetRow): MediaAssetView {
  return {
    id: a.id,
    status: a.status,
    moderationStatus: a.moderation_status,
    mimeType: a.detected_mime_type,
    byteSize: a.byte_size ? Number(a.byte_size) : null,
    width: a.width,
    height: a.height,
    createdAt: a.created_at,
    url: `/api/admin/media/${a.id}/content`,
    thumbnailUrl: a.thumbnail_storage_key ? `/api/admin/media/${a.id}/thumbnail` : null,
  };
}

interface TransitionInput {
  actorId: string;
  mediaId: string;
  toModeration: MediaModerationStatus;
  toUploadStatus: MediaStatus;
  action: string;
  reason: string | null;
  reportId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

async function transition(input: TransitionInput): Promise<MediaAssetView> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<MediaAssetRow>(
      `SELECT * FROM media_assets WHERE id = $1 FOR UPDATE`,
      [input.mediaId],
    );
    const asset = rows[0];
    if (!asset) throw Errors.mediaNotFound();
    if (asset.deleted_at || asset.status === MediaStatus.DELETED) {
      // Deleted media cannot be moderated/approved.
      throw Errors.mediaInvalidState("Deleted media cannot be moderated.");
    }
    if (!canModerateMedia(asset.moderation_status, input.toModeration)) {
      throw Errors.invalidModerationTransition(
        `Cannot move moderation from ${asset.moderation_status} to ${input.toModeration}.`,
      );
    }

    const updated = await client.query<MediaAssetRow>(
      `UPDATE media_assets
          SET moderation_status = $2,
              status = $3,
              moderation_reason = $4
        WHERE id = $1 AND status <> 'DELETED'
        RETURNING *`,
      [input.mediaId, input.toModeration, input.toUploadStatus, input.reason],
    );
    if (!updated.rows[0]) throw Errors.mediaInvalidState();

    await writeModerationAction(
      {
        actorUserId: input.actorId,
        action: input.action,
        targetType: "MEDIA",
        targetId: input.mediaId,
        reason: input.reason,
        reportId: input.reportId ?? null,
      },
      client,
    );
    await audit(
      {
        actorUserId: input.actorId,
        action: input.action,
        targetType: "MEDIA",
        targetId: input.mediaId,
        metadata: { moderationStatus: input.toModeration, status: input.toUploadStatus },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
      client,
    );
    return toAdminView(updated.rows[0]);
  });
}

export function approve(actorId: string, mediaId: string, ctx: Ctx = {}): Promise<MediaAssetView> {
  return transition({
    actorId,
    mediaId,
    toModeration: MediaModerationStatus.APPROVED,
    toUploadStatus: MediaStatus.READY,
    action: "media.approved",
    reason: null,
    ...ctx,
  });
}

export function reject(
  actorId: string,
  mediaId: string,
  reason: string,
  ctx: Ctx = {},
): Promise<MediaAssetView> {
  return transition({
    actorId,
    mediaId,
    toModeration: MediaModerationStatus.REJECTED,
    toUploadStatus: MediaStatus.REJECTED,
    action: "media.rejected",
    reason,
    ...ctx,
  });
}

export function quarantine(
  actorId: string,
  mediaId: string,
  reason: string,
  ctx: Ctx = {},
): Promise<MediaAssetView> {
  return transition({
    actorId,
    mediaId,
    toModeration: MediaModerationStatus.NEEDS_REVIEW,
    toUploadStatus: MediaStatus.QUARANTINED,
    action: "media.quarantined",
    reason,
    ...ctx,
  });
}

interface Ctx {
  reportId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

// ---- Moderator media review (privileged read) ----

import * as mediaRepo from "../media/mediaRepository";

export async function getForReview(mediaId: string): Promise<MediaAssetView> {
  const asset = await mediaRepo.getById(mediaId);
  if (!asset || asset.deleted_at) throw Errors.mediaNotFound();
  return toAdminView(asset);
}

/** Fetch bytes for moderator review via the storage abstraction. Works for any
 *  non-deleted asset regardless of normal user-facing READY gating, since the
 *  moderator must inspect quarantined/rejected content. Never exposes keys. */
export async function getReviewBytes(
  mediaId: string,
  variant: "original" | "thumbnail",
): Promise<{ data: Buffer; mimeType: string }> {
  const asset = await mediaRepo.getById(mediaId);
  if (!asset || asset.deleted_at) throw Errors.mediaNotFound();
  const { storage } = getMediaProviders();
  const key =
    variant === "thumbnail" && asset.thumbnail_storage_key
      ? asset.thumbnail_storage_key
      : asset.storage_key;
  let data: Buffer;
  try {
    data = await storage.get(key);
  } catch {
    throw Errors.mediaNotFound();
  }
  return { data, mimeType: asset.detected_mime_type ?? "application/octet-stream" };
}
