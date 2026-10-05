import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import {
  resetDb,
  registerUser,
  auth,
  makeJpeg,
  makePng,
  makeWebp,
  uploadImage,
  type RegisteredUser,
} from "./helpers";
import {
  setMediaProviders,
  resetMediaProviders,
} from "../src/media/mediaProviders";
import type { MediaScanner, ScanResult } from "../src/media/scanning/MediaScanner";
import { hasExif } from "../src/media/imageProcessor";
import { getMediaProviders } from "../src/media/mediaProviders";

let app: Express;

beforeAll(() => {
  app = createApp();
});
beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  resetMediaProviders();
});
afterAll(async () => {
  await closePool();
});

describe("media upload: happy paths", () => {
  it("uploads a valid JPEG and reaches READY+APPROVED", async () => {
    const u = await registerUser(app);
    const { status, body } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    expect(status).toBe(200);
    expect(body.data.status).toBe("READY");
    expect(body.data.moderationStatus).toBe("APPROVED");
    expect(body.data.mimeType).toBe("image/jpeg");
    expect(body.data.width).toBeGreaterThan(0);
  });

  it("uploads a valid PNG", async () => {
    const u = await registerUser(app);
    const { status, body } = await uploadImage(app, u, await makePng(), "image/png");
    expect(status).toBe(200);
    expect(body.data.mimeType).toBe("image/png");
  });

  it("uploads a valid WebP", async () => {
    const u = await registerUser(app);
    const { status, body } = await uploadImage(app, u, await makeWebp(), "image/webp");
    expect(status).toBe(200);
    expect(body.data.mimeType).toBe("image/webp");
  });

  it("computes SHA-256 and dimensions server-side", async () => {
    const u = await registerUser(app);
    const { mediaId } = await uploadImage(app, u, await makeJpeg(40, 30), "image/jpeg");
    const { rows } = await pool.query(
      `SELECT sha256, width, height, byte_size FROM media_assets WHERE id = $1`,
      [mediaId],
    );
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].width).toBe(40);
    expect(rows[0].height).toBe(30);
    expect(Number(rows[0].byte_size)).toBeGreaterThan(0);
  });
});

describe("media upload: rejections", () => {
  it("rejects a disallowed declared MIME at intent", async () => {
    const u = await registerUser(app);
    const res = await request(app)
      .post("/api/media")
      .set(...auth(u.accessToken))
      .send({ mimeType: "image/svg+xml", sizeBytes: 100, context: "chat" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MEDIA_TYPE_NOT_ALLOWED");
  });

  it("rejects oversized declared size at intent", async () => {
    const u = await registerUser(app);
    const res = await request(app)
      .post("/api/media")
      .set(...auth(u.accessToken))
      .send({ mimeType: "image/jpeg", sizeBytes: 999_999_999, context: "chat" });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("MEDIA_TOO_LARGE");
  });

  it("rejects non-image bytes (text pretending to be an image)", async () => {
    const u = await registerUser(app);
    const { status, body } = await uploadImage(
      app,
      u,
      Buffer.from("this is definitely not an image"),
      "image/jpeg",
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("MEDIA_INVALID_CONTENT");
  });

  it("rejects MIME spoofing (PNG bytes declared as image/jpeg)", async () => {
    const u = await registerUser(app);
    const png = await makePng();
    const { status, body } = await uploadImage(app, u, png, "image/jpeg");
    expect(status).toBe(400);
    expect(body.error.code).toBe("MEDIA_MIME_MISMATCH");
  });

  it("rejects empty content", async () => {
    const u = await registerUser(app);
    const intent = await request(app)
      .post("/api/media")
      .set(...auth(u.accessToken))
      .send({ mimeType: "image/jpeg", sizeBytes: 1, context: "chat" });
    const put = await request(app)
      .put(`/api/media/${intent.body.data.mediaId}/content`)
      .set(...auth(u.accessToken))
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(0));
    expect(put.status).toBe(400);
    expect(put.body.error.code).toBe("MEDIA_INVALID_CONTENT");
  });

  it("rejects a second upload to an already-processed asset", async () => {
    const u = await registerUser(app);
    const { mediaId } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    const put = await request(app)
      .put(`/api/media/${mediaId}/content`)
      .set(...auth(u.accessToken))
      .set("Content-Type", "application/octet-stream")
      .send(await makeJpeg());
    expect(put.status).toBe(409);
    expect(put.body.error.code).toBe("MEDIA_INVALID_STATE");
  });

  it("unauthenticated upload intent is rejected", async () => {
    const res = await request(app).post("/api/media").send({ mimeType: "image/jpeg", sizeBytes: 10 });
    expect(res.status).toBe(401);
  });

  it("another user cannot upload content to someone else's intent", async () => {
    const u = await registerUser(app);
    const other = await registerUser(app);
    const intent = await request(app)
      .post("/api/media")
      .set(...auth(u.accessToken))
      .send({ mimeType: "image/jpeg", sizeBytes: 100, context: "chat" });
    const put = await request(app)
      .put(`/api/media/${intent.body.data.mediaId}/content`)
      .set(...auth(other.accessToken))
      .set("Content-Type", "application/octet-stream")
      .send(await makeJpeg());
    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe("MEDIA_NOT_AUTHORIZED");
  });
});

describe("media privacy", () => {
  it("strips EXIF/GPS: input has EXIF, served normalized output does not", async () => {
    const u = await registerUser(app);
    const withExif = await makeJpeg(40, 30, { withExif: true });
    expect(await hasExif(withExif)).toBe(true); // sanity: fixture has EXIF
    const { mediaId } = await uploadImage(app, u, withExif, "image/jpeg");
    const bytes = await request(app)
      .get(`/api/media/${mediaId}/content`)
      .set(...auth(u.accessToken))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(bytes.status).toBe(200);
    expect(await hasExif(bytes.body as Buffer)).toBe(false);
  });

  it("generates a thumbnail with its own storage key", async () => {
    const u = await registerUser(app);
    const { mediaId, body } = await uploadImage(app, u, await makeJpeg(400, 300), "image/jpeg");
    expect(body.data.thumbnailUrl).toBeTruthy();
    const { rows } = await pool.query(
      `SELECT storage_key, thumbnail_storage_key FROM media_assets WHERE id = $1`,
      [mediaId],
    );
    expect(rows[0].thumbnail_storage_key).toBeTruthy();
    expect(rows[0].thumbnail_storage_key).not.toBe(rows[0].storage_key);
    const thumb = await request(app)
      .get(`/api/media/${mediaId}/thumbnail`)
      .set(...auth(u.accessToken));
    expect(thumb.status).toBe(200);
  });

  it("DTOs never expose storage keys / sha256 / filename / detected-vs-declared internals", async () => {
    const u = await registerUser(app);
    const { mediaId } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    const view = await request(app).get(`/api/media/${mediaId}`).set(...auth(u.accessToken));
    const serialized = JSON.stringify(view.body);
    expect(serialized).not.toContain("storage_key");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("sha256");
    expect(serialized).not.toContain("original_filename");
    // url points at the authenticated app endpoint, not a filesystem path.
    expect(view.body.data.url).toBe(`/api/media/${mediaId}/content`);
  });
});

describe("media malware scanning", () => {
  class FakeScanner implements MediaScanner {
    constructor(private result: ScanResult) {}
    async scan(): Promise<ScanResult> {
      return this.result;
    }
  }

  it("INFECTED -> quarantined, not downloadable", async () => {
    setMediaProviders({ scanner: new FakeScanner({ status: "INFECTED", reason: "test" }) });
    const u = await registerUser(app);
    const { status, body, mediaId } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    expect(status).toBe(409);
    expect(body.error.code).toBe("MEDIA_REJECTED");
    const { rows } = await pool.query(`SELECT status FROM media_assets WHERE id = $1`, [mediaId]);
    expect(rows[0].status).toBe("QUARANTINED");
    // Not downloadable.
    const dl = await request(app).get(`/api/media/${mediaId}/content`).set(...auth(u.accessToken));
    expect(dl.status).toBe(409);
  });

  it("UNKNOWN with quarantine policy -> quarantined", async () => {
    setMediaProviders({ scanner: new FakeScanner({ status: "UNKNOWN" }) });
    const u = await registerUser(app);
    const { status, mediaId } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    expect(status).toBe(409);
    const { rows } = await pool.query(`SELECT status FROM media_assets WHERE id = $1`, [mediaId]);
    expect(rows[0].status).toBe("QUARANTINED");
  });

  it("CLEAN -> continues to READY", async () => {
    setMediaProviders({ scanner: new FakeScanner({ status: "CLEAN" }) });
    const u = await registerUser(app);
    const { status, body } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    expect(status).toBe(200);
    expect(body.data.status).toBe("READY");
  });

  it("the default dev scanner is a stub (documented): not real protection", () => {
    // Guard against anyone claiming the test scanner is production-grade.
    const { scanner } = getMediaProviders();
    expect(scanner.constructor.name).toBe("TestMediaScanner");
  });
});

describe("media moderation", () => {
  // Inject a fake moderation provider so the outcome is deterministic and
  // independent of image bytes (normalization strips any trailing markers).
  class FakeModeration {
    constructor(private status: "APPROVED" | "REJECTED" | "NEEDS_REVIEW") {}
    async moderate() {
      return { status: this.status };
    }
  }

  it("REJECTED moderation -> status REJECTED, cannot download", async () => {
    setMediaProviders({ moderation: new FakeModeration("REJECTED") });
    const u = await registerUser(app);
    const { status, mediaId } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    expect(status).toBe(409);
    const { rows } = await pool.query(`SELECT status, moderation_status FROM media_assets WHERE id = $1`, [mediaId]);
    expect(rows[0].status).toBe("REJECTED");
    expect(rows[0].moderation_status).toBe("REJECTED");
    const dl = await request(app).get(`/api/media/${mediaId}/content`).set(...auth(u.accessToken));
    expect(dl.status).toBe(409);
  });

  it("NEEDS_REVIEW moderation -> quarantined", async () => {
    setMediaProviders({ moderation: new FakeModeration("NEEDS_REVIEW") });
    const u = await registerUser(app);
    const { status, mediaId } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    expect(status).toBe(409);
    const { rows } = await pool.query(`SELECT status, moderation_status FROM media_assets WHERE id = $1`, [mediaId]);
    expect(rows[0].status).toBe("QUARANTINED");
    expect(rows[0].moderation_status).toBe("NEEDS_REVIEW");
  });

  it("the default dev moderation provider is a stub (documented): not real AI moderation", () => {
    const { moderation } = getMediaProviders();
    expect(moderation.constructor.name).toBe("TestMediaModerationProvider");
  });

  it("client cannot force moderation state via the body", async () => {
    const u = await registerUser(app);
    const intent = await request(app)
      .post("/api/media")
      .set(...auth(u.accessToken))
      .send({
        mimeType: "image/jpeg",
        sizeBytes: 100,
        context: "chat",
        status: "READY",
        moderationStatus: "APPROVED",
      });
    // Intent always starts UPLOADING regardless of injected fields.
    expect(intent.body.data.status).toBe("UPLOADING");
  });
});

describe("media IDOR", () => {
  it("unrelated user cannot GET metadata, bytes, or DELETE another user's media", async () => {
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const { mediaId } = await uploadImage(app, owner, await makeJpeg(), "image/jpeg");

    expect((await request(app).get(`/api/media/${mediaId}`).set(...auth(other.accessToken))).status).toBe(403);
    expect(
      (await request(app).get(`/api/media/${mediaId}/content`).set(...auth(other.accessToken))).status,
    ).toBe(403);
    expect((await request(app).delete(`/api/media/${mediaId}`).set(...auth(other.accessToken))).status).toBe(403);
    // Owner's media still intact.
    const { rows } = await pool.query(`SELECT status FROM media_assets WHERE id = $1`, [mediaId]);
    expect(rows[0].status).toBe("READY");
  });

  it("unknown media id returns MEDIA_NOT_FOUND", async () => {
    const u = await registerUser(app);
    const res = await request(app)
      .get("/api/media/00000000-0000-0000-0000-000000000000")
      .set(...auth(u.accessToken));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("MEDIA_NOT_FOUND");
  });

  it("malformed media id is rejected", async () => {
    const u = await registerUser(app);
    const res = await request(app).get("/api/media/not-a-uuid").set(...auth(u.accessToken));
    expect(res.status).toBe(400);
  });
});

describe("media delete", () => {
  it("owner can delete; afterwards downloads fail and asset is DELETED", async () => {
    const u = await registerUser(app);
    const { mediaId } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    const del = await request(app).delete(`/api/media/${mediaId}`).set(...auth(u.accessToken));
    expect(del.status).toBe(200);
    const { rows } = await pool.query(`SELECT status, deleted_at FROM media_assets WHERE id = $1`, [mediaId]);
    expect(rows[0].status).toBe("DELETED");
    expect(rows[0].deleted_at).toBeTruthy();
    const dl = await request(app).get(`/api/media/${mediaId}/content`).set(...auth(u.accessToken));
    expect(dl.status).toBe(404);
  });
});

describe("media report", () => {
  it("owner reporting is accepted; sensitive report quarantines the asset", async () => {
    const u = await registerUser(app);
    const { mediaId } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    const rep = await request(app)
      .post(`/api/media/${mediaId}/report`)
      .set(...auth(u.accessToken))
      .send({ reason: "NONCONSENSUAL" });
    expect(rep.status).toBe(200);
    expect(rep.body.data.reported).toBe(true);
    const { rows } = await pool.query(`SELECT status, moderation_status FROM media_assets WHERE id = $1`, [mediaId]);
    expect(rows[0].moderation_status).toBe("NEEDS_REVIEW");
    expect(rows[0].status).toBe("QUARANTINED");
  });

  it("duplicate report by the same user does not create a second row", async () => {
    const u = await registerUser(app);
    const { mediaId } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    await request(app).post(`/api/media/${mediaId}/report`).set(...auth(u.accessToken)).send({ reason: "SPAM" });
    await request(app).post(`/api/media/${mediaId}/report`).set(...auth(u.accessToken)).send({ reason: "SPAM" });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM media_reports WHERE media_id = $1`, [mediaId]);
    expect(rows[0].n).toBe(1);
  });

  it("report response never exposes reporter identity or internals", async () => {
    const u = await registerUser(app);
    const { mediaId } = await uploadImage(app, u, await makeJpeg(), "image/jpeg");
    const rep = await request(app)
      .post(`/api/media/${mediaId}/report`)
      .set(...auth(u.accessToken))
      .send({ reason: "OTHER" });
    expect(JSON.stringify(rep.body)).not.toContain(u.userId);
  });
});

describe("media orphan cleanup", () => {
  it("removes abandoned UPLOADING assets older than the grace period", async () => {
    const u = await registerUser(app);
    // Create an intent but never upload content -> stays UPLOADING.
    const intent = await request(app)
      .post("/api/media")
      .set(...auth(u.accessToken))
      .send({ mimeType: "image/jpeg", sizeBytes: 100, context: "chat" });
    const mediaId = intent.body.data.mediaId;
    // Backdate it so it is "old".
    await pool.query(
      `UPDATE media_assets SET created_at = now() - interval '2 days' WHERE id = $1`,
      [mediaId],
    );
    const { cleanupAbandonedUploads } = await import("../src/media/mediaCleanup");
    const res = await cleanupAbandonedUploads(60 * 60 * 1000); // older than 1h
    expect(res.removed).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(`SELECT 1 FROM media_assets WHERE id = $1`, [mediaId]);
    expect(rows).toHaveLength(0);
  });

  it("does not remove recent UPLOADING assets", async () => {
    const u = await registerUser(app);
    const intent = await request(app)
      .post("/api/media")
      .set(...auth(u.accessToken))
      .send({ mimeType: "image/jpeg", sizeBytes: 100, context: "chat" });
    const { cleanupAbandonedUploads } = await import("../src/media/mediaCleanup");
    await cleanupAbandonedUploads(60 * 60 * 1000);
    const { rows } = await pool.query(`SELECT 1 FROM media_assets WHERE id = $1`, [
      intent.body.data.mediaId,
    ]);
    expect(rows).toHaveLength(1);
  });
});
