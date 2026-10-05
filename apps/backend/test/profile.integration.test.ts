import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool } from "../src/db/pool";
import { resetDb, registerUser, auth, makeJpeg, uploadImage, type RegisteredUser } from "./helpers";

/**
 * Increment 14 — self-profile API tests (P0-1). Covers GET/PATCH of the
 * authenticated user's own profile, validation, forbidden-field rejection,
 * discoverability toggling, and auth.
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

const getProfile = (u: RegisteredUser) =>
  request(app).get("/api/profile").set(...auth(u.accessToken));
const patchProfile = (u: RegisteredUser, body: Record<string, unknown>) =>
  request(app).patch("/api/profile").set(...auth(u.accessToken)).send(body);

describe("GET /api/profile", () => {
  it("requires authentication", async () => {
    const res = await request(app).get("/api/profile");
    expect(res.status).toBe(401);
  });

  it("returns the caller's own full profile with defaults from registration", async () => {
    const u = await registerUser(app, { displayName: "Alex" });
    const res = await getProfile(u);
    expect(res.status).toBe(200);
    const p = res.body.data.profile;
    expect(p.userId).toBe(u.userId);
    expect(p.displayName).toBe("Alex");
    expect(p.bio).toBeNull();
    expect(p.interests).toEqual([]);
    expect(p.fantasyPreferences).toEqual([]);
    expect(p.discoverable).toBe(true);
    expect(p.ageVisible).toBe(true);
    expect(p.photos).toEqual([]);
    expect(p.primaryPhoto).toBeNull();
    expect(typeof p.profileComplete).toBe("boolean");
  });

  it("never exposes sensitive/internal fields", async () => {
    const u = await registerUser(app);
    const res = await getProfile(u);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toContain("storage_key");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toMatch(/account_status/);
    expect(serialized).not.toMatch(/\brole\b/);
  });
});

describe("PATCH /api/profile", () => {
  it("updates editable fields and returns the new profile", async () => {
    const u = await registerUser(app);
    const res = await patchProfile(u, {
      displayName: "New Name",
      bio: "hi there",
      interests: ["hiking", "coffee"],
      fantasyPreferences: ["roleplay"],
      discoverable: false,
      ageVisible: false,
    });
    expect(res.status).toBe(200);
    const p = res.body.data.profile;
    expect(p.displayName).toBe("New Name");
    expect(p.bio).toBe("hi there");
    expect(p.interests).toEqual(["hiking", "coffee"]);
    expect(p.fantasyPreferences).toEqual(["roleplay"]);
    expect(p.discoverable).toBe(false);
    expect(p.ageVisible).toBe(false);
    // Persisted.
    const after = await getProfile(u);
    expect(after.body.data.profile.displayName).toBe("New Name");
    expect(after.body.data.profile.discoverable).toBe(false);
  });

  it("supports partial updates (only provided fields change)", async () => {
    const u = await registerUser(app, { displayName: "Keep" });
    await patchProfile(u, { bio: "only bio" });
    const after = await getProfile(u);
    expect(after.body.data.profile.displayName).toBe("Keep"); // unchanged
    expect(after.body.data.profile.bio).toBe("only bio");
  });

  it("rejects an empty patch body", async () => {
    const u = await registerUser(app);
    const res = await patchProfile(u, {});
    expect(res.status).toBe(400);
  });

  it("rejects an over-long display name and over-long bio", async () => {
    const u = await registerUser(app);
    expect((await patchProfile(u, { displayName: "x".repeat(51) })).status).toBe(400);
    expect((await patchProfile(u, { bio: "y".repeat(501) })).status).toBe(400);
  });

  it("rejects too many interests", async () => {
    const u = await registerUser(app);
    const tooMany = Array.from({ length: 21 }, (_, i) => `i${i}`);
    expect((await patchProfile(u, { interests: tooMany })).status).toBe(400);
  });

  it("ignores/strips forbidden fields (userId, role, account status)", async () => {
    const u = await registerUser(app);
    const res = await patchProfile(u, {
      displayName: "Legit",
      userId: "00000000-0000-0000-0000-000000000000",
      role: "ADMIN",
      accountStatus: "SUSPENDED",
      createdAt: "1999-01-01",
    });
    expect(res.status).toBe(200);
    const p = res.body.data.profile;
    expect(p.userId).toBe(u.userId); // unchanged — body userId ignored
    expect(p.displayName).toBe("Legit");
    // Role is not part of the profile view and was never applied.
    expect(p.role).toBeUndefined();
  });

  it("requires authentication", async () => {
    const res = await request(app).patch("/api/profile").send({ bio: "x" });
    expect(res.status).toBe(401);
  });

  it("toggling discoverable=false removes the user from others' discovery", async () => {
    const viewer = await registerUser(app);
    const target = await registerUser(app);
    // target visible by default
    const before = await request(app).get("/api/discovery").set(...auth(viewer.accessToken));
    expect(before.body.data.candidates.map((c: { id: string }) => c.id)).toContain(target.userId);
    // target hides
    await patchProfile(target, { discoverable: false });
    const after = await request(app).get("/api/discovery").set(...auth(viewer.accessToken));
    expect(after.body.data.candidates.map((c: { id: string }) => c.id)).not.toContain(
      target.userId,
    );
  });

  it("profileComplete becomes true once bio+interests+a READY photo exist", async () => {
    const u = await registerUser(app);
    await patchProfile(u, { bio: "about me", interests: ["x"] });
    const up = await uploadImage(app, u, await makeJpeg(), "image/jpeg", "profile");
    expect(up.status).toBe(200);
    await request(app)
      .post("/api/profile/photos")
      .set(...auth(u.accessToken))
      .send({ mediaId: up.mediaId });
    const res = await getProfile(u);
    expect(res.body.data.profile.profileComplete).toBe(true);
  });
});
