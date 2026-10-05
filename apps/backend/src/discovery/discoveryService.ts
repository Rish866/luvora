import {
  DiscoveryAction,
  type DiscoveryActionResult,
  type DiscoveryCandidate,
  type MatchSummary,
} from "@luvora/shared";
import { Errors } from "../http/errors";
import * as users from "../users/userRepository";
import * as repo from "./discoveryRepository";
import * as blocks from "./blockRepository";
import * as matches from "./matchRepository";
import { toCandidate, toMatchSummary } from "./discoverySerializer";
import {
  decodeCursor,
  encodeCursor,
} from "./discoverySchemas";

/**
 * Server-authoritative discovery & matching.
 *
 * Invariants enforced here:
 *  - A user never acts on themselves (CANNOT_INTERACT_WITH_SELF).
 *  - The target must exist and be an eligible, live account (USER_NOT_FOUND).
 *  - A block in EITHER direction blocks interaction, surfaced generically as
 *    INTERACTION_NOT_ALLOWED (never revealing who blocked whom).
 *  - A match is created ONLY by the server, ONLY on reciprocal likes, and the
 *    creation is race-safe (see repo.likeAndMaybeMatch).
 */

/** Validate the target of a discovery action and return its row. */
async function requireValidTarget(
  actorId: string,
  targetId: string,
): Promise<users.UserRow> {
  if (actorId === targetId) {
    throw Errors.cannotInteractWithSelf();
  }
  const target = await users.findById(targetId);
  // findById already filters soft-deleted; also treat disabled as not found so
  // we don't leak the existence of ineligible accounts.
  if (!target || target.is_disabled) {
    throw Errors.userNotFound();
  }
  return target;
}

export interface FeedPage {
  candidates: DiscoveryCandidate[];
  nextCursor: string | null;
}

export async function getFeed(input: {
  viewerId: string;
  limit: number;
  cursorRaw?: string;
}): Promise<FeedPage> {
  let cursor = null as ReturnType<typeof decodeCursor>;
  if (input.cursorRaw) {
    cursor = decodeCursor(input.cursorRaw);
    if (!cursor) {
      throw Errors.validation("Invalid pagination cursor.");
    }
  }

  const rows = await repo.queryFeed({
    viewerId: input.viewerId,
    limit: input.limit,
    cursor,
  });

  const candidates = rows.map(toCandidate);
  // There may be more results iff we filled the page.
  const nextCursor =
    rows.length === input.limit
      ? encodeCursor({
          // Use the lossless text form so the keyset boundary is exact.
          createdAt: rows[rows.length - 1].cursor_created_at,
          id: rows[rows.length - 1].id,
        })
      : null;

  return { candidates, nextCursor };
}

export async function like(
  actorId: string,
  targetId: string,
): Promise<DiscoveryActionResult> {
  await requireValidTarget(actorId, targetId);

  try {
    const { matchId } = await repo.likeAndMaybeMatch({ actorId, targetId });
    return {
      action: DiscoveryAction.LIKE,
      userId: targetId,
      matched: matchId !== null,
      matchId,
    };
  } catch (err) {
    if (err instanceof repo.BlockedInteractionError) {
      throw Errors.interactionNotAllowed();
    }
    throw err;
  }
}

export async function pass(
  actorId: string,
  targetId: string,
): Promise<DiscoveryActionResult> {
  await requireValidTarget(actorId, targetId);

  // A block in either direction already excludes the candidate from discovery;
  // recording a pass on a blocked user is harmless but we keep behavior
  // consistent with like by rejecting blocked interactions generically.
  if (await repo.blockExistsEitherDirection(actorId, targetId)) {
    throw Errors.interactionNotAllowed();
  }

  // Upsert decision as PASS. Idempotent; converts a prior LIKE into a PASS.
  await repo.upsertDecision({ actorId, targetId, isPass: true });

  // A pass never creates a match.
  return {
    action: DiscoveryAction.PASS,
    userId: targetId,
    matched: false,
    matchId: null,
  };
}

export async function block(
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await requireValidTarget(blockerId, blockedId);
  await blocks.createBlock({ blockerId, blockedId });
}

export async function unblock(
  blockerId: string,
  blockedId: string,
): Promise<void> {
  if (blockerId === blockedId) {
    throw Errors.cannotInteractWithSelf();
  }
  // Unblocking a non-existent target or non-existent block is a safe no-op
  // (idempotent). We still validate the UUID at the route layer.
  await blocks.removeBlock({ blockerId, blockedId });
}

export async function listMatches(viewerId: string): Promise<MatchSummary[]> {
  const rows = await matches.listMatchesForUser(viewerId);
  return rows.map(toMatchSummary);
}

export async function getMatch(
  matchId: string,
  viewerId: string,
): Promise<MatchSummary> {
  // Distinguish "doesn't exist" from "exists but not yours" without leaking the
  // relationship: a non-participant gets MATCH_NOT_AUTHORIZED (403), a truly
  // missing match gets MATCH_NOT_FOUND (404).
  const base = await matches.getMatchById(matchId);
  if (!base) {
    throw Errors.matchNotFound();
  }
  if (base.user_a !== viewerId && base.user_b !== viewerId) {
    throw Errors.matchNotAuthorized();
  }
  const detail = await matches.getMatchDetailForUser(matchId, viewerId);
  if (!detail) {
    // Participant, but the match is not ACTIVE (e.g. BLOCKED) — treat as gone.
    throw Errors.matchNotFound();
  }
  return toMatchSummary(detail);
}
