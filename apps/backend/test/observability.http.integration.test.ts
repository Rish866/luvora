import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool } from "../src/db/pool";
import { resetDb, registerUser, setUserRole, auth, type RegisteredUser } from "./helpers";
import { config } from "../src/config";
import { metrics } from "../src/observability/metrics";

/**
 * HTTP observability integration (Increment 10): correlation ids, health/
 * readiness, and the /metrics endpoint (auth + disabled behavior + no secrets +
 * bounded cardinality). Uses the real app + real PostgreSQL.
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
async function admin(): Promise<RegisteredUser> {
  const u = await registerUser(app);
  await setUserRole(u.userId, "ADMIN");
  return u;
}

describe("correlation id", () => {
  it("generates a correlation id and returns it in X-Correlation-Id", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    const id = res.headers["x-correlation-id"];
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThan(10);
  });

  it("preserves a safe inbound correlation id", async () => {
    const res = await request(app).get("/health").set("X-Correlation-Id", "req-abc-123");
    expect(res.headers["x-correlation-id"]).toBe("req-abc-123");
  });

  it("replaces an oversized/malformed inbound correlation id with a fresh one", async () => {
    const bad = "x".repeat(500);
    const res = await request(app).get("/health").set("X-Correlation-Id", bad);
    expect(res.headers["x-correlation-id"]).not.toBe(bad);
    expect(res.headers["x-correlation-id"].length).toBeLessThan(200);
  });

  it("still returns a correlation id on error responses", async () => {
    const res = await request(app).get("/api/notifications"); // 401 (unauthenticated)
    expect(res.status).toBe(401);
    expect(res.headers["x-correlation-id"]).toBeTruthy();
  });
});

describe("health & readiness", () => {
  it("/health is ok and reports uptime (does not depend on the worker)", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ok");
    expect(typeof res.body.data.uptimeSeconds).toBe("number");
  });

  it("/ready returns a structured report with db/migrations/worker checks", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ready");
    expect(res.body.data.checks.database).toBe("ok");
    expect(res.body.data.checks.migrations).toBe("ok");
    // No embedded worker in the test app -> disabled (API still ready).
    expect(res.body.data.checks.worker).toBe("disabled");
  });

  it("/ready never leaks connection strings or SQL", async () => {
    const res = await request(app).get("/ready");
    const s = JSON.stringify(res.body);
    expect(s).not.toContain("postgres://");
    expect(s).not.toMatch(/SELECT|INSERT|password=/i);
  });
});

describe("/metrics endpoint", () => {
  it("requires auth by default (401 unauthenticated)", async () => {
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin user", async () => {
    const u = await registerUser(app);
    const res = await request(app).get("/metrics").set(...H(u));
    expect(res.status).toBe(401);
  });

  it("serves Prometheus text to an admin, with expected counters and no secrets", async () => {
    const a = await admin();
    // Drive a request so http_requests_total has data.
    await request(app).get("/health");
    const res = await request(app).get("/metrics").set(...H(a));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("# TYPE http_requests_total counter");
    expect(res.text).toContain("jobs_enqueued_total");
    expect(res.text).toContain("notification_push_sent_total");
    // No secrets / tokens / SQL leaked into metrics output.
    expect(res.text).not.toMatch(/password|authorization|postgres:\/\/|SELECT /i);
    expect(res.text).not.toContain(a.accessToken);
  });

  it("http metric route labels stay bounded (UUIDs collapse to :id)", async () => {
    const a = await admin();
    // Hit the same route template with different UUIDs.
    for (let i = 0; i < 5; i++) {
      await request(app)
        .get(`/api/admin/jobs/00000000-0000-0000-0000-00000000000${i}`)
        .set(...H(a));
    }
    const res = await request(app).get("/metrics").set(...H(a));
    // The matched Express template is "/api/admin/jobs/:id" — not 5 distinct
    // UUID label series.
    const lines = res.text.split("\n").filter((l) => l.startsWith("http_requests_total{"));
    const jobDetailLines = lines.filter((l) => l.includes("/jobs/:id"));
    expect(jobDetailLines.length).toBeGreaterThanOrEqual(1);
    // No raw UUID should appear as a route label.
    expect(res.text).not.toMatch(/route="[^"]*00000000-0000-0000-0000-00000000000\d/);
  });

  it("returns 404 when metrics are disabled", async () => {
    const a = await admin();
    const original = config.observability.metricsEnabled;
    try {
      (config.observability as { metricsEnabled: boolean }).metricsEnabled = false;
      const res = await request(app).get("/metrics").set(...H(a));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("METRICS_DISABLED");
    } finally {
      (config.observability as { metricsEnabled: boolean }).metricsEnabled = original;
    }
  });

  it("allows unauthenticated access when auth is not required", async () => {
    const original = config.observability.metricsRequireAuth;
    try {
      (config.observability as { metricsRequireAuth: boolean }).metricsRequireAuth = false;
      const res = await request(app).get("/metrics");
      expect(res.status).toBe(200);
      expect(res.text).toContain("# TYPE");
    } finally {
      (config.observability as { metricsRequireAuth: boolean }).metricsRequireAuth = original;
    }
  });
});

describe("http metrics counters", () => {
  it("increments http_requests_total and http_errors_total", async () => {
    const before = metrics.counterTotal("http_requests_total");
    const beforeErr = metrics.counterTotal("http_errors_total");
    await request(app).get("/health"); // 2xx
    await request(app).get("/api/notifications"); // 401 -> error
    expect(metrics.counterTotal("http_requests_total")).toBeGreaterThan(before);
    expect(metrics.counterTotal("http_errors_total")).toBeGreaterThan(beforeErr);
  });
});
