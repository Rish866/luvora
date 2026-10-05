import { query, withTransaction } from "../db/pool";

/**
 * Data access for discovery & matching. All SQL is parameterized and all
 * filtering happens in the database — we never load the user table and filter
 * in JavaScript.
 */

/** A discovery candidate row as returned by the feed query (DB column names).
 *  Only discovery-appropriate columns are selected. */
export interface CandidateRow {
  id: string;
  display_name: string;
  bio: string | null;
  interests: string[];
  age_visible: boolean;
  date_of_birth: string;
  created_at: string;
  /** Lossless text form of created_at (microsecond precision preserved) used
   *  for keyset pagination; the Date-based `created_at` round-trips lossily. */
  cursor_created_at: string;
  /** Primary (else first) READY+APPROVED profile photo media id, or null. */
  photo_media_id: string | null;
  /** Whether that media has a thumbnail variant. */
  photo_has_thumbnail: boolean | null;
}

export interface FeedCursor {
  createdAt: string;
  id: string;
}

/**
 * Discovery feed query.
 *
 * Returns eligible candidates for `viewerId`, excluding, entirely in SQL:
 *   - the viewer themselves
 *   - users the viewer has already decided on (liked OR passed)
 *   - users blocked by the viewer OR who have blocked the viewer (both ways)
 *   - users already in a match with the viewer (any match row for the pair)
 *   - disabled / soft-deleted / non-discoverable accounts (eligibility)
 *
 * Ordering is deterministic on (users.created_at, users.id) to make keyset
 * pagination stable. The optional cursor continues after a previous page.
 *
 * The first photo (lowest position) that is APPROVED is attached via a LATERAL
 * join, avoiding N+1 queries.
 */
export async function queryFeed(input: {
  viewerId: string;
  limit: number;
  cursor: FeedCursor | null;
}): Promise<CandidateRow[]> {
  const params: unknown[] = [input.viewerId];
  // Keyset predicate (deterministic ordering continuation).
  let cursorPredicate = "";
  if (input.cursor) {
    params.push(input.cursor.createdAt, input.cursor.id);
    cursorPredicate = `AND (u.created_at, u.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(input.limit);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT
      u.id,
      p.display_name,
      p.bio,
      p.interests,
      p.age_visible,
      u.date_of_birth,
      u.created_at,
      u.created_at::text AS cursor_created_at,
      ph.media_id      AS photo_media_id,
      ph.has_thumbnail AS photo_has_thumbnail
    FROM users u
    JOIN profiles p ON p.user_id = u.id
    -- Primary (else lowest-position) profile photo that is a READY+APPROVED
    -- media asset. Standardized on media_assets via profile_photos (0012).
    LEFT JOIN LATERAL (
      SELECT pp.media_id,
             (m.thumbnail_storage_key IS NOT NULL) AS has_thumbnail
      FROM profile_photos pp
      JOIN media_assets m ON m.id = pp.media_id
      WHERE pp.user_id = u.id
        AND m.deleted_at IS NULL
        AND m.status = 'READY'
        AND m.moderation_status = 'APPROVED'
      ORDER BY pp.is_primary DESC, pp.position ASC, pp.created_at ASC
      LIMIT 1
    ) ph ON true
    WHERE u.id <> $1
      AND u.deleted_at IS NULL
      AND u.is_disabled = false
      AND p.discoverable = true
      -- exclude any prior decision by the viewer on this candidate
      AND NOT EXISTS (
        SELECT 1 FROM likes l
        WHERE l.liker_id = $1 AND l.likee_id = u.id
      )
      -- exclude blocks in either direction
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
           OR (b.blocker_id = u.id AND b.blocked_id = $1)
      )
      -- exclude users already in a match with the viewer (canonical pair)
      AND NOT EXISTS (
        SELECT 1 FROM matches m
        WHERE (m.user_a = LEAST($1::uuid, u.id) AND m.user_b = GREATEST($1::uuid, u.id))
      )
      ${cursorPredicate}
    ORDER BY u.created_at ASC, u.id ASC
    LIMIT ${limitParam}
  `;
  return query<CandidateRow>(sql, params);
}

/** True if a block exists in EITHER direction between the two users. */
export async function blockExistsEitherDirection(
  a: string,
  b: string,
): Promise<boolean> {
  const rows = await query(
    `SELECT 1 FROM blocks
      WHERE (blocker_id = $1 AND blocked_id = $2)
         OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [a, b],
  );
  return rows.length > 0;
}

export interface DecisionRow {
  liker_id: string;
  likee_id: string;
  is_pass: boolean;
}

/**
 * Record a discovery decision (LIKE or PASS) as an upsert, so re-deciding
 * updates the single (actor, target) row rather than creating a contradictory
 * second one. Idempotent for repeated identical decisions.
 */
export async function upsertDecision(input: {
  actorId: string;
  targetId: string;
  isPass: boolean;
}): Promise<void> {
  await query(
    `INSERT INTO likes (liker_id, likee_id, is_pass)
     VALUES ($1, $2, $3)
     ON CONFLICT (liker_id, likee_id)
     DO UPDATE SET is_pass = EXCLUDED.is_pass`,
    [input.actorId, input.targetId, input.isPass],
  );
}

/** Does `targetId` have a standing LIKE (not pass) on `actorId`? */
export async function hasLikedBack(
  actorId: string,
  targetId: string,
): Promise<boolean> {
  const rows = await query(
    `SELECT 1 FROM likes
      WHERE liker_id = $1 AND likee_id = $2 AND is_pass = false
      LIMIT 1`,
    [targetId, actorId],
  );
  return rows.length > 0;
}

/**
 * Record a LIKE and, if reciprocal, create the match — atomically and
 * race-safely.
 *
 * Race safety: the whole operation runs in one transaction. The LIKE is
 * upserted, we re-check the reciprocal like, and the match is inserted with
 * `ON CONFLICT (user_a, user_b) DO NOTHING` against the canonical pair. If two
 * reciprocal likes arrive concurrently, at most ONE INSERT succeeds; the other
 * is absorbed by ON CONFLICT. We then read back the single match row.
 *
 * Returns the matchId when a match exists (new or pre-existing), else null.
 */
export async function likeAndMaybeMatch(input: {
  actorId: string;
  targetId: string;
}): Promise<{ matchId: string | null; created: boolean }> {
  return withTransaction(async (client) => {
    const { actorId, targetId } = input;

    // Re-assert no block exists inside the transaction (defense in depth).
    const blocked = await client.query(
      `SELECT 1 FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2)
           OR (blocker_id = $2 AND blocked_id = $1)
        LIMIT 1`,
      [actorId, targetId],
    );
    if (blocked.rowCount && blocked.rowCount > 0) {
      // Surface via a sentinel the service maps to INTERACTION_NOT_ALLOWED.
      throw new BlockedInteractionError();
    }

    // Canonical pair ordering (user_a < user_b) — used for the advisory lock AND
    // the match row so both reciprocal likes agree on the same key/row.
    const [low, high] = actorId < targetId ? [actorId, targetId] : [targetId, actorId];

    // Serialize the reciprocal-check + match-insert critical section for THIS
    // pair with a transaction-scoped advisory lock. Under READ COMMITTED two
    // concurrent reciprocal likes could otherwise each fail to see the other's
    // not-yet-committed LIKE and BOTH skip match creation (resulting in zero
    // matches). The lock makes the outcome deterministic: whichever transaction
    // commits its LIKE first, the second observes it and creates the match. The
    // key is a stable hash of the canonical pair (two 32-bit ints for
    // pg_advisory_xact_lock(int4, int4)).
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [
      pairLockKey(low),
      pairLockKey(high),
    ]);

    // Upsert the LIKE decision.
    await client.query(
      `INSERT INTO likes (liker_id, likee_id, is_pass)
       VALUES ($1, $2, false)
       ON CONFLICT (liker_id, likee_id)
       DO UPDATE SET is_pass = false`,
      [actorId, targetId],
    );

    // Reciprocal like?
    const reciprocal = await client.query(
      `SELECT 1 FROM likes
        WHERE liker_id = $1 AND likee_id = $2 AND is_pass = false
        LIMIT 1`,
      [targetId, actorId],
    );
    if (!reciprocal.rowCount) {
      return { matchId: null, created: false };
    }

    // (canonical pair `low`/`high` computed above, used for the match row)

    // Race-safe insert: ON CONFLICT absorbs a concurrent duplicate. `created`
    // is true only for the insert that actually produced the row, so a caller
    // can notify exactly once (no duplicate match-notification storm).
    const insertRes = await client.query(
      `INSERT INTO matches (user_a, user_b, state)
       VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (user_a, user_b) DO NOTHING`,
      [low, high],
    );
    const created = (insertRes.rowCount ?? 0) > 0;

    // Read back the single match row for this pair (ACTIVE only — a previously
    // BLOCKED match is not resurrected here).
    const match = await client.query<{ id: string }>(
      `SELECT id FROM matches
        WHERE user_a = $1 AND user_b = $2 AND state = 'ACTIVE'`,
      [low, high],
    );
    return { matchId: match.rows[0]?.id ?? null, created };
  });
}

/** Sentinel thrown inside the like transaction when a block is present. */
export class BlockedInteractionError extends Error {
  constructor() {
    super("Blocked interaction");
    this.name = "BlockedInteractionError";
  }
}

/** Derive a stable signed 32-bit int from a UUID for pg_advisory_xact_lock.
 *  Collisions only cause harmless extra serialization between unrelated pairs,
 *  never incorrect matching. */
function pairLockKey(userId: string): number {
  const hex = userId.replace(/-/g, "").slice(0, 8);
  // Parse as unsigned 32-bit, then map into signed int4 range.
  const u = parseInt(hex, 16) >>> 0;
  return u | 0;
}
