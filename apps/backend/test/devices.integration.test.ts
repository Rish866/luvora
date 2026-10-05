import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import { resetDb, registerUser, auth, type RegisteredUser } from "./helpers";

/**
 * Device registration API tests (Increment 8). Covers registration (idempotent),
 * listing (safe metadata only), revocation, IDOR, validation, and — critically —
 * that the raw push token is NEVER returned or stored in a client-visible shape.
 */

let app: Express;

beforeAll(() => {
  app = createApp();
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closePool();
});

const H = (u: RegisteredUser) => auth(u.accessToken);
const register = (u: RegisteredUser, body: Record<string, unknown>) =>
  request(app).post("/api/notifications/devices").set(...H(u)).send(body);
const listDevices = (u: RegisteredUser) =>
  request(app).get("/api/notifications/devices").set(...H(u));

const validDevice = {
  platform: "ANDROID",
  provider: "FCM",
  token: "fcm-token-abcdef-123456",
  label: "Pixel 8",
};

describe("devices: registration", () => {
  it("registers a device and returns safe metadata (never the raw token)", async () => {
    const u = await registerUser(app);
    const res = await register(u, validDevice);
    expect(res.status).toBe(201);
    const d = res.body.data.device;
    expect(d.platform).toBe("ANDROID");
    expect(d.provider).toBe("FCM");
    expect(d.active).toBe(true);
    expect(d.tokenFingerprint).toBeTruthy();
    // The raw token must never appear anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain(validDevice.token);
    expect(d.token).toBeUndefined();
  });

  it("duplicate registration of the same token is idempotent (one active row)", async () => {
    const u = await registerUser(app);
    await register(u, validDevice);
    await register(u, { ...validDevice, label: "renamed" });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM notification_devices WHERE user_id=$1 AND revoked_at IS NULL`,
      [u.userId],
    );
    expect(rows[0].n).toBe(1);
    // The label update is reflected.
    const list = await listDevices(u);
    expect(list.body.data.devices[0].label).toBe("renamed");
  });

  it("rejects an invalid platform / provider / malformed token", async () => {
    const u = await registerUser(app);
    expect((await register(u, { ...validDevice, platform: "WINDOWS" })).status).toBe(400);
    expect((await register(u, { ...validDevice, provider: "SMS" })).status).toBe(400);
    expect((await register(u, { ...validDevice, token: "short" })).status).toBe(400);
  });

  it("ignores a userId supplied in the body (owner is always the caller)", async () => {
    const u = await registerUser(app);
    const other = await registerUser(app);
    await register(u, { ...validDevice, userId: other.userId } as Record<string, unknown>);
    // The device belongs to the caller, not the forged userId.
    const mine = await pool.query(
      `SELECT count(*)::int AS n FROM notification_devices WHERE user_id=$1`,
      [u.userId],
    );
    const theirs = await pool.query(
      `SELECT count(*)::int AS n FROM notification_devices WHERE user_id=$1`,
      [other.userId],
    );
    expect(mine.rows[0].n).toBe(1);
    expect(theirs.rows[0].n).toBe(0);
  });

  it("requires authentication", async () => {
    expect((await request(app).post("/api/notifications/devices").send(validDevice)).status).toBe(401);
    expect((await request(app).get("/api/notifications/devices")).status).toBe(401);
  });
});

describe("devices: listing", () => {
  it("lists only the caller's devices with safe fields and no raw token", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await register(a, validDevice);
    await register(b, { ...validDevice, token: "b-token-xyz-9999" });
    const list = await listDevices(a);
    expect(list.body.data.devices).toHaveLength(1);
    const keys = new Set(Object.keys(list.body.data.devices[0]));
    expect(keys).toEqual(
      new Set([
        "id",
        "platform",
        "provider",
        "tokenFingerprint",
        "label",
        "active",
        "createdAt",
        "lastSeenAt",
        "revokedAt",
      ]),
    );
    expect(JSON.stringify(list.body)).not.toContain(validDevice.token);
  });
});

describe("devices: revocation + IDOR", () => {
  it("the owner can revoke their device (idempotent)", async () => {
    const u = await registerUser(app);
    const reg = await register(u, validDevice);
    const id = reg.body.data.device.id;
    const del1 = await request(app).delete(`/api/notifications/devices/${id}`).set(...H(u));
    expect(del1.status).toBe(200);
    const del2 = await request(app).delete(`/api/notifications/devices/${id}`).set(...H(u));
    expect(del2.status).toBe(200); // idempotent (still owned)
    const { rows } = await pool.query(
      `SELECT revoked_at FROM notification_devices WHERE id=$1`,
      [id],
    );
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it("a user cannot revoke another user's device (IDOR → opaque 404)", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const reg = await register(a, validDevice);
    const id = reg.body.data.device.id;
    const res = await request(app).delete(`/api/notifications/devices/${id}`).set(...H(b));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("DEVICE_NOT_FOUND");
    // a's device is still active.
    const { rows } = await pool.query(`SELECT revoked_at FROM notification_devices WHERE id=$1`, [id]);
    expect(rows[0].revoked_at).toBeNull();
  });

  it("a revoked token can be re-registered as a fresh active device", async () => {
    const u = await registerUser(app);
    const reg = await register(u, validDevice);
    await request(app).delete(`/api/notifications/devices/${reg.body.data.device.id}`).set(...H(u));
    const again = await register(u, validDevice);
    expect(again.status).toBe(201);
    expect(again.body.data.device.active).toBe(true);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM notification_devices WHERE user_id=$1 AND revoked_at IS NULL`,
      [u.userId],
    );
    expect(rows[0].n).toBe(1);
  });
});
