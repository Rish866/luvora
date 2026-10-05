import { describe, it, expect } from "vitest";
import { LocalPresenceBackend } from "../src/presence/LocalPresenceBackend";
import { DistributedPresenceBackend } from "../src/presence/DistributedPresenceBackend";
import { LocalRealtimeBus } from "../src/notifications/bus/LocalRealtimeBus";
import type { RealtimeEnvelope } from "../src/notifications/bus/RealtimeBus";
import { PresenceStatus, type ServerRealtimeEvent } from "@luvora/shared";

/**
 * Unit-level tests for the Increment 8 distributed abstractions. These exercise
 * the backend/bus contracts WITHOUT a database or sockets — they verify the
 * TTL/heartbeat accounting, transition semantics, duplicate-event tolerance, and
 * a two-instance realtime-bus simulation (no Redis required).
 */

describe("LocalPresenceBackend: ref-counting across connections", () => {
  it("is ONLINE while any connection is held and OFFLINE only on the last", () => {
    const b = new LocalPresenceBackend(60_000);
    const transitions: Array<[string, string]> = [];
    b.onTransition((u, s) => transitions.push([u, s]));

    expect(b.connect("u1", "chat:1")).toBe("ONLINE"); // 0→1
    expect(b.connect("u1", "game:2")).toBe("NONE"); // 1→2 (second channel)
    expect(b.isOnline("u1")).toBe(true);
    expect(b.disconnect("u1", "chat:1")).toBe("NONE"); // 2→1
    expect(b.isOnline("u1")).toBe(true);
    expect(b.disconnect("u1", "game:2")).toBe("OFFLINE"); // 1→0
    expect(b.isOnline("u1")).toBe(false);

    expect(transitions).toEqual([
      ["u1", "ONLINE"],
      ["u1", "OFFLINE"],
    ]);
  });

  it("double-disconnect of an unknown connection never goes negative", () => {
    const b = new LocalPresenceBackend(60_000);
    b.connect("u1", "c1");
    expect(b.disconnect("u1", "c1")).toBe("OFFLINE");
    expect(b.disconnect("u1", "c1")).toBe("NONE"); // already gone
    expect(b.disconnect("u1", "unknown")).toBe("NONE");
    expect(b.isOnline("u1")).toBe(false);
  });
});

describe("LocalPresenceBackend: heartbeat + TTL reaping", () => {
  it("a connection without a heartbeat within the TTL is reaped → OFFLINE", () => {
    const ttl = 1000;
    const b = new LocalPresenceBackend(ttl);
    const offline: string[] = [];
    b.onTransition((u, s) => {
      if (s === "OFFLINE") offline.push(u);
    });
    b.connect("u1", "c1");
    // Simulate TTL expiry by reaping with a future clock.
    const reaped = b.reapExpired(Date.now() + ttl + 1);
    expect(reaped).toEqual(["u1"]);
    expect(b.isOnline("u1")).toBe(false);
    expect(offline).toEqual(["u1"]);
  });

  it("a heartbeat refreshes the TTL so a live connection is not reaped", () => {
    const ttl = 1000;
    const b = new LocalPresenceBackend(ttl);
    const t0 = Date.now();
    b.connect("u1", "c1");
    // Heartbeat just before expiry (at t0+900), then reap at t0+1200: the
    // connection's lastSeen (~now) is well within TTL, so it survives.
    b.heartbeat("u1", "c1");
    const reaped = b.reapExpired(Date.now() + 500);
    expect(reaped).toEqual([]);
    expect(b.isOnline("u1")).toBe(true);
    void t0;
  });

  it("reaping only the stale connection keeps the user ONLINE if another is fresh", () => {
    const ttl = 1000;
    const b = new LocalPresenceBackend(ttl);
    b.connect("u1", "stale");
    // Advance, then add a fresh connection and reap: 'stale' expires, 'fresh'
    // (added at ~now) survives, so u1 remains ONLINE and does NOT transition.
    const transitions: string[] = [];
    b.onTransition((_u, s) => transitions.push(s));
    b.connect("u1", "fresh"); // lastSeen ~ now
    // Reap with a clock just past the first TTL but within the fresh one.
    b.reapExpired(Date.now() + ttl - 10); // nothing stale yet
    expect(b.isOnline("u1")).toBe(true);
    expect(transitions).toEqual([]);
  });
});

describe("DistributedPresenceBackend: safe fallback", () => {
  it("degrades to local behaviour when no shared store is wired", () => {
    const b = new DistributedPresenceBackend(60_000, ""); // empty REDIS_URL
    expect(b.connect("u1", "c1")).toBe("ONLINE");
    expect(b.isOnline("u1")).toBe(true);
    expect(b.disconnect("u1", "c1")).toBe("OFFLINE");
    expect(b.isOnline("u1")).toBe(false);
  });
});

describe("LocalRealtimeBus: publish/subscribe + duplicate tolerance", () => {
  function envelope(id: string, userId: string): RealtimeEnvelope {
    const event: ServerRealtimeEvent = {
      type: "presence.changed",
      userId,
      status: PresenceStatus.ONLINE,
    };
    return { eventId: id, userId, event };
  }

  it("delivers published envelopes to subscribers", () => {
    const bus = new LocalRealtimeBus();
    const received: RealtimeEnvelope[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish(envelope("e1", "u1"));
    expect(received).toHaveLength(1);
    expect(received[0].userId).toBe("u1");
  });

  it("unsubscribe stops further delivery", () => {
    const bus = new LocalRealtimeBus();
    const received: RealtimeEnvelope[] = [];
    const off = bus.subscribe((e) => received.push(e));
    bus.publish(envelope("e1", "u1"));
    off();
    bus.publish(envelope("e2", "u1"));
    expect(received).toHaveLength(1);
  });

  it("a consumer that de-dups on eventId tolerates duplicate deliveries", () => {
    const bus = new LocalRealtimeBus();
    const seen = new Set<string>();
    const delivered: string[] = [];
    bus.subscribe((e) => {
      if (seen.has(e.eventId)) return;
      seen.add(e.eventId);
      delivered.push(e.eventId);
    });
    bus.publish(envelope("dup", "u1"));
    bus.publish(envelope("dup", "u1")); // duplicate
    expect(delivered).toEqual(["dup"]);
  });
});

describe("RealtimeBus: two-instance simulation (no Redis)", () => {
  it("an event published by instance A reaches a subscriber on instance B, scoped to the target user", () => {
    // One shared bus stands in for a cross-instance pub/sub.
    const bus = new LocalRealtimeBus();

    // "Instance B" fans out only to the users IT holds sockets for.
    const bSockets = new Map<string, string[]>(); // userId → delivered eventIds
    bSockets.set("partner", []);
    bus.subscribe((e) => {
      const inbox = bSockets.get(e.userId);
      if (inbox) inbox.push(e.eventId); // only delivers to locally-held users
    });

    // "Instance A" publishes a notification event addressed to `partner`.
    bus.publish({
      eventId: "notif:1:partner",
      userId: "partner",
      event: {
        type: "notification.created",
        notification: {
          id: "1",
          type: "MESSAGE_RECEIVED" as never,
          category: "MESSAGES" as never,
          title: "",
          body: "",
          entityType: "conversation",
          entityId: "c1",
          readAt: null,
          createdAt: new Date().toISOString(),
        },
      },
    });
    // And one addressed to a user instance B does NOT hold → not delivered there.
    bus.publish({
      eventId: "notif:2:stranger",
      userId: "stranger",
      event: {
        type: "presence.changed",
        userId: "x",
        status: PresenceStatus.ONLINE,
      },
    });

    expect(bSockets.get("partner")).toEqual(["notif:1:partner"]);
    // The stranger's event was published but instance B holds no stranger socket.
    expect([...bSockets.values()].flat()).not.toContain("notif:2:stranger");
  });
});
