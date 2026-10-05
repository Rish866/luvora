import { query } from "../db/pool";
import type { PoolClient } from "pg";
import {
  NotificationType,
  NotificationCategory,
  type NotificationView,
  type NotificationPreferenceView,
} from "@luvora/shared";

/**
 * Data access for notifications + preferences. All SQL parameterized; feed and
 * unread-count queries are backed by dedicated indexes.
 */

export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  dedupe_key: string | null;
  read_at: string | null;
  expires_at: string | null;
  created_at: string;
  cursor_created_at?: string;
}

export function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export interface InsertNotificationInput {
  userId: string;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  dedupeKey: string | null;
  expiresAt: Date | null;
}

/**
 * Insert a notification, honouring the (user, dedupe_key) uniqueness. If a
 * dedupe key is supplied and a row already exists, the existing row is returned
 * and `created` is false — so the same event processed twice yields one logical
 * notification. Optionally participates in a caller transaction via `client`.
 */
export async function insertNotification(
  input: InsertNotificationInput,
  client?: PoolClient,
): Promise<{ row: NotificationRow; created: boolean }> {
  const run = (sql: string, params: unknown[]): Promise<NotificationRow[]> =>
    client
      ? client.query<NotificationRow>(sql, params as never[]).then((r) => r.rows)
      : query<NotificationRow>(sql, params);

  const inserted = await run(
    `INSERT INTO notifications
       (user_id, type, category, title, body, entity_type, entity_id, dedupe_key, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      input.userId,
      input.type,
      input.category,
      input.title,
      input.body,
      input.entityType,
      input.entityId,
      input.dedupeKey,
      input.expiresAt ? input.expiresAt.toISOString() : null,
    ],
  );
  if (inserted[0]) return { row: inserted[0], created: true };

  // Conflict fired — read back the existing row for this dedupe key.
  const existing = await run(
    `SELECT * FROM notifications WHERE user_id = $1 AND dedupe_key = $2`,
    [input.userId, input.dedupeKey],
  );
  return { row: existing[0], created: false };
}

export interface FeedQuery {
  userId: string;
  limit: number;
  unreadOnly: boolean;
  before: { createdAt: string; id: string } | null;
}

export async function listForUser(q: FeedQuery): Promise<NotificationRow[]> {
  const params: unknown[] = [q.userId];
  let keyset = "";
  if (q.before) {
    params.push(q.before.createdAt, q.before.id);
    keyset = `AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(q.limit);
  const limitParam = `$${params.length}`;
  const unread = q.unreadOnly ? "AND read_at IS NULL" : "";
  return query<NotificationRow>(
    `SELECT *, created_at::text AS cursor_created_at
       FROM notifications
      WHERE user_id = $1
        AND (expires_at IS NULL OR expires_at > now())
        ${unread}
        ${keyset}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam}`,
    params,
  );
}

export async function unreadCount(userId: string): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications
      WHERE user_id = $1 AND read_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

/** Mark one notification read, scoped to its owner. Returns true if a row
 *  belonging to the user was affected (idempotent: already-read still true). */
export async function markRead(userId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE notifications
        SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND user_id = $2
      RETURNING id`,
    [id, userId],
  );
  return rows.length > 0;
}

export async function markAllRead(userId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notifications SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL
      RETURNING id`,
    [userId],
  );
  return rows.length;
}

export async function getOwned(userId: string, id: string): Promise<NotificationRow | null> {
  const rows = await query<NotificationRow>(
    `SELECT * FROM notifications WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/** Delete expired notifications (operational cleanup; idempotent). */
export async function deleteExpired(): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM notifications WHERE expires_at IS NOT NULL AND expires_at <= now() RETURNING id`,
  );
  return rows.length;
}

// ---- Preferences ----

export async function listPreferences(userId: string): Promise<Map<NotificationCategory, boolean>> {
  const rows = await query<{ category: NotificationCategory; enabled: boolean }>(
    `SELECT category, enabled FROM notification_preferences WHERE user_id = $1`,
    [userId],
  );
  const map = new Map<NotificationCategory, boolean>();
  for (const r of rows) map.set(r.category, r.enabled);
  return map;
}

/** True if the category is enabled for the user. Missing preference = default
 *  enabled (lazy default; no init race). */
export async function isCategoryEnabled(
  userId: string,
  category: NotificationCategory,
): Promise<boolean> {
  const rows = await query<{ enabled: boolean }>(
    `SELECT enabled FROM notification_preferences WHERE user_id = $1 AND category = $2`,
    [userId, category],
  );
  if (rows.length === 0) return true; // default-enabled
  return rows[0].enabled;
}

export async function upsertPreference(
  userId: string,
  category: NotificationCategory,
  enabled: boolean,
): Promise<void> {
  await query(
    `INSERT INTO notification_preferences (user_id, category, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, category)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [userId, category, enabled],
  );
}

export function toPreferenceViews(
  stored: Map<NotificationCategory, boolean>,
  all: NotificationCategory[],
): NotificationPreferenceView[] {
  return all.map((category) => ({ category, enabled: stored.get(category) ?? true }));
}
