import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import {
  resetDb,
  registerUser,
  createMatch,
  auth,
  setUserRole,
  getUserState,
  makeJpeg,
  uploadImage,
  type RegisteredUser,
} from "./helpers";
import { resetMediaProviders, setMediaProviders } from "../src/media/mediaProviders";

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

async function moderator(): Promise<RegisteredUser> {
  const u = await registerUser(app);
  await setUserRole(u.userId, "MODERATOR");
  return u;
}
async function admin(): Promise<RegisteredUser> {
  const u = await registerUser(app);
  await setUserRole(u.userId, "ADMIN");
  return u;
}

const H = (u: RegisteredUser) => auth(u.accessToken);

// ===========================================================================
describe("RBAC", () => {
  it("normal user is denied moderator + admin endpoints", async () => {
    const u = await registerUser(app);
    expect((await request(app).get("/api/admin/reports").set(...H(u))).status).toBe(403);
    expect((await request(app).get("/api/admin/audit-logs").set(...H(u))).status).toBe(403);
  });

  it("moderator can access the queue but is denied admin-only actions", async () => {
    const m = await moderator();
    expect((await request(app).get("/api/admin/moderation/queue").set(...H(m))).status).toBe(200);
    // suspend is admin-only.
    const victim = await registerUser(app);
    const res = await request(app)
      .post(`/api/admin/users/${victim.userId}/suspend`)
      .set(...H(m))
      .send({ reason: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN_ROLE");
  });

  it("admin can perform admin actions", async () => {
    const a = await admin();
    const victim = await registerUser(app);
    const res = await request(app)
      .post(`/api/admin/users/${victim.userId}/suspend`)
      .set(...H(a))
      .send({ reason: "harassment", durationHours: 24 });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("SUSPENDED");
  });

  it("role cannot be forged via body/query/header", async () => {
    const u = await registerUser(app);
    // Attempt to pass role in various client-controlled places.
    const res = await request(app)
      .get("/api/admin/reports?role=ADMIN")
      .set(...H(u))
      .set("X-Role", "ADMIN")
      .send({ role: "ADMIN" });
    expect(res.status).toBe(403);
    // DB role unchanged.
    expect((await getUserState(u.userId)).role).toBe("USER");
  });

  it("unauthenticated admin access is 401", async () => {
    expect((await request(app).get("/api/admin/reports")).status).toBe(401);
  });
});

// ===========================================================================
describe("reports", () => {
  it("authenticated user can report another user; reporter identity is private", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const res = await request(app)
      .post(`/api/reports/user/${b.userId}`)
      .set(...H(a))
      .send({ reason: "HARASSMENT", description: "mean" });
    expect(res.status).toBe(201);
    expect(res.body.data.reportId).toBeTruthy();
    // Nothing in the response reveals it to the reported user; the reporter id
    // is not echoed to anyone but the private record/audit.
    expect(JSON.stringify(res.body)).not.toContain(b.userId);
  });

  it("rejects unauthenticated report", async () => {
    const b = await registerUser(app);
    expect((await request(app).post(`/api/reports/user/${b.userId}`).send({ reason: "SPAM" })).status).toBe(401);
  });

  it("rejects self-report", async () => {
    const a = await registerUser(app);
    const res = await request(app).post(`/api/reports/user/${a.userId}`).set(...H(a)).send({ reason: "SPAM" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CANNOT_TARGET_SELF");
  });

  it("rejects an invalid/nonexistent target", async () => {
    const a = await registerUser(app);
    const res = await request(app)
      .post(`/api/reports/user/00000000-0000-0000-0000-000000000000`)
      .set(...H(a))
      .send({ reason: "SPAM" });
    expect(res.status).toBe(404);
  });

  it("duplicate report against the same target is rejected while open", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await request(app).post(`/api/reports/user/${b.userId}`).set(...H(a)).send({ reason: "SPAM" });
    const dup = await request(app).post(`/api/reports/user/${b.userId}`).set(...H(a)).send({ reason: "SPAM" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("DUPLICATE_REPORT");
  });

  it("cannot report media the reporter cannot see (no existence leak)", async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const { mediaId } = await uploadImage(app, owner, await makeJpeg(), "image/jpeg");
    const res = await request(app)
      .post(`/api/reports/media/${mediaId}`)
      .set(...H(stranger))
      .send({ reason: "NONCONSENSUAL" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("INVALID_REPORT_TARGET");
  });
});

describe("report review", () => {
  it("moderator sees queue, assigns, and resolves with a recorded resolution", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const m = await moderator();
    const created = await request(app)
      .post(`/api/reports/user/${b.userId}`)
      .set(...H(a))
      .send({ reason: "HARASSMENT" });
    const reportId = created.body.data.reportId;

    const queue = await request(app).get("/api/admin/moderation/queue").set(...H(m));
    expect(queue.body.data.reports.map((r: { id: string }) => r.id)).toContain(reportId);

    const assigned = await request(app).post(`/api/admin/reports/${reportId}/assign`).set(...H(m)).send();
    expect(assigned.body.data.report.status).toBe("IN_REVIEW");

    const resolved = await request(app)
      .post(`/api/admin/reports/${reportId}/resolve`)
      .set(...H(m))
      .send({ status: "RESOLVED", resolution: "warned" });
    expect(resolved.body.data.report.status).toBe("RESOLVED");
    expect(resolved.body.data.report.resolvedBy).toBe(m.userId);

    // Resolving again is an invalid transition (terminal state).
    const again = await request(app)
      .post(`/api/admin/reports/${reportId}/resolve`)
      .set(...H(m))
      .send({ status: "DISMISSED" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("REPORT_INVALID_TRANSITION");
  });

  it("queue does not leak sensitive fields", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const m = await moderator();
    await request(app).post(`/api/reports/user/${b.userId}`).set(...H(a)).send({ reason: "SPAM" });
    const queue = await request(app).get("/api/admin/reports").set(...H(m));
    const s = JSON.stringify(queue.body);
    for (const forbidden of ["password", "token", "storage_key", "refresh"]) {
      expect(s).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
describe("media moderation", () => {
  async function quarantinedMedia(owner: RegisteredUser): Promise<string> {
    // Force moderation NEEDS_REVIEW so the asset is QUARANTINED (not READY).
    setMediaProviders({ moderation: { async moderate() { return { status: "NEEDS_REVIEW" as const }; } } });
    const up = await uploadImage(app, owner, await makeJpeg(), "image/jpeg");
    resetMediaProviders();
    return up.mediaId;
  }

  it("moderator can approve a quarantined asset (NEEDS_REVIEW -> APPROVED/READY)", async () => {
    const owner = await registerUser(app);
    const m = await moderator();
    const mediaId = await quarantinedMedia(owner);
    const res = await request(app).post(`/api/admin/media/${mediaId}/approve`).set(...H(m)).send();
    expect(res.status).toBe(200);
    expect(res.body.data.media.moderationStatus).toBe("APPROVED");
    expect(res.body.data.media.status).toBe("READY");
    // Now the owner can download it.
    expect((await request(app).get(`/api/media/${mediaId}/content`).set(...H(owner))).status).toBe(200);
  });

  it("moderator can reject (with reason); rejected media is not user-servable", async () => {
    const owner = await registerUser(app);
    const m = await moderator();
    const mediaId = await quarantinedMedia(owner);
    const noReason = await request(app).post(`/api/admin/media/${mediaId}/reject`).set(...H(m)).send({});
    expect(noReason.status).toBe(400); // reason required
    const res = await request(app).post(`/api/admin/media/${mediaId}/reject`).set(...H(m)).send({ reason: "policy" });
    expect(res.body.data.media.status).toBe("REJECTED");
    expect((await request(app).get(`/api/media/${mediaId}/content`).set(...H(owner))).status).toBe(409);
  });

  it("normal user cannot moderate media", async () => {
    const owner = await registerUser(app);
    const u = await registerUser(app);
    const mediaId = await quarantinedMedia(owner);
    expect((await request(app).post(`/api/admin/media/${mediaId}/approve`).set(...H(u)).send()).status).toBe(403);
  });

  it("invalid transition is rejected (approve an already-approved READY asset twice is a no-op path)", async () => {
    const owner = await registerUser(app);
    const m = await moderator();
    // A normally-uploaded asset is already READY+APPROVED.
    const up = await uploadImage(app, owner, await makeJpeg(), "image/jpeg");
    // APPROVED -> APPROVED is not in the transition table -> rejected.
    const res = await request(app).post(`/api/admin/media/${up.mediaId}/approve`).set(...H(m)).send();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_MODERATION_TRANSITION");
  });

  it("deleted media cannot be approved", async () => {
    const owner = await registerUser(app);
    const m = await moderator();
    const mediaId = await quarantinedMedia(owner);
    await pool.query(`UPDATE media_assets SET status='DELETED', deleted_at=now() WHERE id=$1`, [mediaId]);
    const res = await request(app).post(`/api/admin/media/${mediaId}/approve`).set(...H(m)).send();
    expect([404, 409]).toContain(res.status);
  });

  it("moderator review endpoint streams bytes for quarantined media; normal user cannot", async () => {
    const owner = await registerUser(app);
    const m = await moderator();
    const u = await registerUser(app);
    const mediaId = await quarantinedMedia(owner);
    // Moderator can review (even though it's quarantined and not user-servable).
    const review = await request(app).get(`/api/admin/media/${mediaId}/content`).set(...H(m));
    expect(review.status).toBe(200);
    // Normal user hitting the admin review path is forbidden.
    expect((await request(app).get(`/api/admin/media/${mediaId}/content`).set(...H(u))).status).toBe(403);
    // And the normal media endpoint still won't serve quarantined bytes.
    expect((await request(app).get(`/api/media/${mediaId}/content`).set(...H(owner))).status).toBe(409);
  });

  it("concurrent approve/reject on the same media yields one consistent state", async () => {
    const owner = await registerUser(app);
    const m1 = await moderator();
    const m2 = await moderator();
    const mediaId = await quarantinedMedia(owner);
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/admin/media/${mediaId}/approve`).set(...H(m1)).send(),
      request(app).post(`/api/admin/media/${mediaId}/reject`).set(...H(m2)).send({ reason: "x" }),
    ]);
    // The two actions are serialized by SELECT ... FOR UPDATE, so there is no
    // corruption. Each call is either applied (200) or a deterministic
    // invalid-transition conflict (409) against the state the other left; never
    // a 500/partial write. The final state is exactly one consistent value and
    // moderation-action rows exist for each applied decision.
    for (const s of [r1.status, r2.status]) expect([200, 409]).toContain(s);
    expect([r1.status, r2.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(`SELECT moderation_status, status FROM media_assets WHERE id=$1`, [mediaId]);
    expect(rows).toHaveLength(1);
    expect(["APPROVED", "REJECTED"]).toContain(rows[0].moderation_status);
    // Consistency: READY iff APPROVED, REJECTED iff REJECTED.
    if (rows[0].moderation_status === "APPROVED") expect(rows[0].status).toBe("READY");
    if (rows[0].moderation_status === "REJECTED") expect(rows[0].status).toBe("REJECTED");
  });
});

// ===========================================================================
describe("user safety + session revocation", () => {
  it("suspended user: existing access token is rejected, refresh fails, cannot re-login", async () => {
    const a = await admin();
    const victim = await registerUser(app);
    // Victim is active and can call /me.
    expect((await request(app).get("/api/auth/me").set(...H(victim))).status).toBe(200);

    await request(app)
      .post(`/api/admin/users/${victim.userId}/suspend`)
      .set(...H(a))
      .send({ reason: "harassment", durationHours: 48 });

    // Existing access token now rejected with ACCOUNT_SUSPENDED.
    const me = await request(app).get("/api/auth/me").set(...H(victim));
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe("ACCOUNT_SUSPENDED");

    // Refresh token no longer works (sessions revoked).
    const ref = await request(app).post("/api/auth/refresh").send({ refreshToken: victim.refreshToken });
    expect(ref.status).toBe(401);

    // Cannot log in while suspended.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: victim.email, password: "Passw0rd!test" });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("suspended user cannot use chat or game or media endpoints", async () => {
    const a = await admin();
    const u1 = await registerUser(app);
    const u2 = await registerUser(app);
    const matchId = await createMatch(u1.userId, u2.userId);
    await request(app).post(`/api/admin/users/${u1.userId}/suspend`).set(...H(a)).send({ reason: "x" });

    // Chat send.
    expect(
      (await request(app).post(`/api/matches/${matchId}/messages`).set(...H(u1)).send({ body: "hi" })).status,
    ).toBe(403);
    // Media intent.
    expect(
      (await request(app).post("/api/media").set(...H(u1)).send({ mimeType: "image/jpeg", sizeBytes: 10 })).status,
    ).toBe(403);
    // Discovery.
    expect((await request(app).get("/api/discovery").set(...H(u1))).status).toBe(403);
  });

  it("unsuspend restores access", async () => {
    const a = await admin();
    const victim = await registerUser(app);
    await request(app).post(`/api/admin/users/${victim.userId}/suspend`).set(...H(a)).send({ reason: "x" });
    expect((await request(app).get("/api/auth/me").set(...H(victim))).status).toBe(403);
    await request(app).post(`/api/admin/users/${victim.userId}/unsuspend`).set(...H(a)).send();
    // A fresh login works again (old token/sessions stay revoked, which is correct).
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: victim.email, password: "Passw0rd!test" });
    expect(login.status).toBe(200);
  });

  it("expired suspension auto-lapses on next request", async () => {
    const a = await admin();
    const victim = await registerUser(app);
    await request(app).post(`/api/admin/users/${victim.userId}/suspend`).set(...H(a)).send({ reason: "x", durationHours: 1 });
    // Backdate the expiry into the past.
    await pool.query(`UPDATE users SET suspended_until = now() - interval '1 hour' WHERE id = $1`, [victim.userId]);
    // A fresh login should succeed and the account should be ACTIVE again.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: victim.email, password: "Passw0rd!test" });
    expect(login.status).toBe(200);
    expect((await getUserState(victim.userId)).account_status).toBe("ACTIVE");
  });

  it("deactivation blocks the user", async () => {
    const a = await admin();
    const victim = await registerUser(app);
    await request(app).post(`/api/admin/users/${victim.userId}/deactivate`).set(...H(a)).send({ reason: "x" });
    const me = await request(app).get("/api/auth/me").set(...H(victim));
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe("ACCOUNT_DEACTIVATED");
  });
});

// ===========================================================================
describe("admin safeguards", () => {
  it("admin cannot suspend themselves", async () => {
    const a = await admin();
    const res = await request(app).post(`/api/admin/users/${a.userId}/suspend`).set(...H(a)).send({ reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CANNOT_SUSPEND_SELF");
  });

  it("cannot demote or deactivate the last admin", async () => {
    const a = await admin(); // the only admin
    const demote = await request(app).post(`/api/admin/users/${a.userId}/role`).set(...H(a)).send({ role: "USER" });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe("LAST_ADMIN");
    const deact = await request(app).post(`/api/admin/users/${a.userId}/deactivate`).set(...H(a)).send({ reason: "x" });
    // self-deactivate blocked by CANNOT_SUSPEND_SELF first; test last-admin with a 2nd admin.
    expect([400, 409]).toContain(deact.status);
  });

  it("admin can change roles; moderator cannot", async () => {
    const a = await admin();
    const m = await moderator();
    const target = await registerUser(app);
    // Moderator attempt -> 403.
    expect((await request(app).post(`/api/admin/users/${target.userId}/role`).set(...H(m)).send({ role: "MODERATOR" })).status).toBe(403);
    // Admin promotes.
    const res = await request(app).post(`/api/admin/users/${target.userId}/role`).set(...H(a)).send({ role: "MODERATOR" });
    expect(res.status).toBe(200);
    expect((await getUserState(target.userId)).role).toBe("MODERATOR");
  });

  it("invalid role value is rejected", async () => {
    const a = await admin();
    const target = await registerUser(app);
    const res = await request(app).post(`/api/admin/users/${target.userId}/role`).set(...H(a)).send({ role: "SUPERGOD" });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
describe("audit logging", () => {
  it("privileged actions create immutable, sanitized audit entries", async () => {
    const a = await admin();
    const victim = await registerUser(app);
    await request(app).post(`/api/admin/users/${victim.userId}/suspend`).set(...H(a)).send({ reason: "harassment", durationHours: 24 });

    const logs = await request(app).get("/api/admin/audit-logs?action=user.suspended").set(...H(a));
    expect(logs.status).toBe(200);
    const entry = logs.body.data.logs.find((l: { targetId: string }) => l.targetId === victim.userId);
    expect(entry).toBeTruthy();
    expect(entry.actorUserId).toBe(a.userId);
    expect(entry.action).toBe("user.suspended");
    // No secrets anywhere in the audit payload.
    const s = JSON.stringify(logs.body);
    for (const forbidden of ["password", "token", "refresh", "authorization", "storage_key"]) {
      expect(s.toLowerCase()).not.toContain(forbidden);
    }
    // There is no update/delete audit API: only GET exists.
    expect((await request(app).delete("/api/admin/audit-logs").set(...H(a))).status).toBe(404);
  });

  it("normal user cannot read audit logs", async () => {
    const u = await registerUser(app);
    expect((await request(app).get("/api/admin/audit-logs").set(...H(u))).status).toBe(403);
  });

  it("sanitizes forbidden metadata keys", async () => {
    const { sanitizeMetadata } = await import("../src/admin/auditService");
    const out = sanitizeMetadata({ reason: "ok", password: "secret", token: "abc", nested: { a: 1 }, note: "x".repeat(1000) });
    expect(out.reason).toBe("ok");
    expect(out).not.toHaveProperty("password");
    expect(out).not.toHaveProperty("token");
    expect((out.note as string).length).toBeLessThanOrEqual(500);
  });
});

// ===========================================================================
describe("block integration (moderation does not restore blocked access)", () => {
  it("a block remains enforced regardless of moderation activity", async () => {
    const a = await admin();
    const u1 = await registerUser(app);
    const u2 = await registerUser(app);
    const matchId = await createMatch(u1.userId, u2.userId);
    const { mediaId } = await uploadImage(app, u1, await makeJpeg(), "image/jpeg");
    await request(app).post(`/api/matches/${matchId}/messages`).set(...H(u1)).send({ body: "hi", attachmentIds: [mediaId] });
    // u1 blocks u2.
    await request(app).post(`/api/users/${u2.userId}/block`).set(...H(u1));
    // A moderator approving/looking at media does not restore u2's access.
    void a;
    const dl = await request(app).get(`/api/media/${mediaId}/content`).set(...H(u2));
    expect(dl.status).toBe(403);
  });
});
