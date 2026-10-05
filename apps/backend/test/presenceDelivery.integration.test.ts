import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import { closePool, pool } from "../src/db/pool";
import {
  resetDb,
  registerUser,
  createMatch,
  auth,
  type RegisteredUser,
} from "./helpers";
import {
  startLiveServer,
  openSocket,
  nextMessage,
  closeSocket,
  type LiveServer,
} from "./wsHelpers";
import { presenceRegistry } from "../src/presence/presenceRegistry";
import { reapNow } from "../src/presence/presenceService";
import { TestPushProvider } from "../src/notifications/push/TestPushProvider";
import { setPushProvider, resetPushProvider } from "../src/notifications/push/pushProviders";
import { Worker } from "../src/jobs/worker";
import { buildDefaultRegistry } from "../src/jobs/defaultRegistry";

/** Drain available jobs through a worker (push delivery is now job-driven). */
async function drainJobs(worker: Worker, max = 30): Promise<void> {
  for (let i = 0; i < max; i++) {
    await pool.query(`UPDATE background_jobs SET available_at = now() WHERE status='RETRY_WAIT'`);
    if (!(await worker.runOnce())) return;
  }
}

/**
 * Increment 8 end-to-end: presence TTL reaping (persists last-seen + fans out
 * presence.changed via the real bus) and notification.created delivery to a
 * connected socket through the real realtime bus, with push dispatch to a
 * registered device via the TestPushProvider.
 */

let srv: LiveServer;
let push: TestPushProvider;

beforeAll(async () => {
  srv = await startLiveServer();
});
beforeEach(async () => {
  await resetDb();
  presenceRegistry.reset();
  push = new TestPushProvider();
  setPushProvider(push);
});
afterEach(async () => {
  presenceRegistry.reset();
  resetPushProvider();
  await new Promise((r) => setTimeout(r, 150));
});
afterAll(async () => {
  await srv.close();
  await closePool();
});

const H = (u: RegisteredUser) => auth(u.accessToken);
const getPresence = (viewer: RegisteredUser, targetId: string) =>
  request(srv.app).get(`/api/users/${targetId}/presence`).set(...H(viewer));

async function matchedPair(): Promise<[RegisteredUser, RegisteredUser]> {
  const a = await registerUser(srv.app);
  const b = await registerUser(srv.app);
  await createMatch(a.userId, b.userId);
  return [a, b];
}

async function waitForLastSeen(userId: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM users WHERE id=$1`,
      [userId],
    );
    if (rows[0]?.last_seen_at != null) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("presence TTL reaping (Increment 8)", () => {
  it("a stale connection (no heartbeat) is reaped → OFFLINE + last-seen persisted + observer notified", async () => {
    const [a, b] = await matchedPair();

    // b observes; a connects.
    const bSock = await openSocket(srv.port, b.accessToken, { path: "/ws/chat" });
    await nextMessage(bSock, (m) => m.type === "connection.ready");
    const aSock = await openSocket(srv.port, a.accessToken, { path: "/ws/chat" });
    await nextMessage(aSock, (m) => m.type === "connection.ready");
    await nextMessage(bSock, (m) => m.type === "presence.changed" && m.userId === a.userId && m.status === "ONLINE");
    expect(presenceRegistry.isOnline(a.userId)).toBe(true);

    // Force a TTL reap with a far-future clock: a's connection has no recent
    // heartbeat relative to that clock, so it is reclaimed even though the
    // socket is technically still open (simulating a crashed/zombie process).
    const reaped = reapNow(Date.now() + 10_000_000);
    expect(reaped).toContain(a.userId);
    expect(presenceRegistry.isOnline(a.userId)).toBe(false);

    // last-seen persisted + observer got the OFFLINE event.
    expect(await waitForLastSeen(a.userId)).toBe(true);
    const offline = await nextMessage(
      bSock,
      (m) => m.type === "presence.changed" && m.userId === a.userId && m.status === "OFFLINE",
    );
    expect(offline.lastSeenAt).toBeTruthy();

    // Presence API now reports OFFLINE for the authorized observer.
    expect((await getPresence(b, a.userId)).body.data.status).toBe("OFFLINE");

    await closeSocket(aSock);
    await closeSocket(bSock);
  });
});

describe("notification.created delivery through the real bus (Increment 8)", () => {
  it("a connected recipient receives notification.created and a registered device gets a push", async () => {
    const [a, b] = await matchedPair();
    // b registers a push device and connects a socket.
    await request(srv.app)
      .post("/api/notifications/devices")
      .set(...H(b))
      .send({ platform: "ANDROID", provider: "FCM", token: "live-tok-ok-1" });
    const bSock = await openSocket(srv.port, b.accessToken, { path: "/ws/chat" });
    await nextMessage(bSock, (m) => m.type === "connection.ready");

    // a sends b a message → MESSAGE_RECEIVED notification.
    const matchRow = await pool.query<{ id: string }>(
      `SELECT id FROM matches WHERE (user_a=$1 OR user_b=$1) LIMIT 1`,
      [a.userId],
    );
    await request(srv.app)
      .post(`/api/matches/${matchRow.rows[0].id}/messages`)
      .set(...H(a))
      .send({ body: "hidden message content" });

    // Realtime event to b's socket (through the bus) — no body leak.
    const evt = await nextMessage(bSock, (m) => m.type === "notification.created");
    expect((evt.notification as Record<string, unknown>).type).toBe("MESSAGE_RECEIVED");
    expect(JSON.stringify(evt)).not.toContain("hidden message content");

    // Push is now driven by a durable job — run a worker to process it.
    const worker = new Worker({ registry: buildDefaultRegistry(), workerId: "pd-test-worker" });
    await drainJobs(worker);
    expect(push.sent.length).toBeGreaterThanOrEqual(1);
    const payloadStr = JSON.stringify(push.sent.map((s) => s.payload));
    expect(payloadStr).not.toContain("hidden message content");

    // A PUSH delivery row was recorded as DELIVERED.
    const d = await pool.query(
      `SELECT nd.status FROM notification_deliveries nd
         JOIN notifications n ON n.id = nd.notification_id
        WHERE n.user_id=$1 AND nd.channel='PUSH'`,
      [b.userId],
    );
    expect(d.rows.some((r) => r.status === "DELIVERED")).toBe(true);

    await closeSocket(bSock);
  });
});
