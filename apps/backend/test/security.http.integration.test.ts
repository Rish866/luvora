import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool } from "../src/db/pool";

/**
 * HTTP hardening integration tests (Increment 11): security headers, strict
 * CORS allowlist, and request input limits (JSON body size + URL length).
 *
 * These rely on the deterministic env set by scripts/verify.ts:
 *   CORS_ALLOWED_ORIGINS=https://app.luvora.test,https://admin.luvora.test
 *   MAX_URL_LENGTH=2048 (JSON body stays at the 1MB default).
 */

let app: Express;

beforeAll(() => {
  app = createApp();
});
afterAll(async () => {
  await closePool();
});

describe("security headers", () => {
  it("sets strict, API-appropriate headers on responses", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["permissions-policy"]).toBeTruthy();
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("does not advertise the server stack (no X-Powered-By)", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("does not emit HSTS when disabled (default)", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("applies headers even on error (404) responses", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("CORS allowlist", () => {
  it("reflects an allowed origin with credentials", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://app.luvora.test");
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.luvora.test");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("normalizes case / trailing slash when matching an allowed origin", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://APP.luvora.test/");
    // The echoed ACAO reflects the request's Origin header verbatim when allowed.
    expect(res.headers["access-control-allow-origin"]).toBeTruthy();
  });

  it("does NOT emit CORS headers for a disallowed origin", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("handles an OPTIONS preflight for an allowed origin", async () => {
    const res = await request(app)
      .options("/api/auth/login")
      .set("Origin", "https://app.luvora.test")
      .set("Access-Control-Request-Method", "POST");
    expect([200, 204]).toContain(res.status);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.luvora.test");
  });

  it("never uses a wildcard origin (credentials are enabled)", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", "https://app.luvora.test");
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });
});

describe("request input limits", () => {
  it("rejects an oversized JSON body with 413 PAYLOAD_TOO_LARGE", async () => {
    const big = "x".repeat(1024 * 1024 + 1024); // > 1MB default JSON body limit
    const res = await request(app)
      .post("/api/auth/register")
      .set("Content-Type", "application/json")
      .send({ blob: big });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects an over-long URL with 413 PAYLOAD_TOO_LARGE", async () => {
    const longPath = "/health?q=" + "a".repeat(3000); // > MAX_URL_LENGTH (2048)
    const res = await request(app).get(longPath);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("accepts a normal-sized JSON body", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send({ email: "nobody@example.com", password: "whatever" });
    // Wrong creds => 401, but crucially NOT a 413 — the body was accepted.
    expect(res.status).not.toBe(413);
  });
});
