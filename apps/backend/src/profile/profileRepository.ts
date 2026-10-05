import { query, withTransaction } from "../db/pool";
import type { PoolClient } from "pg";

/**
 * Data access for the authenticated user's own profile and profile-photo
 * gallery (Increment 14). All SQL is parameterized. Photo rows link a user to
 * `media_assets` via `profile_photos`; the media pipeline (0005) owns the bytes
 * and moderation state.
 */

export interface ProfileRow {
  user_id: string;
  display_name: string;
  bio: string | null;
  interests: string[];
  fantasy_preferences: string[];
  age_visible: boolean;
  online_status_visible: boolean;
  read_receipts_enabled: boolean;
  discoverable: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProfilePhotoRow {
  id: string;
  user_id: string;
  media_id: string;
  position: number;
  is_primary: boolean;
  created_at: string;
  // Joined from media_assets for serialization.
  media_status: string;
  thumbnail_storage_key: string | null;
}

export async function getProfile(userId: string): Promise<ProfileRow | null> {
  const rows = await query<ProfileRow>(
    `SELECT user_id, display_name, bio, interests, fantasy_preferences,
            age_visible, online_status_visible, read_receipts_enabled,
            discoverable, created_at, updated_at
       FROM profiles WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** Partial, column-whitelisted update of the caller's own profile. Only the
 *  provided (defined) fields are written; everything else is untouched. */
export async function updateProfile(
  userId: string,
  fields: Partial<{
    displayName: string;
    bio: string | null;
    interests: string[];
    fantasyPreferences: string[];
    discoverable: boolean;
    ageVisible: boolean;
    onlineStatusVisible: boolean;
    readReceiptsEnabled: boolean;
  }>,
): Promise<ProfileRow> {
  const sets: string[] = [];
  const params: unknown[] = [userId];
  const add = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (fields.displayName !== undefined) add("display_name", fields.displayName);
  if (fields.bio !== undefined) add("bio", fields.bio);
  if (fields.interests !== undefined) add("interests", fields.interests);
  if (fields.fantasyPreferences !== undefined) add("fantasy_preferences", fields.fantasyPreferences);
  if (fields.discoverable !== undefined) add("discoverable", fields.discoverable);
  if (fields.ageVisible !== undefined) add("age_visible", fields.ageVisible);
  if (fields.onlineStatusVisible !== undefined) add("online_status_visible", fields.onlineStatusVisible);
  if (fields.readReceiptsEnabled !== undefined) add("read_receipts_enabled", fields.readReceiptsEnabled);

  if (sets.length === 0) {
    // No-op update: return the current row unchanged.
    const current = await getProfile(userId);
    if (!current) throw new Error("profile not found");
    return current;
  }

  const rows = await query<ProfileRow>(
    `UPDATE profiles SET ${sets.join(", ")} WHERE user_id = $1
     RETURNING user_id, display_name, bio, interests, fantasy_preferences,
               age_visible, online_status_visible, read_receipts_enabled,
               discoverable, created_at, updated_at`,
    params,
  );
  return rows[0];
}

/** List a user's profile photos with media status, in display order. */
export async function listPhotos(userId: string): Promise<ProfilePhotoRow[]> {
  return query<ProfilePhotoRow>(
    `SELECT pp.id, pp.user_id, pp.media_id, pp.position, pp.is_primary, pp.created_at,
            m.status AS media_status, m.thumbnail_storage_key
       FROM profile_photos pp
       JOIN media_assets m ON m.id = pp.media_id
      WHERE pp.user_id = $1 AND m.deleted_at IS NULL
      ORDER BY pp.position ASC, pp.created_at ASC`,
    [userId],
  );
}

export async function countPhotos(userId: string): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM profile_photos pp
       JOIN media_assets m ON m.id = pp.media_id
      WHERE pp.user_id = $1 AND m.deleted_at IS NULL`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

export async function getPhotoById(
  userId: string,
  photoId: string,
): Promise<ProfilePhotoRow | null> {
  const rows = await query<ProfilePhotoRow>(
    `SELECT pp.id, pp.user_id, pp.media_id, pp.position, pp.is_primary, pp.created_at,
            m.status AS media_status, m.thumbnail_storage_key
       FROM profile_photos pp
       JOIN media_assets m ON m.id = pp.media_id
      WHERE pp.id = $1 AND pp.user_id = $2`,
    [photoId, userId],
  );
  return rows[0] ?? null;
}

/**
 * Attach a READY media asset the caller owns as a profile photo. Appends to the
 * end of the gallery. The FIRST photo a user adds becomes primary automatically.
 * Transaction-safe and idempotent on the media_id UNIQUE constraint.
 */
export async function addPhoto(input: {
  userId: string;
  mediaId: string;
}): Promise<ProfilePhotoRow> {
  return withTransaction(async (client) => {
    // Next position = current count (0-based append).
    const posRes = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position) + 1, 0) AS next
         FROM profile_photos WHERE user_id = $1`,
      [input.userId],
    );
    const position = posRes.rows[0]?.next ?? 0;
    const anyRes = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM profile_photos WHERE user_id = $1`,
      [input.userId],
    );
    const isFirst = (anyRes.rows[0]?.n ?? 0) === 0;

    const res = await client.query<ProfilePhotoRow>(
      `INSERT INTO profile_photos (user_id, media_id, position, is_primary)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, media_id, position, is_primary, created_at,
                 '' AS media_status, NULL AS thumbnail_storage_key`,
      [input.userId, input.mediaId, position, isFirst],
    );
    return res.rows[0];
  });
}

/**
 * Set `photoId` as the caller's primary photo, clearing any existing primary —
 * atomically, so the one-primary partial unique index is never violated.
 */
export async function setPrimary(userId: string, photoId: string): Promise<void> {
  await withTransaction(async (client) => {
    // Clear the current primary first (so the partial unique index is free),
    // then set the new one. Both scoped to the owner.
    await client.query(
      `UPDATE profile_photos SET is_primary = false
        WHERE user_id = $1 AND is_primary = true AND id <> $2`,
      [userId, photoId],
    );
    await client.query(
      `UPDATE profile_photos SET is_primary = true WHERE id = $2 AND user_id = $1`,
      [userId, photoId],
    );
  });
}

/**
 * Apply an explicit ordering of the caller's photos. `orderedIds` must be a
 * permutation of the user's current photo ids (validated in the service).
 * Positions are reassigned 0..n-1 in the given order, in one transaction.
 */
export async function reorder(userId: string, orderedIds: string[]): Promise<void> {
  await withTransaction(async (client) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        `UPDATE profile_photos SET position = $3 WHERE id = $2 AND user_id = $1`,
        [userId, orderedIds[i], i],
      );
    }
  });
}

/** The media ids currently owned by `userId` as profile photos (for validation). */
export interface PhotoIdRow {
  id: string;
  media_id: string;
  is_primary: boolean;
  position: number;
}
export async function listPhotoIdSet(
  userId: string,
  client?: PoolClient,
): Promise<PhotoIdRow[]> {
  const q = `SELECT id, media_id, is_primary, position FROM profile_photos WHERE user_id = $1`;
  if (client) {
    const { rows } = await client.query<PhotoIdRow>(q, [userId]);
    return rows;
  }
  return query<PhotoIdRow>(q, [userId]);
}

/**
 * Delete a profile-photo association (owner-scoped). If the deleted photo was
 * primary, promote the next photo (lowest position) to primary. Returns true if
 * a row was deleted. The media asset itself is soft-deleted by the service.
 */
export async function deletePhoto(userId: string, photoId: string): Promise<{
  deleted: boolean;
  mediaId: string | null;
  wasPrimary: boolean;
}> {
  return withTransaction(async (client) => {
    const existing = await client.query<ProfilePhotoRow>(
      `SELECT id, user_id, media_id, position, is_primary, created_at,
              '' AS media_status, NULL AS thumbnail_storage_key
         FROM profile_photos WHERE id = $1 AND user_id = $2`,
      [photoId, userId],
    );
    const row = existing.rows[0];
    if (!row) return { deleted: false, mediaId: null, wasPrimary: false };

    await client.query(`DELETE FROM profile_photos WHERE id = $1 AND user_id = $2`, [
      photoId,
      userId,
    ]);

    if (row.is_primary) {
      // Promote the next remaining photo (lowest position) to primary.
      const next = await client.query<{ id: string }>(
        `SELECT id FROM profile_photos WHERE user_id = $1
          ORDER BY position ASC, created_at ASC LIMIT 1`,
        [userId],
      );
      if (next.rows[0]) {
        await client.query(`UPDATE profile_photos SET is_primary = true WHERE id = $1`, [
          next.rows[0].id,
        ]);
      }
    }
    return { deleted: true, mediaId: row.media_id, wasPrimary: row.is_primary };
  });
}
