import { query } from "../db/pool";
import type { MatchListRow } from "./discoverySerializer";

/**
 * Match read access. Only ACTIVE matches involving the viewer are returned, and
 * only discovery-safe fields about the other participant are selected.
 */

/** List the viewer's ACTIVE matches, newest first, with the other user's
 *  public profile + first approved photo (LATERAL join, no N+1). */
export async function listMatchesForUser(
  viewerId: string,
): Promise<MatchListRow[]> {
  const sql = `
    SELECT
      m.id         AS match_id,
      m.created_at AS created_at,
      other.id     AS other_id,
      op.display_name AS other_display_name,
      ph.id          AS other_photo_id,
      ph.storage_key AS other_photo_storage_key
    FROM matches m
    JOIN users other
      ON other.id = CASE WHEN m.user_a = $1 THEN m.user_b ELSE m.user_a END
    JOIN profiles op ON op.user_id = other.id
    LEFT JOIN LATERAL (
      SELECT id, storage_key
      FROM photos
      WHERE photos.user_id = other.id
        AND photos.deleted_at IS NULL
        AND photos.moderation_state = 'APPROVED'
      ORDER BY position ASC, created_at ASC
      LIMIT 1
    ) ph ON true
    WHERE (m.user_a = $1 OR m.user_b = $1)
      AND m.state = 'ACTIVE'
      AND other.deleted_at IS NULL
    ORDER BY m.created_at DESC, m.id DESC
  `;
  return query<MatchListRow>(sql, [viewerId]);
}

/** Fetch a single ACTIVE match the viewer participates in, or null. Returns
 *  null both when the match does not exist AND when it exists but the viewer is
 *  not a participant — the service maps those to distinct errors. */
export interface MatchParticipantsRow {
  id: string;
  user_a: string;
  user_b: string;
  state: string;
  created_at: string;
}

export async function getMatchById(
  matchId: string,
): Promise<MatchParticipantsRow | null> {
  const rows = await query<MatchParticipantsRow>(
    `SELECT id, user_a, user_b, state, created_at FROM matches WHERE id = $1`,
    [matchId],
  );
  return rows[0] ?? null;
}

export async function getMatchDetailForUser(
  matchId: string,
  viewerId: string,
): Promise<MatchListRow | null> {
  const rows = await query<MatchListRow>(
    `
    SELECT
      m.id         AS match_id,
      m.created_at AS created_at,
      other.id     AS other_id,
      op.display_name AS other_display_name,
      ph.id          AS other_photo_id,
      ph.storage_key AS other_photo_storage_key
    FROM matches m
    JOIN users other
      ON other.id = CASE WHEN m.user_a = $2 THEN m.user_b ELSE m.user_a END
    JOIN profiles op ON op.user_id = other.id
    LEFT JOIN LATERAL (
      SELECT id, storage_key
      FROM photos
      WHERE photos.user_id = other.id
        AND photos.deleted_at IS NULL
        AND photos.moderation_state = 'APPROVED'
      ORDER BY position ASC, created_at ASC
      LIMIT 1
    ) ph ON true
    WHERE m.id = $1 AND (m.user_a = $2 OR m.user_b = $2) AND m.state = 'ACTIVE'
    `,
    [matchId, viewerId],
  );
  return rows[0] ?? null;
}
