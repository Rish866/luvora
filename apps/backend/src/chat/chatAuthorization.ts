import { query } from "../db/pool";
import { Errors } from "../http/errors";
import * as chatRepo from "./chatRepository";

/**
 * Central chat authorization. Every chat operation (HTTP history, HTTP send,
 * WebSocket send, read receipts, typing, presence) MUST pass through one of
 * these helpers so authorization is identical everywhere.
 *
 * Authorization always derives from the authenticated user id + the database
 * relationship — never from client-provided ids. Knowing a matchId or
 * conversationId is never sufficient on its own.
 */

export interface ChatContext {
  conversationId: string;
  matchId: string;
  /** The authenticated user. */
  userId: string;
  /** The other participant in the match. */
  partnerId: string;
}

interface MatchRow {
  id: string;
  user_a: string;
  user_b: string;
  state: string;
}

async function loadMatch(matchId: string): Promise<MatchRow | null> {
  const rows = await query<MatchRow>(
    `SELECT id, user_a, user_b, state FROM matches WHERE id = $1`,
    [matchId],
  );
  return rows[0] ?? null;
}

/**
 * Shared check: the user participates in the match, the match is ACTIVE, and
 * there is no block in either direction. Blocked/ineligible relationships
 * surface as the generic CHAT_NOT_AUTHORIZED, so a caller can't distinguish
 * "not a participant" from "blocked".
 */
async function assertEligible(match: MatchRow, userId: string): Promise<string> {
  if (match.user_a !== userId && match.user_b !== userId) {
    throw Errors.chatNotAuthorized();
  }
  if (match.state !== "ACTIVE") {
    // A BLOCKED/UNMATCHED match is not usable for chat. We use the generic
    // chat-authorization error for BLOCKED so block details never leak; a
    // plain inactive match is reported distinctly for client UX.
    if (match.state === "BLOCKED") throw Errors.chatNotAuthorized();
    throw Errors.matchNotActive();
  }
  const partnerId = match.user_a === userId ? match.user_b : match.user_a;

  // Defense in depth: even if a match somehow remained ACTIVE, reject if a
  // block exists in either direction.
  const blocked = await query(
    `SELECT 1 FROM blocks
      WHERE (blocker_id = $1 AND blocked_id = $2)
         OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [userId, partnerId],
  );
  if (blocked.length > 0) {
    throw Errors.chatNotAuthorized();
  }
  return partnerId;
}

/**
 * Authorize chat access by matchId, resolving (and lazily creating) the
 * conversation. Used by the REST endpoints under /api/matches/:matchId/messages.
 */
export async function authorizeByMatch(
  userId: string,
  matchId: string,
): Promise<ChatContext> {
  const match = await loadMatch(matchId);
  if (!match) {
    // Do not reveal existence; a non-participant on a real match and a missing
    // match both yield the generic chat-authorization error... except we keep
    // MATCH-level 404 semantics consistent with Increment 2 for a truly missing
    // match the caller could never belong to.
    throw Errors.chatNotAuthorized();
  }
  const partnerId = await assertEligible(match, userId);
  const conversation = await chatRepo.getOrCreateConversationForMatch(matchId);
  return { conversationId: conversation.id, matchId, userId, partnerId };
}

/**
 * Authorize chat access by conversationId. Used by the WebSocket gateway and
 * read/typing operations that carry a conversationId. Resolves the backing
 * match and applies the same eligibility checks.
 */
export async function authorizeByConversation(
  userId: string,
  conversationId: string,
): Promise<ChatContext> {
  const conversation = await chatRepo.getConversationById(conversationId);
  if (!conversation) {
    throw Errors.chatNotAuthorized();
  }
  const match = await loadMatch(conversation.match_id);
  if (!match) {
    throw Errors.chatNotAuthorized();
  }
  const partnerId = await assertEligible(match, userId);
  return {
    conversationId: conversation.id,
    matchId: conversation.match_id,
    userId,
    partnerId,
  };
}
