import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool } from "../src/db/pool";
import {
  resetDb,
  registerUser,
  auth,
  makeJpeg,
  uploadImage,
  createMatch,
  type RegisteredUser,
} from "./helpers";

/**
 * Increment 14 — profile-photo tests (P0-2). Covers associate/list/primary/
 * reorder/delete, ownership + IDOR, and the authorized/unauthorized photo-view
 * path (owner, discoverable candidate, match, blocked, non-discoverable).
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

const authH = (u: RegisteredUser) => auth(u.accessToken);

interface PhotoView {
  id: string;
  mediaId: string;
  position: number;
  isPrimary: boolean;
  url: string;
  thumbnailUrl: string | null;
  status: string;
}

/** Upload a profile-context image and associate it; returns the photo view. */
async function addPhoto(u: RegisteredUser): Promise<{ mediaId: string; photos: PhotoView[] }> {
  const up = await uploadImage(app, u, await makeJpeg(), "image/jpeg", "profile");
  if (up.status !== 200) throw new Error(`upload failed: ${up.status} ${JSON.stringify(up.body)}`);
  const res = await request(app)
    .post("/api/profile/photos")
    .set(...authH(u))
    .send({ mediaId: up.mediaId });
  if (res.status !== 201) throw new Error(`associate failed: ${res.status} ${JSON.stringify(res.body)}`);
  const photos = res.body.data.profile.photos as PhotoView[];
  return { mediaId: up.mediaId, photos };
}

describe("profile photo lifecycle", () => {
  it("associates an uploaded profile photo; first photo becomes primary", async () => {
    const u = await registerUser(app);
    const { photos } = await addPhoto(u);
    expect(photos.length).toBe(1);
    expect(photos[0].isPrimary).toBe(true);
    expect(photos[0].mediaId).toBeTruthy();
    expect(photos[0].url).toMatch(/^\/api\/media\/.+\/content$/);
  });

  it("rejects associating media that is not context=profile", async () => {
    const u = await registerUser(app);
    const chat = await uploadImage(app, u, await makeJpeg(), "image/jpeg", "chat");
    const res = await request(app)
      .post("/api/profile/photos")
      .set(...authH(u))
      .send({ mediaId: chat.mediaId });
    expect(res.status).toBe(400);
  });

  it("rejects associating another user's media (ownership)", async () => {
    const owner = await registerUser(app);
    const attacker = await registerUser(app);
    const up = await uploadImage(app, owner, await makeJpeg(), "image/jpeg", "profile");
    const res = await request(app)
      .post("/api/profile/photos")
      .set(...authH(attacker))
      .send({ mediaId: up.mediaId });
    expect([403, 404]).toContain(res.status); // not authorized / not found (opaque)
  });

  it("lists photos in deterministic order", async () => {
    const u = await registerUser(app);
    await addPhoto(u);
    await addPhoto(u);
    const res = await request(app).get("/api/profile/photos").set(...authH(u));
    expect(res.status).toBe(200);
    expect(res.body.data.photos.length).toBe(2);
    expect(res.body.data.photos[0].position).toBe(0);
    expect(res.body.data.photos[1].position).toBe(1);
  });

  it("sets a new primary and clears the old one (exactly one primary)", async () => {
    const u = await registerUser(app);
    await addPhoto(u);
    const second = await addPhoto(u);
    const secondId = second.photos.find((p: { mediaId: string }) => p.mediaId === second.mediaId)!.id;
    const res = await request(app)
      .post(`/api/profile/photos/${secondId}/primary`)
      .set(...authH(u));
    expect(res.status).toBe(200);
    const primaries = res.body.data.profile.photos.filter((p: { isPrimary: boolean }) => p.isPrimary);
    expect(primaries.length).toBe(1);
    expect(primaries[0].id).toBe(secondId);
  });

  it("reorders photos (validated permutation)", async () => {
    const u = await registerUser(app);
    await addPhoto(u);
    await addPhoto(u);
    const list = (await request(app).get("/api/profile/photos").set(...authH(u))).body.data.photos;
    const reversed = [list[1].id, list[0].id];
    const res = await request(app)
      .put("/api/profile/photos/order")
      .set(...authH(u))
      .send({ photoIds: reversed });
    expect(res.status).toBe(200);
    const after = res.body.data.profile.photos;
    expect(after[0].id).toBe(reversed[0]);
    expect(after[1].id).toBe(reversed[1]);
  });

  it("rejects a reorder that is not a permutation of the user's photos", async () => {
    const u = await registerUser(app);
    const { photos } = await addPhoto(u);
    const res = await request(app)
      .put("/api/profile/photos/order")
      .set(...authH(u))
      .send({ photoIds: [photos[0].id, "00000000-0000-0000-0000-000000000000"] });
    expect(res.status).toBe(400);
  });

  it("deletes a photo (owner) and promotes a new primary when the primary is removed", async () => {
    const u = await registerUser(app);
    const first = await addPhoto(u);
    const second = await addPhoto(u);
    const firstId = first.photos[0].id; // primary
    const del = await request(app).delete(`/api/profile/photos/${firstId}`).set(...authH(u));
    expect(del.status).toBe(200);
    const photos = del.body.data.profile.photos;
    expect(photos.length).toBe(1);
    expect(photos[0].mediaId).toBe(second.mediaId);
    expect(photos[0].isPrimary).toBe(true); // promoted
  });

  it("cannot delete another user's photo (IDOR)", async () => {
    const owner = await registerUser(app);
    const attacker = await registerUser(app);
    const { photos } = await addPhoto(owner);
    const res = await request(app)
      .delete(`/api/profile/photos/${photos[0].id}`)
      .set(...authH(attacker));
    expect([403, 404]).toContain(res.status);
    // Owner's photo still there.
    const still = await request(app).get("/api/profile/photos").set(...authH(owner));
    expect(still.body.data.photos.length).toBe(1);
  });

  it("enforces the per-user photo cap", async () => {
    const u = await registerUser(app);
    for (let i = 0; i < 6; i++) await addPhoto(u);
    const up = await uploadImage(app, u, await makeJpeg(), "image/jpeg", "profile");
    const res = await request(app)
      .post("/api/profile/photos")
      .set(...authH(u))
      .send({ mediaId: up.mediaId });
    expect(res.status).toBe(409);
  });
});

describe("profile photo viewing authorization", () => {
  it("owner can fetch their own profile photo bytes", async () => {
    const u = await registerUser(app);
    const { mediaId } = await addPhoto(u);
    const res = await request(app).get(`/api/media/${mediaId}/content`).set(...authH(u));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/");
  });

  it("a discovery-eligible viewer CAN fetch a discoverable user's profile photo", async () => {
    const viewer = await registerUser(app);
    const target = await registerUser(app); // discoverable by default
    const { mediaId } = await addPhoto(target);
    const res = await request(app).get(`/api/media/${mediaId}/content`).set(...authH(viewer));
    expect(res.status).toBe(200);
  });

  it("a NON-discoverable user's photo is NOT viewable by a stranger", async () => {
    const viewer = await registerUser(app);
    const target = await registerUser(app);
    const { mediaId } = await addPhoto(target);
    await request(app).patch("/api/profile").set(...authH(target)).send({ discoverable: false });
    const res = await request(app).get(`/api/media/${mediaId}/content`).set(...authH(viewer));
    expect(res.status).toBe(403);
  });

  it("a matched user CAN view the other's profile photo even if not discoverable", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const { mediaId } = await addPhoto(b);
    await request(app).patch("/api/profile").set(...authH(b)).send({ discoverable: false });
    await createMatch(a.userId, b.userId);
    const res = await request(app).get(`/api/media/${mediaId}/content`).set(...authH(a));
    expect(res.status).toBe(200);
  });

  it("a blocked viewer CANNOT view the photo (even if discoverable)", async () => {
    const viewer = await registerUser(app);
    const target = await registerUser(app);
    const { mediaId } = await addPhoto(target);
    // target blocks viewer
    await request(app).post(`/api/users/${viewer.userId}/block`).set(...authH(target));
    const res = await request(app).get(`/api/media/${mediaId}/content`).set(...authH(viewer));
    expect(res.status).toBe(403);
  });

  it("unauthenticated cannot fetch a profile photo", async () => {
    const u = await registerUser(app);
    const { mediaId } = await addPhoto(u);
    const res = await request(app).get(`/api/media/${mediaId}/content`);
    expect(res.status).toBe(401);
  });
});

describe("discovery/match photo representation", () => {
  it("discovery returns a consumable photo reference (mediaId+url), never a storageKey", async () => {
    const viewer = await registerUser(app);
    const target = await registerUser(app);
    await addPhoto(target);
    const res = await request(app).get("/api/discovery").set(...authH(viewer));
    const candidate = res.body.data.candidates.find(
      (c: { id: string }) => c.id === target.userId,
    );
    expect(candidate).toBeTruthy();
    expect(candidate.photo).toBeTruthy();
    expect(candidate.photo.mediaId).toBeTruthy();
    expect(candidate.photo.url).toMatch(/^\/api\/media\/.+\/content$/);
    expect(candidate.photo.storageKey).toBeUndefined();
    // The URL actually serves bytes to this viewer.
    const bytes = await request(app).get(candidate.photo.url).set(...authH(viewer));
    expect(bytes.status).toBe(200);
  });

  it("match summary returns a consumable photo reference", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await addPhoto(b);
    await createMatch(a.userId, b.userId);
    const res = await request(app).get("/api/matches").set(...authH(a));
    const m = res.body.data.matches[0];
    expect(m.user.id).toBe(b.userId);
    expect(m.user.photo.mediaId).toBeTruthy();
    expect(m.user.photo.url).toMatch(/^\/api\/media\/.+\/content$/);
    expect(m.user.photo.storageKey).toBeUndefined();
  });

  it("discovery shows no photo for a candidate with only a non-READY/unassociated upload", async () => {
    const viewer = await registerUser(app);
    const target = await registerUser(app);
    // Upload profile media but DO NOT associate it as a profile photo.
    await uploadImage(app, target, await makeJpeg(), "image/jpeg", "profile");
    const res = await request(app).get("/api/discovery").set(...authH(viewer));
    const candidate = res.body.data.candidates.find((c: { id: string }) => c.id === target.userId);
    expect(candidate.photo).toBeNull();
  });
});
