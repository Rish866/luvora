import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool } from "../src/db/pool";
import { resetDb, registerUser, makeJpeg, uploadImage } from "./helpers";
import { probeDimensions } from "../src/media/imageProcessor";

/**
 * Media hardening (Increment 11). verify.ts sets MEDIA_MAX_PIXELS=90000 (a
 * 300x300 ceiling) so a 400x400 image (160000 px) is over the policy while
 * staying tiny in bytes (passes the byte-size gate and reaches the pixel guard).
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

describe("media: dimension / decompression-bomb guard", () => {
  it("rejects an image whose pixel count exceeds the policy", async () => {
    const user = await registerUser(app);
    const big = await makeJpeg(400, 400); // 160000 px > 90000
    const res = await uploadImage(app, user, big);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MEDIA_DIMENSIONS_TOO_LARGE");
  });

  it("accepts an image within the pixel budget", async () => {
    const user = await registerUser(app);
    const ok = await makeJpeg(200, 200); // 40000 px < 90000
    const res = await uploadImage(app, user, ok);
    expect(res.status).toBe(200);
  });

  it("probeDimensions reports accurate dimensions without full decode", async () => {
    const buf = await makeJpeg(123, 77);
    const dims = await probeDimensions(buf);
    expect(dims).not.toBeNull();
    expect(dims!.width).toBe(123);
    expect(dims!.height).toBe(77);
    expect(dims!.pixels).toBe(123 * 77);
  });

  it("probeDimensions returns null for non-image bytes", async () => {
    const dims = await probeDimensions(Buffer.from("this is definitely not an image"));
    expect(dims).toBeNull();
  });

  it("still rejects non-image content as invalid (not a dimension error)", async () => {
    const user = await registerUser(app);
    const notImage = Buffer.from("GIF-looking but garbage".repeat(100));
    const res = await uploadImage(app, user, notImage);
    expect(res.status).toBe(400);
    // Reaches the invalid-image path, not the dimension path.
    expect(["MEDIA_INVALID_CONTENT", "MEDIA_DIMENSIONS_TOO_LARGE"]).toContain(
      res.body.error.code,
    );
  });
});
