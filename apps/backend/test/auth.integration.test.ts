import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool } from "../src/db/pool";
import { resetDb, registerUser, auth } from "./helpers";

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

describe("auth: registration & age gate", () => {
  it("registers an adult and returns tokens", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: "adult@example.com",
      password: "Passw0rd!test",
      displayName: "Adult",
      dateOfBirth: "1990-05-05",
      ageConfirmed: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
  });

  it("rejects an under-18 user even when they tick the confirmation box", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: "minor@example.com",
      password: "Passw0rd!test",
      displayName: "TooYoung",
      dateOfBirth: "2015-01-01",
      ageConfirmed: true,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AGE_RESTRICTED");
  });

  it("rejects registration without the 18+ confirmation", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: "nocheck@example.com",
      password: "Passw0rd!test",
      displayName: "NoCheck",
      dateOfBirth: "1990-01-01",
      ageConfirmed: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("prevents duplicate email registration", async () => {
    await registerUser(app, { email: "dup@example.com" });
    const res = await request(app).post("/api/auth/register").send({
      email: "dup@example.com",
      password: "Passw0rd!test",
      displayName: "Dup2",
      dateOfBirth: "1990-01-01",
      ageConfirmed: true,
    });
    expect(res.status).toBe(409);
  });
});

describe("auth: login / refresh / logout", () => {
  it("logs in with correct credentials and rejects wrong ones", async () => {
    const u = await registerUser(app, { email: "login@example.com" });

    const good = await request(app)
      .post("/api/auth/login")
      .send({ email: u.email, password: "Passw0rd!test" });
    expect(good.status).toBe(200);
    expect(good.body.data.accessToken).toBeTruthy();

    const bad = await request(app)
      .post("/api/auth/login")
      .send({ email: u.email, password: "wrong-password" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("returns the current user from /me with a valid token", async () => {
    const u = await registerUser(app);
    const res = await request(app).get("/api/auth/me").set(...auth(u.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(u.userId);
    expect(res.body.data).not.toHaveProperty("password_hash");
  });

  it("rejects /me without a token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("rotates refresh tokens and detects reuse of a rotated token", async () => {
    const u = await registerUser(app);

    const first = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: u.refreshToken });
    expect(first.status).toBe(200);
    const newRefresh = first.body.data.refreshToken;
    expect(newRefresh).not.toBe(u.refreshToken);

    // Reusing the OLD (now rotated) token must fail.
    const reuse = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: u.refreshToken });
    expect(reuse.status).toBe(401);

    // And the family should now be revoked: the new token also stops working.
    const afterTheft = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: newRefresh });
    expect(afterTheft.status).toBe(401);
  });

  it("logout revokes the refresh token", async () => {
    const u = await registerUser(app);
    const out = await request(app)
      .post("/api/auth/logout")
      .send({ refreshToken: u.refreshToken });
    expect(out.status).toBe(200);

    const after = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: u.refreshToken });
    expect(after.status).toBe(401);
  });
});
