import {
  DiscoveryAction,
  type DiscoveryActionResult,
  type DiscoveryCandidate,
  type MatchSummary,
  type MatchListResponse,
} from "@luvora/shared";
import { Errors } from "../http/errors";
import * as users from "../users/userRepository";
import * as repo from "./discoveryRepository";
import * as blocks from "./blockRepository";
import * as matches from "./matchRepository";
import * as chatRepo from "../chat/chatRepository";
import { toCandidate, toMatchSummary, type MatchInboxMeta } from "./discoverySerializer";
import {
  decodeCursor,
  encodeCursor,
} from "./discoverySchemas";
import { notifyConversationBlocked } from "../chat/chatGateway";
import * as notifications from "../notifications/notificationService";
import { NotificationType } from "@luvora/shared";

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
    const { matchId, created } = await repo.likeAndMaybeMatch({ actorId, targetId });
    if (matchId && created) {
      // Notify BOTH participants exactly once (only the insert that created the
      // match reports created=true, so concurrent reciprocal likes don't
      // produce duplicate notifications). dedupe_key is a second safety net.
      await notifyMatchCreated(matchId, actorId, targetId);
    }
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

/** Create MATCH_CREATED notifications for both users (idempotent via dedupe). */
async function notifyMatchCreated(
  matchId: string,
  userA: string,
  userB: string,
): Promise<void> {
  for (const [recipient, other] of [
    [userA, userB],
    [userB, userA],
  ] as const) {
    await notifications.create({
      userId: recipient,
      type: NotificationType.MATCH_CREATED,
      title: "New match",
      body: "You have a new match.",
      entityType: "match",
      entityId: matchId,
      // Deterministic per (match, recipient): survives retries + concurrency.
      dedupeKey: `match:${matchId}:created:${recipient}`,
    });
    void other;
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
  const { conversationId } = await blocks.createBlock({ blockerId, blockedId });
  // If the pair had a conversation, notify any live chat sockets so stale
  // connections stop using it. (Enforcement is independent: chat sends are
  // re-authorized on every message against the now-BLOCKED match.)
  if (conversationId) {
    notifyConversationBlocked([blockerId, blockedId], conversationId);
  }
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

/** Map an InboxMetaRow (keyed by match) to the serializer's meta shape. */
function toInboxMeta(row: chatRepo.InboxMetaRow): MatchInboxMeta {
  return {
    conversationId: row.conversation_id,
    unreadCount: row.unread_count,
    lastMessage: row.last_message_id
      ? {
          id: row.last_message_id,
          body: row.last_message_body ?? "",
          senderId: row.last_message_sender_id ?? "",
          createdAt: row.last_message_created_at ?? "",
          hasAttachments: Boolean(row.last_message_has_attachments),
        }
      : null,
  };
}

/** The inbox: the viewer's ACTIVE matches enriched with conversation id, last
 *  message, and unread count, plus a total unread across all of them. The
 *  per-match metadata is fetched in ONE batch query (no N+1). */
export async function listMatches(viewerId: string): Promise<MatchListResponse> {
  const rows = await matches.listMatchesForUser(viewerId);
  const matchIds = rows.map((r) => r.match_id);
  // Ensure every listed match has its (lazily-created) conversation so each
  // inbox row carries a stable conversationId. Idempotent + race-safe.
  await chatRepo.ensureConversationsForMatches(matchIds);
  const metaRows = await chatRepo.getInboxMetaForMatches({ viewerId, matchIds });
  const byMatch = new Map(metaRows.map((m) => [m.match_id, m]));

  const summaries = rows.map((row) => {
    const meta = byMatch.get(row.match_id);
    return toMatchSummary(
      row,
      meta
        ? toInboxMeta(meta)
        : { conversationId: "", unreadCount: 0, lastMessage: null },
    );
  });

  const totalUnreadCount = await chatRepo.totalUnreadForUser(viewerId);
  return { matches: summaries, totalUnreadCount };
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
  // Enrich with inbox metadata (conversation id, last message, unread) so a
  // single match detail is consistent with the inbox list.
  await chatRepo.ensureConversationsForMatches([matchId]);
  const metaRows = await chatRepo.getInboxMetaForMatches({ viewerId, matchIds: [matchId] });
  const meta = metaRows[0]
    ? toInboxMeta(metaRows[0])
    : { conversationId: "", unreadCount: 0, lastMessage: null };
  return toMatchSummary(detail, meta);
}
