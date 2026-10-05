import { query } from "../db/pool";
import { Errors } from "../http/errors";
import { MediaStatus, MediaContext } from "@luvora/shared";
import type { MediaAssetRow } from "./mediaRepository";
import * as mediaRepo from "./mediaRepository";

/**
 * Centralized media authorization. The owner always has access to their own
 * asset; a recipient gains access only through an authorized relationship:
 *  - CHAT: the asset is attached to a message in a conversation whose match the
 *    viewer participates in, AND that match is still chat-eligible (ACTIVE, no
 *    block in either direction) — i.e. the SAME policy as chat itself, so there
 *    is no media path that bypasses chat blocking.
 *  - SESSION: the asset is attached to a message in the viewer's fantasy
 *    session's conversation (sessions run on top of a match conversation).
 *  - PROFILE (Increment 14): the asset is a profile photo and the viewer is
 *    entitled to see that owner's profile — i.e. there is no block in either
 *    direction AND (the owner is discoverable OR the viewer shares an ACTIVE
 *    match with the owner). This mirrors the discovery/match visibility rules
 *    so avatars render exactly where a user is already visible, and nowhere
 *    else. Only READY+APPROVED profile photos are servable (enforced below in
 *    the service via the status gate).
 *
 * Knowing a media UUID is never sufficient. Missing/unauthorized both yield the
 * generic errors so existence isn't leaked.
 */

/**
 * May `viewerId` see `ownerId`'s profile media? Mirrors discovery/match
 * visibility: never when blocked either direction; otherwise when the owner is
 * discoverable OR the two share an ACTIVE match. Purely a read predicate.
 */
export async function canViewProfileMedia(
  viewerId: string,
  ownerId: string,
): Promise<boolean> {
  if (viewerId === ownerId) return true;
  const rows = await query<{ ok: boolean }>(
    `SELECT (
       NOT EXISTS (
         SELECT 1 FROM blocks b
          WHERE (b.blocker_id = $1 AND b.blocked_id = $2)
             OR (b.blocker_id = $2 AND b.blocked_id = $1)
       )
       AND (
         EXISTS (
           SELECT 1 FROM profiles p
            WHERE p.user_id = $2 AND p.discoverable = true
         )
         OR EXISTS (
           SELECT 1 FROM matches m
            WHERE m.state = 'ACTIVE'
              AND m.user_a = LEAST($1::uuid, $2::uuid)
              AND m.user_b = GREATEST($1::uuid, $2::uuid)
         )
       )
     ) AS ok`,
    [viewerId, ownerId],
  );
  return rows[0]?.ok ?? false;
}

/** Load an asset or throw the generic not-found error. */
export async function loadAsset(mediaId: string): Promise<MediaAssetRow> {
  const asset = await mediaRepo.getById(mediaId);
  if (!asset) throw Errors.mediaNotFound();
  return asset;
}

/** Can `userId` READ this asset's bytes/metadata? */
export async function authorizeView(
  userId: string,
  asset: MediaAssetRow,
): Promise<void> {
  if (asset.deleted_at || asset.status === MediaStatus.DELETED) {
    // Deleted assets are gone for everyone (owner included).
    throw Errors.mediaNotFound();
  }

  // Owner can always view their own (non-deleted) asset.
  if (asset.owner_id === userId) return;

  // PROFILE photos: visible to any viewer entitled to see the owner's profile
  // (discovery/match visibility), never when blocked. The status gate in the
  // service additionally restricts served bytes to READY+APPROVED.
  if (asset.context === MediaContext.PROFILE) {
    if (await canViewProfileMedia(userId, asset.owner_id)) return;
    throw Errors.mediaNotAuthorized();
  }

  // Otherwise the viewer must reach it through an authorized conversation whose
  // chat policy currently permits access (participant + ACTIVE + no block).
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM message_attachments att
       JOIN messages msg       ON msg.id = att.message_id
       JOIN conversations conv ON conv.id = msg.conversation_id
       JOIN matches m          ON m.id = conv.match_id
      WHERE att.media_id = $1
        AND m.state = 'ACTIVE'
        AND ($2 = m.user_a OR $2 = m.user_b)
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = m.user_a AND b.blocked_id = m.user_b)
              OR (b.blocker_id = m.user_b AND b.blocked_id = m.user_a)
        )`,
    [asset.id, userId],
  );
  if ((rows[0]?.n ?? 0) > 0) return;

  throw Errors.mediaNotAuthorized();
}

/** Owner-only guard (for delete). */
export function authorizeOwner(userId: string, asset: MediaAssetRow): void {
  if (asset.owner_id !== userId || asset.deleted_at) {
    // Do not reveal ownership of someone else's asset.
    throw Errors.mediaNotAuthorized();
  }
}

/** Can `userId` REPORT this asset? Same visibility rule as viewing. */
export async function authorizeReport(
  userId: string,
  asset: MediaAssetRow,
): Promise<void> {
  await authorizeView(userId, asset);
}
