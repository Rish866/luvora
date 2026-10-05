import { withTransaction, query } from "../db/pool";

/**
 * Block / unblock data access.
 *
 * Blocking is idempotent (ON CONFLICT DO NOTHING) and, in the same
 * transaction, invalidates any existing match between the two users by setting
 * its state to BLOCKED — so a blocked relationship stops appearing in active
 * match listings and discovery immediately.
 */

export async function createBlock(input: {
  blockerId: string;
  blockedId: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO blocks (blocker_id, blocked_id)
       VALUES ($1, $2)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [input.blockerId, input.blockedId],
    );

    // Invalidate any existing match for the canonical pair.
    const [low, high] =
      input.blockerId < input.blockedId
        ? [input.blockerId, input.blockedId]
        : [input.blockedId, input.blockerId];
    await client.query(
      `UPDATE matches SET state = 'BLOCKED'
        WHERE user_a = $1 AND user_b = $2 AND state <> 'BLOCKED'`,
      [low, high],
    );
  });
}

/**
 * Remove a block. Idempotent. Deliberately does NOT recreate a match, restore
 * old likes, or undo historical decisions — a BLOCKED match stays BLOCKED.
 */
export async function removeBlock(input: {
  blockerId: string;
  blockedId: string;
}): Promise<void> {
  await query(
    `DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
    [input.blockerId, input.blockedId],
  );
}
