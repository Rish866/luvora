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
