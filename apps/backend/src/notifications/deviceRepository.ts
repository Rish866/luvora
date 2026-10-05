import crypto from "node:crypto";
import { query } from "../db/pool";
import {
  DevicePlatform,
  PushProviderKind,
  type NotificationDeviceView,
} from "@luvora/shared";

/**
 * Data access for registered push devices.
 *
 * SECURITY: the raw `token` column is a credential. `toView` NEVER includes it,
 * and the only method that returns it (`listActiveWithTokenForUser`) is for the
 * delivery dispatcher's internal use and is clearly named. Tokens are matched
 * by SHA-256 hash for uniqueness/dedup; a short fingerprint is exposed for UI.
 */

export interface DeviceRow {
  id: string;
  user_id: string;
  platform: DevicePlatform;
  provider: PushProviderKind;
  token: string;
  token_hash: string;
  token_fingerprint: string;
  label: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** A short, non-reversible fingerprint (first 12 hex chars of the hash). */
export function fingerprint(token: string): string {
  return hashToken(token).slice(0, 12);
}

/** Safe DTO — never includes the raw token or its full hash. */
export function toView(row: DeviceRow): NotificationDeviceView {
  return {
    id: row.id,
    platform: row.platform,
    provider: row.provider,
    tokenFingerprint: row.token_fingerprint,
    label: row.label,
    active: row.revoked_at === null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export interface RegisterInput {
  userId: string;
  platform: DevicePlatform;
  provider: PushProviderKind;
  token: string;
  label: string | null;
}

/**
 * Register (or refresh) a device, idempotently. Keyed on the partial unique
 * index (user_id, token_hash) WHERE revoked_at IS NULL, so re-registering the
 * same active token updates it in place rather than creating a duplicate. A
 * previously-revoked token re-registers as a fresh active row.
 */
export async function register(input: RegisterInput): Promise<DeviceRow> {
  const tokenHash = hashToken(input.token);
  const fp = fingerprint(input.token);
  const rows = await query<DeviceRow>(
    `INSERT INTO notification_devices
       (user_id, platform, provider, token, token_hash, token_fingerprint, label, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (user_id, token_hash) WHERE revoked_at IS NULL
       DO UPDATE SET
         platform = EXCLUDED.platform,
         provider = EXCLUDED.provider,
         label = EXCLUDED.label,
         last_seen_at = now(),
         updated_at = now()
     RETURNING *`,
    [input.userId, input.platform, input.provider, input.token, tokenHash, fp, input.label],
  );
  return rows[0];
}

/** List a user's devices (safe rows; still carry the token column internally). */
export async function listForUser(userId: string): Promise<DeviceRow[]> {
  return query<DeviceRow>(
    `SELECT * FROM notification_devices
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [userId],
  );
}

/** Active (non-revoked) devices for a user, INCLUDING the raw token. For the
 *  delivery dispatcher's internal use only — never surface the result to a
 *  client. */
export async function listActiveWithTokenForUser(userId: string): Promise<DeviceRow[]> {
  return query<DeviceRow>(
    `SELECT * FROM notification_devices
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [userId],
  );
}

export async function getOwned(userId: string, id: string): Promise<DeviceRow | null> {
  const rows = await query<DeviceRow>(
    `SELECT * FROM notification_devices WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/** Fetch a device by id (internal; row carries the raw token). */
export async function getById(id: string): Promise<DeviceRow | null> {
  const rows = await query<DeviceRow>(
    `SELECT * FROM notification_devices WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Revoke a device scoped to its owner. Returns true if an owned, non-revoked
 *  row was revoked (idempotent: already-revoked still returns true if owned). */
export async function revokeOwned(userId: string, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE notification_devices
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND user_id = $2
      RETURNING id`,
    [id, userId],
  );
  return rows.length > 0;
}

/** Revoke a device by id (used when a provider reports a permanently invalid
 *  token). Idempotent. */
export async function revokeById(id: string): Promise<void> {
  await query(
    `UPDATE notification_devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
    [id],
  );
}

/** Delete devices revoked before the cutoff (operational cleanup). */
export async function deleteRevokedBefore(cutoff: Date): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM notification_devices
      WHERE revoked_at IS NOT NULL AND revoked_at <= $1
      RETURNING id`,
    [cutoff.toISOString()],
  );
  return rows.length;
}
