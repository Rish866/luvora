import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import { resetDb, registerUser, createMatch, auth } from "./helpers";

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

/** Set up two matched users and an invited session. Returns the ids/tokens. */
async function setupSession() {
  const a = await registerUser(app);
  const b = await registerUser(app);
  const matchId = await createMatch(a.userId, b.userId);

  const invite = await request(app)
    .post("/api/sessions/invite")
    .set(...auth(a.accessToken))
    .send({ matchId, scenarioId: "midnight-date", scenarioVersion: "v1" });
  expect(invite.status).toBe(201);
  const sessionId = invite.body.data.sessionId;

  const accept = await request(app)
    .post(`/api/sessions/${sessionId}/accept`)
    .set(...auth(b.accessToken))
    .send();
  expect(accept.status).toBe(200);
  expect(accept.body.data.state).toBe("CONSENT");

  return { a, b, matchId, sessionId };
}

describe("fantasy session: invite + consent flow", () => {
  it("runs the full match -> invite -> accept -> consent -> playing flow", async () => {
    const { a, b, sessionId } = await setupSession();

    // Player A consents.
    const aConsent = await request(app)
      .post(`/api/sessions/${sessionId}/consent`)
      .set(...auth(a.accessToken))
      .send({
        responses: [
          { category: "flirting", response: "YES" },
          { category: "teasing", response: "YES" },
          { category: "power_dynamics", response: "NO" },
        ],
        agreeToParticipate: true,
      });
    expect(aConsent.status).toBe(200);
    // A has confirmed, but B has not yet -> still CONSENT, no allow-list.
    expect(aConsent.body.data.state).toBe("CONSENT");
    expect(aConsent.body.data.allowedCategories).toBeNull();
    expect(aConsent.body.data.partnerConfirmed).toBe(false);

    // Player B consents.
    const bConsent = await request(app)
      .post(`/api/sessions/${sessionId}/consent`)
      .set(...auth(b.accessToken))
      .send({
        responses: [
          { category: "flirting", response: "YES" },
          { category: "teasing", response: "MAYBE" }, // not a mutual YES
          { category: "power_dynamics", response: "YES" }, // A said NO
        ],
        agreeToParticipate: true,
      });
    expect(bConsent.status).toBe(200);
    // Both confirmed -> session advances to PLAYING.
    expect(bConsent.body.data.state).toBe("PLAYING");
    // Allow-list contains ONLY mutual-YES categories.
    expect(bConsent.body.data.allowedCategories).toEqual(["flirting"]);
  });

  it("CRITICAL: a player's consent view never reveals the partner's answers", async () => {
    const { a, b, sessionId } = await setupSession();

    await request(app)
      .post(`/api/sessions/${sessionId}/consent`)
      .set(...auth(a.accessToken))
      .send({
        responses: [
          { category: "flirting", response: "YES" },
          { category: "jealousy_themes", response: "NO" },
        ],
        agreeToParticipate: true,
      });

    const bView = await request(app)
      .post(`/api/sessions/${sessionId}/consent`)
      .set(...auth(b.accessToken))
      .send({
        responses: [
          { category: "flirting", response: "YES" },
          { category: "jealousy_themes", response: "YES" },
        ],
        agreeToParticipate: true,
      });

    const serialized = JSON.stringify(bView.body);
    // B must see only their OWN answers echoed, plus the mutual allow-list.
    expect(bView.body.data.yourResponses).toEqual({
      flirting: "YES",
      jealousy_themes: "YES",
    });
    expect(bView.body.data.allowedCategories).toEqual(["flirting"]);
    // The response must not expose A's private "NO" on jealousy_themes as a
    // per-player answer. The only "NO" that could leak would be A's; ensure the
    // allow-list correctly excludes jealousy_themes and B is told nothing about
    // *why*.
    expect(bView.body.data.allowedCategories).not.toContain("jealousy_themes");
    // partnerConfirmed is a boolean only — no answer payload for the partner.
    expect(bView.body.data).not.toHaveProperty("partnerResponses");
    expect(serialized).not.toContain("partnerResponses");
  });

  it("does not start play unless BOTH explicitly agree to participate", async () => {
    const { a, b, sessionId } = await setupSession();

    await request(app)
      .post(`/api/sessions/${sessionId}/consent`)
      .set(...auth(a.accessToken))
      .send({
        responses: [{ category: "flirting", response: "YES" }],
        agreeToParticipate: true,
      });

    // B submits answers but does NOT agree to participate.
    const bView = await request(app)
      .post(`/api/sessions/${sessionId}/consent`)
      .set(...auth(b.accessToken))
      .send({
        responses: [{ category: "flirting", response: "YES" }],
        agreeToParticipate: false,
      });

    expect(bView.body.data.state).toBe("CONSENT");
    expect(bView.body.data.allowedCategories).toBeNull();
  });

  it("rejects unknown consent categories", async () => {
    const { a, sessionId } = await setupSession();
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/consent`)
      .set(...auth(a.accessToken))
      .send({
        responses: [{ category: "not_a_real_category", response: "YES" }],
        agreeToParticipate: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("fantasy session: authorization (IDOR protection)", () => {
  it("a non-participant cannot read or act on a session by guessing its id", async () => {
    const { sessionId } = await setupSession();
    const outsider = await registerUser(app);

    const read = await request(app)
      .get(`/api/sessions/${sessionId}/consent`)
      .set(...auth(outsider.accessToken));
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe("SESSION_NOT_AUTHORIZED");

    const act = await request(app)
      .post(`/api/sessions/${sessionId}/consent`)
      .set(...auth(outsider.accessToken))
      .send({
        responses: [{ category: "flirting", response: "YES" }],
        agreeToParticipate: true,
      });
    expect(act.status).toBe(403);
  });

  it("only the invited player may accept the invitation", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const matchId = await createMatch(a.userId, b.userId);
    const invite = await request(app)
      .post("/api/sessions/invite")
      .set(...auth(a.accessToken))
      .send({ matchId, scenarioId: "midnight-date" });
    const sessionId = invite.body.data.sessionId;

    // The initiator (A) tries to accept their own invite -> forbidden.
    const selfAccept = await request(app)
      .post(`/api/sessions/${sessionId}/accept`)
      .set(...auth(a.accessToken))
      .send();
    expect(selfAccept.status).toBe(403);
  });

  it("cannot invite within a match the caller is not part of", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const outsider = await registerUser(app);
    const matchId = await createMatch(a.userId, b.userId);

    const res = await request(app)
      .post("/api/sessions/invite")
      .set(...auth(outsider.accessToken))
      .send({ matchId, scenarioId: "midnight-date" });
    expect(res.status).toBe(403);
  });

  it("the raw consent_responses are stored privately per user in the DB", async () => {
    const { a, b, sessionId } = await setupSession();
    await request(app)
      .post(`/api/sessions/${sessionId}/consent`)
      .set(...auth(a.accessToken))
      .send({
        responses: [{ category: "flirting", response: "NO" }],
        agreeToParticipate: true,
      });

    // Sanity check at the data layer: A's NO is stored against A only.
    const { rows } = await pool.query(
      `SELECT user_id, category, response FROM consent_responses WHERE session_id = $1`,
      [sessionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(a.userId);
    expect(rows[0].response).toBe("NO");
    // B has no rows yet.
    expect(rows.find((r) => r.user_id === b.userId)).toBeUndefined();
  });
});
