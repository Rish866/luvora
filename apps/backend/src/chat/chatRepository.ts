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
