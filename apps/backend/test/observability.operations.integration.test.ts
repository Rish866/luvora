import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { closePool, pool, dbHealth } from "../src/db/pool";
import { resetDb } from "./helpers";
import {
  recordOperationalEvent,
  listOperationalEvents,
  cleanupOperationalEvents,
  sanitizeMetadata,
} from "../src/observability/operationalEvents";
import { OperationalEventType, OperationalSeverity } from "@luvora/shared";

/**
 * Operational events + DB health (Increment 10) against real PostgreSQL:
 * persistence, metadata sanitization, listing/filtering, retention cleanup, and
 * the safe DB-health snapshot (no credentials).
 */

beforeAll(() => {
  /* pool ready on import */
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closePool();
});

describe("operational events: persistence + sanitization", () => {
  it("records an event with sanitized metadata (sensitive keys dropped)", async () => {
    await recordOperationalEvent({
      eventType: OperationalEventType.JOB_MANUALLY_REQUEUED,
      severity: OperationalSeverity.WARNING,
      jobId: "00000000-0000-0000-0000-0000000000aa",
      entityType: "JOB",
      metadata: { jobType: "NOTIFICATION_PUSH_DELIVERY", token: "SECRET", password: "p", reason: "ops" },
    });
    const { events } = await listOperationalEvents({ limit: 10 });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.eventType).toBe("JOB_MANUALLY_REQUEUED");
    expect(e.severity).toBe("WARNING");
    expect(e.metadata.jobType).toBe("NOTIFICATION_PUSH_DELIVERY");
    expect(e.metadata.reason).toBe("ops");
    expect(e.metadata.token).toBeUndefined();
    expect(e.metadata.password).toBeUndefined();
    const s = JSON.stringify(e);
    expect(s).not.toContain("SECRET");
  });

  it("sanitizeMetadata drops sensitive keys and bounds values", () => {
    const out = sanitizeMetadata({
      ok: "fine",
      token: "x",
      payload: { a: 1 },
      big: "y".repeat(1000),
      n: 5,
      flag: true,
    });
    expect(out.ok).toBe("fine");
    expect(out.n).toBe(5);
    expect(out.flag).toBe(true);
    expect(out.token).toBeUndefined();
    expect(out.payload).toBeUndefined();
    expect(String(out.big).length).toBeLessThanOrEqual(300);
  });

  it("persistence is best-effort: never throws on a bad insert", async () => {
    // An invalid severity would violate the CHECK; recordOperationalEvent must
    // swallow the error rather than propagate it.
    await expect(
      recordOperationalEvent({
        eventType: OperationalEventType.WORKER_STARTED,
        severity: "NOT_A_SEVERITY" as OperationalSeverity,
      }),
    ).resolves.toBeUndefined();
    const { events } = await listOperationalEvents({ limit: 10 });
    expect(events).toHaveLength(0); // the bad insert did not persist
  });

  it("filters by event type and severity", async () => {
    await recordOperationalEvent({ eventType: OperationalEventType.WORKER_STARTED });
    await recordOperationalEvent({
      eventType: OperationalEventType.WORKER_UNHEALTHY,
      severity: OperationalSeverity.ERROR,
    });
    const started = await listOperationalEvents({ eventType: "WORKER_STARTED", limit: 10 });
    expect(started.events).toHaveLength(1);
    const errors = await listOperationalEvents({ severity: "ERROR", limit: 10 });
    expect(errors.events).toHaveLength(1);
    expect(errors.events[0].eventType).toBe("WORKER_UNHEALTHY");
  });

  it("paginates with a keyset cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await recordOperationalEvent({ eventType: OperationalEventType.WORKER_STARTED, metadata: { i } });
    }
    const page1 = await listOperationalEvents({ limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listOperationalEvents({ limit: 2, before: page1.nextCursor });
    expect(page2.events).toHaveLength(2);
    const ids1 = page1.events.map((e) => e.id);
    const ids2 = page2.events.map((e) => e.id);
    expect(ids1.filter((x) => ids2.includes(x))).toHaveLength(0);
  });

  it("retention cleanup deletes events older than the window, keeps recent", async () => {
    await recordOperationalEvent({ eventType: OperationalEventType.WORKER_STARTED, metadata: { k: "recent" } });
    // Age one event beyond retention.
    await pool.query(
      `INSERT INTO operational_events (event_type, severity, created_at)
       VALUES ('WORKER_STOPPED','INFO', now() - interval '200 days')`,
    );
    const removed = await cleanupOperationalEvents(90);
    expect(removed).toBe(1);
    const { events } = await listOperationalEvents({ limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].metadata.k).toBe("recent");
  });

  it("retention cleanup never touches audit_logs", async () => {
    await pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, created_at)
       VALUES (NULL, 'test.action', now() - interval '500 days')`,
    );
    await cleanupOperationalEvents(1);
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_logs`);
    expect(audit.rows[0].n).toBe(1); // audit retained regardless of age
  });
});

describe("DB health snapshot", () => {
  it("reports reachable + pool stats without leaking credentials", async () => {
    const h = await dbHealth(2000);
    expect(h.reachable).toBe(true);
    expect(typeof h.poolTotal).toBe("number");
    expect(typeof h.poolIdle).toBe("number");
    expect(typeof h.poolWaiting).toBe("number");
    expect(h.utilization).toBeGreaterThanOrEqual(0);
    expect(h.utilization).toBeLessThanOrEqual(1);
    // Shape carries no connection string / credentials.
    expect(JSON.stringify(h)).not.toContain("postgres://");
  });
});
