import { query, withTransaction } from "../db/pool";

/**
 * Data access for conversations, messages, and read state. All SQL is
 * parameterized; all per-conversation reads are keyset-indexed.
 */

export interface ConversationRow {
  id: string;
  match_id: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  client_message_id: string | null;
  created_at: string;
  /** Lossless text form of created_at for keyset pagination. */
  cursor_created_at?: string;
}

/**
 * Get the conversation for a match, creating it lazily and race-safely.
 * UNIQUE(match_id) + ON CONFLICT guarantees exactly one conversation even under
 * concurrent first-opens.
 */
export async function getOrCreateConversationForMatch(
  matchId: string,
): Promise<ConversationRow> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO conversations (match_id)
       VALUES ($1)
       ON CONFLICT (match_id) DO NOTHING`,
      [matchId],
    );
    const { rows } = await client.query<ConversationRow>(
      `SELECT id, match_id, created_at, updated_at
         FROM conversations WHERE match_id = $1`,
      [matchId],
    );
    return rows[0];
  });
}

/** Ensure a conversation row exists for each given match (batch, race-safe).
 *  Idempotent via UNIQUE(match_id) + ON CONFLICT. Used by the inbox so every
 *  match row carries a stable conversation id. */
export async function ensureConversationsForMatches(matchIds: string[]): Promise<void> {
  if (matchIds.length === 0) return;
  await query(
    `INSERT INTO conversations (match_id)
       SELECT unnest($1::uuid[])
     ON CONFLICT (match_id) DO NOTHING`,
    [matchIds],
  );
}

export async function getConversationById(
  conversationId: string,
): Promise<ConversationRow | null> {
  const rows = await query<ConversationRow>(
    `SELECT id, match_id, created_at, updated_at
       FROM conversations WHERE id = $1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

export interface MessagePage {
  messages: MessageRow[];
}

/**
 * Fetch a page of messages for a conversation, oldest→newest, using keyset
 * pagination on (created_at, id). `before` continues *backwards* in history
 * (older than the cursor), which matches typical chat scroll-up behavior.
 */
export async function listMessages(input: {
  conversationId: string;
  limit: number;
  before: { createdAt: string; id: string } | null;
}): Promise<MessageRow[]> {
  const params: unknown[] = [input.conversationId];
  let keyset = "";
  if (input.before) {
    params.push(input.before.createdAt, input.before.id);
    keyset = `AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(input.limit);
  const limitParam = `$${params.length}`;

  // Select the newest `limit` rows older than the cursor (DESC), then the
  // service reverses them so the page reads oldest→newest.
  const rows = await query<MessageRow>(
    `SELECT id, conversation_id, sender_id, body, client_message_id,
            created_at, created_at::text AS cursor_created_at
       FROM messages
      WHERE conversation_id = $1
        ${keyset}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam}`,
    params,
  );
  return rows;
}

/**
 * Insert a message, honouring client idempotency. If `clientMessageId` is
 * supplied and a message with the same (conversation, sender, clientMessageId)
 * already exists, the existing row is returned instead of inserting a duplicate
 * — race-safe via the UNIQUE partial index + ON CONFLICT.
 */
export async function insertMessage(input: {
  conversationId: string;
  senderId: string;
  body: string;
  clientMessageId: string | null;
}): Promise<MessageRow> {
  return withTransaction(async (client) => {
    if (input.clientMessageId) {
      const existing = await client.query<MessageRow>(
        `SELECT id, conversation_id, sender_id, body, client_message_id, created_at
           FROM messages
          WHERE conversation_id = $1 AND sender_id = $2 AND client_message_id = $3`,
        [input.conversationId, input.senderId, input.clientMessageId],
      );
      if (existing.rows[0]) return existing.rows[0];
    }

    const inserted = await client.query<MessageRow>(
      `INSERT INTO messages (conversation_id, sender_id, body, client_message_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (conversation_id, sender_id, client_message_id)
         WHERE client_message_id IS NOT NULL
         DO NOTHING
       RETURNING id, conversation_id, sender_id, body, client_message_id, created_at`,
      [input.conversationId, input.senderId, input.body, input.clientMessageId],
    );

    if (inserted.rows[0]) {
      // Touch the conversation's updated_at so match/chat lists can sort by it.
      await client.query(
        `UPDATE conversations SET updated_at = now() WHERE id = $1`,
        [input.conversationId],
      );
      return inserted.rows[0];
    }

    // ON CONFLICT DO NOTHING fired (a concurrent duplicate won) — read it back.
    const raced = await client.query<MessageRow>(
      `SELECT id, conversation_id, sender_id, body, client_message_id, created_at
         FROM messages
        WHERE conversation_id = $1 AND sender_id = $2 AND client_message_id = $3`,
      [input.conversationId, input.senderId, input.clientMessageId],
    );
    return raced.rows[0];
  });
}

import { MediaStatus, MediaModerationStatus } from "@luvora/shared";
import * as mediaRepo from "../media/mediaRepository";
import { Errors } from "../http/errors";
import { config } from "../config";

export interface AttachmentValidationInput {
  attachmentIds: string[];
  senderId: string;
}

/**
 * Insert a message AND its attachment relationships atomically, validating each
 * attachment inside the same transaction (ownership, READY+APPROVED, correct
 * context, not deleted). Honors clientMessageId idempotency: a retry returns the
 * existing message without creating duplicate attachment rows.
 *
 * All attachment checks happen server-side; a failure rolls back the whole
 * message so no partial state is created.
 */
export async function insertMessageWithAttachments(input: {
  conversationId: string;
  senderId: string;
  body: string;
  clientMessageId: string | null;
  attachmentIds: string[];
}): Promise<MessageRow> {
  return withTransaction(async (client) => {
    // Idempotency: an existing message for this (conversation,sender,cmid)
    // short-circuits (attachments were already linked on the first insert).
    if (input.clientMessageId) {
      const existing = await client.query<MessageRow>(
        `SELECT id, conversation_id, sender_id, body, client_message_id, created_at
           FROM messages
          WHERE conversation_id = $1 AND sender_id = $2 AND client_message_id = $3`,
        [input.conversationId, input.senderId, input.clientMessageId],
      );
      if (existing.rows[0]) return existing.rows[0];
    }

    // Validate attachments (if any) under row locks to avoid TOCTOU races with
    // a concurrent delete/moderation change.
    if (input.attachmentIds.length > 0) {
      if (input.attachmentIds.length > config.media.maxAttachmentsPerMessage) {
        throw Errors.tooManyAttachments();
      }
      // De-duplicate ids defensively.
      const uniqueIds = [...new Set(input.attachmentIds)];
      const locked = await mediaRepo.lockMediaByIds(client, uniqueIds);
      const byId = new Map(locked.map((m) => [m.id, m]));

      let totalBytes = 0;
      for (const id of uniqueIds) {
        const m = byId.get(id);
        // Unknown / not owned by sender -> generic not-authorized (no leak).
        if (!m || m.owner_id !== input.senderId) {
          throw Errors.mediaNotAuthorized();
        }
        if (m.deleted_at || m.status === MediaStatus.DELETED) {
          throw Errors.mediaNotFound();
        }
        if (m.status !== MediaStatus.READY) {
          throw Errors.mediaNotReady();
        }
        if (m.moderation_status !== MediaModerationStatus.APPROVED) {
          throw Errors.mediaRejected();
        }
        totalBytes += m.byte_size ? Number(m.byte_size) : 0;
      }
      if (totalBytes > config.media.maxTotalMessageBytes) {
        throw Errors.attachmentsTooLarge();
      }

      // Insert the message, then link attachments.
      const inserted = await insertMessageRow(client, input);
      let order = 0;
      for (const id of uniqueIds) {
        await mediaRepo.insertAttachment(client, {
          messageId: inserted.id,
          mediaId: id,
          sortOrder: order++,
        });
      }
      await client.query(
        `UPDATE conversations SET updated_at = now() WHERE id = $1`,
        [input.conversationId],
      );
      return inserted;
    }

    // No attachments: plain message insert.
    const inserted = await insertMessageRow(client, input);
    await client.query(
      `UPDATE conversations SET updated_at = now() WHERE id = $1`,
      [input.conversationId],
    );
    return inserted;
  });
}

/** Insert a single message row, handling the ON CONFLICT idempotency path. */
async function insertMessageRow(
  client: import("pg").PoolClient,
  input: {
    conversationId: string;
    senderId: string;
    body: string;
    clientMessageId: string | null;
  },
): Promise<MessageRow> {
  const inserted = await client.query<MessageRow>(
    `INSERT INTO messages (conversation_id, sender_id, body, client_message_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (conversation_id, sender_id, client_message_id)
       WHERE client_message_id IS NOT NULL
       DO NOTHING
     RETURNING id, conversation_id, sender_id, body, client_message_id, created_at`,
    [input.conversationId, input.senderId, input.body, input.clientMessageId],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const raced = await client.query<MessageRow>(
    `SELECT id, conversation_id, sender_id, body, client_message_id, created_at
       FROM messages
      WHERE conversation_id = $1 AND sender_id = $2 AND client_message_id = $3`,
    [input.conversationId, input.senderId, input.clientMessageId],
  );
  return raced.rows[0];
}

/** Does the message belong to the given conversation? */
export async function messageBelongsToConversation(
  messageId: string,
  conversationId: string,
): Promise<boolean> {
  const rows = await query(
    `SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 LIMIT 1`,
    [messageId, conversationId],
  );
  return rows.length > 0;
}

/** Upsert the per-user read marker for a conversation. */
export async function setReadMarker(input: {
  conversationId: string;
  userId: string;
  lastReadMessageId: string;
}): Promise<void> {
  await query(
    `INSERT INTO conversation_read_state (conversation_id, user_id, last_read_message_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (conversation_id, user_id)
     DO UPDATE SET last_read_message_id = EXCLUDED.last_read_message_id,
                   updated_at = now()`,
    [input.conversationId, input.userId, input.lastReadMessageId],
  );
}

// ---- Inbox contract (Increment 15) ----

/** The id + created_at of the most recent message in a conversation (any
 *  sender), or null when the conversation has no messages. */
export async function latestMessageId(
  conversationId: string,
): Promise<{ id: string; created_at: string } | null> {
  const rows = await query<{ id: string; created_at: string }>(
    `SELECT id, created_at FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

/**
 * Advance a user's read marker to the newest message in the conversation
 * (idempotent). "Reading" a conversation clears unread for that user. Marking a
 * conversation with no messages is a safe no-op. Returns the message id the
 * marker now points at (or null if there were no messages).
 */
export async function markConversationRead(input: {
  conversationId: string;
  userId: string;
}): Promise<{ lastReadMessageId: string | null }> {
  return withTransaction(async (client) => {
    const latest = await client.query<{ id: string }>(
      `SELECT id FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [input.conversationId],
    );
    const lastId = latest.rows[0]?.id ?? null;
    if (!lastId) {
      // No messages yet: ensure a read-state row exists (marker null) so the
      // user's "read" intent is recorded; unread is already 0.
      await client.query(
        `INSERT INTO conversation_read_state (conversation_id, user_id, last_read_message_id)
         VALUES ($1, $2, NULL)
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [input.conversationId, input.userId],
      );
      return { lastReadMessageId: null };
    }
    await client.query(
      `INSERT INTO conversation_read_state (conversation_id, user_id, last_read_message_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, user_id)
       DO UPDATE SET last_read_message_id = EXCLUDED.last_read_message_id,
                     updated_at = now()`,
      [input.conversationId, input.userId, lastId],
    );
    return { lastReadMessageId: lastId };
  });
}

/**
 * Unread count for a single conversation + viewer. Unread = messages sent by
 * the OTHER participant that are newer than the viewer's read marker. The
 * marker references a message; we compare on (created_at, id) against that
 * message. When there is no marker, all partner messages are unread.
 */
export async function unreadCountForConversation(input: {
  conversationId: string;
  viewerId: string;
}): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM messages m
       LEFT JOIN conversation_read_state rs
         ON rs.conversation_id = m.conversation_id AND rs.user_id = $2
       LEFT JOIN messages marker ON marker.id = rs.last_read_message_id
      WHERE m.conversation_id = $1
        AND m.sender_id <> $2
        AND (
          marker.id IS NULL
          OR (m.created_at, m.id) > (marker.created_at, marker.id)
        )`,
    [input.conversationId, input.viewerId],
  );
  return rows[0]?.n ?? 0;
}

export interface InboxMetaRow {
  conversation_id: string;
  match_id: string;
  unread_count: number;
  last_message_id: string | null;
  last_message_body: string | null;
  last_message_sender_id: string | null;
  last_message_created_at: string | null;
  last_message_has_attachments: boolean | null;
}

/**
 * Batch inbox metadata for a set of matches/conversations for one viewer: the
 * last message (any sender) + the viewer's unread count, computed in ONE query
 * (no N+1). Conversations are matched by match_id so this composes with the
 * existing match list. Matches with no conversation/messages yield unread 0 and
 * a null last message.
 */
export async function getInboxMetaForMatches(input: {
  viewerId: string;
  matchIds: string[];
}): Promise<InboxMetaRow[]> {
  if (input.matchIds.length === 0) return [];
  return query<InboxMetaRow>(
    `SELECT
        c.id         AS conversation_id,
        c.match_id   AS match_id,
        COALESCE(uc.n, 0)::int AS unread_count,
        lm.id        AS last_message_id,
        lm.body      AS last_message_body,
        lm.sender_id AS last_message_sender_id,
        lm.created_at::text AS last_message_created_at,
        lm.has_attachments  AS last_message_has_attachments
       FROM conversations c
       -- Most recent message in the conversation (any sender).
       LEFT JOIN LATERAL (
         SELECT id, body, sender_id, created_at,
                EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = messages.id)
                  AS has_attachments
           FROM messages
          WHERE conversation_id = c.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) lm ON true
       -- Viewer's unread count: partner messages newer than their read marker.
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n
           FROM messages m
           LEFT JOIN conversation_read_state rs
             ON rs.conversation_id = c.id AND rs.user_id = $1
           LEFT JOIN messages marker ON marker.id = rs.last_read_message_id
          WHERE m.conversation_id = c.id
            AND m.sender_id <> $1
            AND (
              marker.id IS NULL
              OR (m.created_at, m.id) > (marker.created_at, marker.id)
            )
       ) uc ON true
      WHERE c.match_id = ANY($2::uuid[])`,
    [input.viewerId, input.matchIds],
  );
}

/**
 * Total unread across ALL of the viewer's ACTIVE matches: sum of partner
 * messages newer than the viewer's per-conversation read marker. Computed from
 * existing message/read state only (no counter table). Scoped to ACTIVE matches
 * with no block, mirroring chat visibility.
 */
export async function totalUnreadForUser(viewerId: string): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN matches mt ON mt.id = c.match_id
       LEFT JOIN conversation_read_state rs
         ON rs.conversation_id = c.id AND rs.user_id = $1
       LEFT JOIN messages marker ON marker.id = rs.last_read_message_id
      WHERE (mt.user_a = $1 OR mt.user_b = $1)
        AND mt.state = 'ACTIVE'
        AND m.sender_id <> $1
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = mt.user_a AND b.blocked_id = mt.user_b)
              OR (b.blocker_id = mt.user_b AND b.blocked_id = mt.user_a)
        )
        AND (
          marker.id IS NULL
          OR (m.created_at, m.id) > (marker.created_at, marker.id)
        )`,
    [viewerId],
  );
  return rows[0]?.n ?? 0;
}
