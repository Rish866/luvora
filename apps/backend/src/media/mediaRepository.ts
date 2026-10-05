import { query, withTransaction } from "../db/pool";
import type { PoolClient } from "pg";
import { MediaStatus, MediaModerationStatus, MediaContext } from "@luvora/shared";

/**
 * Data access for media assets, attachments, and reports. All SQL is
 * parameterized. Clients never set status / moderation_status / dimensions /
 * detected mime — only server-side code calls the mutating helpers here.
 */

export interface MediaAssetRow {
  id: string;
  owner_id: string;
  storage_key: string;
  thumbnail_storage_key: string | null;
  original_filename: string | null;
  declared_mime_type: string | null;
  detected_mime_type: string | null;
  byte_size: string | null; // BIGINT -> string via pg
  sha256: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  status: MediaStatus;
  moderation_status: MediaModerationStatus;
  moderation_reason: string | null;
  context: MediaContext;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export async function createUploadIntent(input: {
  ownerId: string;
  storageKey: string;
  declaredMime: string;
  originalFilename: string | null;
  context: MediaContext;
}): Promise<MediaAssetRow> {
  const rows = await query<MediaAssetRow>(
    `INSERT INTO media_assets
       (owner_id, storage_key, declared_mime_type, original_filename, context, status, moderation_status)
     VALUES ($1, $2, $3, $4, $5, 'UPLOADING', 'PENDING')
     RETURNING *`,
    [input.ownerId, input.storageKey, input.declaredMime, input.originalFilename, input.context],
  );
  return rows[0];
}

export async function getById(id: string): Promise<MediaAssetRow | null> {
  const rows = await query<MediaAssetRow>(`SELECT * FROM media_assets WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Atomically finalize an asset after processing. Writes server-derived metadata
 * and the resolved upload + moderation statuses in one update. Guarded on the
 * current status so a second concurrent finalize is a no-op.
 */
export async function finalizeProcessed(input: {
  id: string;
  detectedMime: string;
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
  thumbnailStorageKey: string | null;
  status: MediaStatus;
  moderationStatus: MediaModerationStatus;
  moderationReason: string | null;
}): Promise<MediaAssetRow | null> {
  const rows = await query<MediaAssetRow>(
    `UPDATE media_assets
        SET detected_mime_type = $2,
            byte_size = $3,
            sha256 = $4,
            width = $5,
            height = $6,
            thumbnail_storage_key = $7,
            status = $8,
            moderation_status = $9,
            moderation_reason = $10
      WHERE id = $1 AND status IN ('UPLOADING','UPLOADED','PROCESSING')
      RETURNING *`,
    [
      input.id,
      input.detectedMime,
      input.byteSize,
      input.sha256,
      input.width,
      input.height,
      input.thumbnailStorageKey,
      input.status,
      input.moderationStatus,
      input.moderationReason,
    ],
  );
  return rows[0] ?? null;
}

/** Mark an asset REJECTED/QUARANTINED with a reason (server-side only). */
export async function setStatus(
  id: string,
  status: MediaStatus,
  moderationStatus: MediaModerationStatus | null,
  moderationReason: string | null,
): Promise<void> {
  await query(
    `UPDATE media_assets
        SET status = $2,
            moderation_status = COALESCE($3, moderation_status),
            moderation_reason = COALESCE($4, moderation_reason)
      WHERE id = $1`,
    [id, status, moderationStatus, moderationReason],
  );
}

/** Soft-delete an asset (owner-only enforced in the service). */
export async function softDelete(id: string): Promise<void> {
  await query(
    `UPDATE media_assets SET status = 'DELETED', deleted_at = now() WHERE id = $1`,
    [id],
  );
}

/** For moderation transitions driven by a report. */
export async function setModerationStatus(
  id: string,
  moderationStatus: MediaModerationStatus,
  status: MediaStatus | null,
  reason: string | null,
): Promise<void> {
  await query(
    `UPDATE media_assets
        SET moderation_status = $2,
            status = COALESCE($3, status),
            moderation_reason = COALESCE($4, moderation_reason)
      WHERE id = $1`,
    [id, moderationStatus, status, reason],
  );
}

/** Delete abandoned UPLOADING assets older than `olderThanMs`. Returns ids +
 *  storage keys so the caller can also remove bytes via MediaStorage. */
export async function findAbandonedUploads(
  olderThanMs: number,
): Promise<Array<{ id: string; storage_key: string }>> {
  return query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM media_assets
      WHERE status = 'UPLOADING'
        AND created_at < now() - ($1::int * interval '1 millisecond')`,
    [olderThanMs],
  );
}

export async function hardDelete(id: string): Promise<void> {
  await query(`DELETE FROM media_assets WHERE id = $1`, [id]);
}

// ---- Attachments (transaction-aware) ----

export interface AttachmentRow {
  id: string;
  message_id: string;
  media_id: string;
  sort_order: number;
}

/** Fetch the media rows backing a set of ids, FOR UPDATE within a tx. */
export async function lockMediaByIds(
  client: PoolClient,
  ids: string[],
): Promise<MediaAssetRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<MediaAssetRow>(
    `SELECT * FROM media_assets WHERE id = ANY($1::uuid[]) FOR UPDATE`,
    [ids],
  );
  return rows;
}

export async function insertAttachment(
  client: PoolClient,
  input: { messageId: string; mediaId: string; sortOrder: number },
): Promise<void> {
  await client.query(
    `INSERT INTO message_attachments (message_id, media_id, sort_order)
     VALUES ($1, $2, $3)
     ON CONFLICT (message_id, media_id) DO NOTHING`,
    [input.messageId, input.mediaId, input.sortOrder],
  );
}

/** Attachments for a set of message ids, with the safe media fields joined. */
export interface AttachmentWithMediaRow {
  message_id: string;
  media_id: string;
  sort_order: number;
  detected_mime_type: string | null;
  byte_size: string | null;
  width: number | null;
  height: number | null;
  thumbnail_storage_key: string | null;
  status: MediaStatus;
}

export async function listAttachmentsForMessages(
  messageIds: string[],
): Promise<AttachmentWithMediaRow[]> {
  if (messageIds.length === 0) return [];
  return query<AttachmentWithMediaRow>(
    `SELECT ma.message_id, ma.media_id, ma.sort_order,
            m.detected_mime_type, m.byte_size, m.width, m.height,
            m.thumbnail_storage_key, m.status
       FROM message_attachments ma
       JOIN media_assets m ON m.id = ma.media_id
      WHERE ma.message_id = ANY($1::uuid[])
      ORDER BY ma.message_id, ma.sort_order ASC`,
    [messageIds],
  );
}

// ---- Reports ----

export async function createReport(input: {
  mediaId: string;
  reporterId: string;
  reason: string;
}): Promise<{ created: boolean }> {
  const rows = await query(
    `INSERT INTO media_reports (media_id, reporter_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (media_id, reporter_id) DO NOTHING
     RETURNING id`,
    [input.mediaId, input.reporterId, input.reason],
  );
  return { created: rows.length > 0 };
}

export async function countReports(mediaId: string): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM media_reports WHERE media_id = $1`,
    [mediaId],
  );
  return rows[0]?.n ?? 0;
}

export { withTransaction };
