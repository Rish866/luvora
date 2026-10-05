import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import { seedScenarios } from "../src/db/scenarioSeed";
import {
  resetDb,
  registerUser,
  createMatch,
  createPlayingSession,
  auth,
  type RegisteredUser,
} from "./helpers";

let app: Express;

beforeAll(() => {
  app = createApp();
});
beforeEach(async () => {
  await resetDb();
  // Scenario library persists across resetDb (not in the truncate list), but
  // reseed defensively so each test has the published scenarios available.
  await seedScenarios();
});
afterAll(async () => {
  await closePool();
});

async function publishedScenarioId(slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM scenarios WHERE slug = $1`,
    [slug],
  );
  return rows[0].id;
}

async function playingSession(
  consent: string[] = ["flirting", "teasing", "roleplay", "mystery"],
): Promise<{ a: RegisteredUser; b: RegisteredUser; sessionId: string }> {
  const a = await registerUser(app);
  const b = await registerUser(app);
  const matchId = await createMatch(a.userId, b.userId);
  const sessionId = await createPlayingSession(app, a, b, matchId, consent);
  return { a, b, sessionId };
}

// Convenience
const getState = (u: RegisteredUser, sid: string) =>
  request(app).get(`/api/sessions/${sid}/state`).set(...auth(u.accessToken));
const selectScenario = (u: RegisteredUser, sid: string, scenarioId: string) =>
  request(app).post(`/api/sessions/${sid}/scenario`).set(...auth(u.accessToken)).send({ scenarioId });
const choose = (u: RegisteredUser, sid: string, choiceId: string, clientActionId: string) =>
  request(app)
    .post(`/api/sessions/${sid}/choices/${choiceId}`)
    .set(...auth(u.accessToken))
    .send({ clientActionId });

const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });

// ---------------------------------------------------------------------------
describe("scenario library", () => {
  it("lists only published scenarios", async () => {
    const a = await registerUser(app);
    const res = await request(app).get("/api/scenarios").set(...auth(a.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.scenarios.length).toBeGreaterThanOrEqual(5);
    // No draft/archived leaks: every returned scenario is published (status not exposed, but seeded ones are known).
    const slugs = res.body.data.scenarios.map((s: { slug: string }) => s.slug);
    expect(slugs).toContain("the-midnight-masquerade");
  });

  it("hides unpublished scenarios", async () => {
    const a = await registerUser(app);
    // Insert a DRAFT scenario; it must not appear.
    await pool.query(
      `INSERT INTO scenarios (slug, title, status) VALUES ('secret-draft','Secret Draft','DRAFT')`,
    );
    const res = await request(app).get("/api/scenarios?limit=50").set(...auth(a.accessToken));
    const slugs = res.body.data.scenarios.map((s: { slug: string }) => s.slug);
    expect(slugs).not.toContain("secret-draft");
  });

  it("retrieves a published scenario; unknown returns SCENARIO_NOT_FOUND", async () => {
    const a = await registerUser(app);
    const id = await publishedScenarioId("the-rooftop-secret");
    const ok = await request(app).get(`/api/scenarios/${id}`).set(...auth(a.accessToken));
    expect(ok.status).toBe(200);
    expect(ok.body.data.scenario.slug).toBe("the-rooftop-secret");

    const missing = await request(app)
      .get("/api/scenarios/00000000-0000-0000-0000-000000000000")
      .set(...auth(a.accessToken));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("SCENARIO_NOT_FOUND");
  });

  it("unpublished DRAFT scenario cannot be retrieved by id", async () => {
    const a = await registerUser(app);
    const draft = await pool.query<{ id: string }>(
      `INSERT INTO scenarios (slug, title, status) VALUES ('draft2','Draft 2','DRAFT') RETURNING id`,
    );
    const res = await request(app)
      .get(`/api/scenarios/${draft.rows[0].id}`)
      .set(...auth(a.accessToken));
    expect(res.status).toBe(404);
  });

  it("library requires auth and rejects malformed cursor", async () => {
    expect((await request(app).get("/api/scenarios")).status).toBe(401);
    const a = await registerUser(app);
    const bad = await request(app).get("/api/scenarios?cursor=nope").set(...auth(a.accessToken));
    expect(bad.status).toBe(400);
  });
});

describe("gameplay: scenario selection + start", () => {
  it("selects a scenario and returns the START node with choices", async () => {
    const { a, sessionId } = await playingSession();
    const scenarioId = await publishedScenarioId("the-midnight-masquerade");
    const res = await selectScenario(a, sessionId, scenarioId);
    expect(res.status).toBe(201);
    expect(res.body.data.state.node.type).toBe("START");
    expect(res.body.data.state.node.title).toBe("The Invitation");
    expect(res.body.data.state.node.choices.length).toBe(2);
    expect(res.body.data.state.turnNumber).toBe(0);
  });

  it("cannot select a scenario before consent (session not PLAYING)", async () => {
    // Build a session only up to CONSENT (not PLAYING).
    const a = await registerUser(app);
    const b = await registerUser(app);
    const matchId = await createMatch(a.userId, b.userId);
    const invite = await request(app)
      .post("/api/sessions/invite")
      .set(...auth(a.accessToken))
      .send({ matchId, scenarioId: "x", scenarioVersion: "v1" });
    const sid = invite.body.data.sessionId;
    await request(app).post(`/api/sessions/${sid}/accept`).set(...auth(b.accessToken)).send();
    const scenarioId = await publishedScenarioId("the-rooftop-secret");
    const res = await selectScenario(a, sid, scenarioId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SESSION_NOT_READY");
  });

  it("selecting an unknown scenario returns SCENARIO_NOT_FOUND", async () => {
    const { a, sessionId } = await playingSession();
    const res = await selectScenario(a, sessionId, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("selecting a scenario is idempotent (second select returns same state)", async () => {
    const { a, sessionId } = await playingSession();
    const scenarioId = await publishedScenarioId("the-midnight-masquerade");
    const r1 = await selectScenario(a, sessionId, scenarioId);
    const r2 = await selectScenario(a, sessionId, scenarioId);
    expect(r1.body.data.state.scenarioVersionId).toBe(r2.body.data.state.scenarioVersionId);
    const { rows } = await pool.query(
      `SELECT scenario_version_id FROM fantasy_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(rows[0].scenario_version_id).toBe(r1.body.data.state.scenarioVersionId);
  });
});

describe("gameplay: choices + branching + endings", () => {
  async function startMasquerade(): Promise<{ a: RegisteredUser; b: RegisteredUser; sessionId: string; state: Record<string, unknown> }> {
    const s = await playingSession();
    const scenarioId = await publishedScenarioId("the-midnight-masquerade");
    const res = await selectScenario(s.a, s.sessionId, scenarioId);
    return { ...s, state: res.body.data.state };
  }

  it("advances through valid choices and branches correctly", async () => {
    const { a, sessionId, state } = await startMasquerade();
    const node = state.node as { choices: { id: string; key: string }[] };
    const takeHand = node.choices.find((c) => c.key === "take_hand")!;
    const r = await choose(a, sessionId, takeHand.id, uuid());
    expect(r.status).toBe(200);
    expect(r.body.data.state.node.key).toBe("dance");
    expect(r.body.data.state.turnNumber).toBe(1);
  });

  it("reaches an ending and completes the session", async () => {
    const { a, sessionId, state } = await startMasquerade();
    let node = state.node as { choices: { id: string; key: string }[] };
    // start -> step_back -> balcony
    await choose(a, sessionId, node.choices.find((c) => c.key === "step_back")!.id, uuid());
    let st = (await getState(a, sessionId)).body.data.state;
    node = st.node;
    // balcony -> keep_distance -> ending_mystery (ENDING)
    const r = await choose(a, sessionId, node.choices.find((c) => c.key === "keep_distance")!.id, uuid());
    expect(r.body.data.state.completed).toBe(true);
    expect(r.body.data.state.node.isEnding).toBe(true);
    expect(r.body.data.state.sessionState).toBe("COMPLETED");
    const { rows } = await pool.query(`SELECT state FROM fantasy_sessions WHERE id = $1`, [sessionId]);
    expect(rows[0].state).toBe("COMPLETED");
  });

  it("cannot choose after completion", async () => {
    const { a, sessionId, state } = await startMasquerade();
    const node = state.node as { choices: { id: string; key: string }[] };
    await choose(a, sessionId, node.choices.find((c) => c.key === "step_back")!.id, uuid());
    const st = (await getState(a, sessionId)).body.data.state;
    const balconyNode = st.node;
    await choose(a, sessionId, balconyNode.choices.find((c: { key: string }) => c.key === "keep_distance").id, uuid());
    // Now completed. Any further choice fails.
    const after = await choose(a, sessionId, balconyNode.choices[0].id, uuid());
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe("GAME_ALREADY_COMPLETED");
  });

  it("rejects a choice that does not belong to the current node", async () => {
    const { a, sessionId, state } = await startMasquerade();
    // Grab a choice id from a DIFFERENT node (dance node's choices).
    const other = await pool.query<{ id: string }>(
      `SELECT c.id FROM scenario_choices c
         JOIN scenario_nodes n ON n.id = c.node_id
        WHERE n.node_key = 'unmasking' LIMIT 1`,
    );
    void state;
    const res = await choose(a, sessionId, other.rows[0].id, uuid());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CHOICE");
  });

  it("rejects an arbitrary / unknown choice id", async () => {
    const { a, sessionId } = await startMasquerade();
    const res = await choose(a, sessionId, "00000000-0000-0000-0000-000000000000", uuid());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CHOICE");
  });
});

describe("gameplay: consent enforcement", () => {
  it("rejects a consent-gated choice when the category is not mutually allowed", async () => {
    // Consent to flirting only (NOT roleplay).
    const { a, sessionId } = await playingSession(["flirting"]);
    const scenarioId = await publishedScenarioId("the-enchanted-inn");
    const sel = await selectScenario(a, sessionId, scenarioId);
    const node = sel.body.data.state.node as { choices: { id: string; key: string }[] };
    // start -> fire -> fortune
    await choose(a, sessionId, node.choices.find((c) => c.key === "fire")!.id, uuid());
    const st = (await getState(a, sessionId)).body.data.state;
    const fortune = st.node;
    const roleplayChoice = fortune.choices.find((c: { key: string }) => c.key === "roleplay");
    // It should be marked unavailable...
    expect(roleplayChoice.available).toBe(false);
    // ...and the server must reject it.
    const res = await choose(a, sessionId, roleplayChoice.id, uuid());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CONSENT_REQUIRED");
  });

  it("allows a consent-gated choice when mutually allowed", async () => {
    const { a, sessionId } = await playingSession(["roleplay"]);
    const scenarioId = await publishedScenarioId("the-enchanted-inn");
    const sel = await selectScenario(a, sessionId, scenarioId);
    const node = sel.body.data.state.node as { choices: { id: string; key: string }[] };
    await choose(a, sessionId, node.choices.find((c) => c.key === "fire")!.id, uuid());
    const st = (await getState(a, sessionId)).body.data.state;
    const roleplayChoice = st.node.choices.find((c: { key: string }) => c.key === "roleplay");
    expect(roleplayChoice.available).toBe(true);
    const res = await choose(a, sessionId, roleplayChoice.id, uuid());
    expect(res.status).toBe(200);
    expect(res.body.data.state.completed).toBe(true);
  });

  it("never exposes the partner's raw consent responses in game state", async () => {
    const { a, sessionId } = await playingSession(["flirting"]);
    const scenarioId = await publishedScenarioId("the-midnight-masquerade");
    const sel = await selectScenario(a, sessionId, scenarioId);
    const serialized = JSON.stringify(sel.body);
    expect(serialized).not.toContain("partnerResponse");
    expect(serialized).not.toContain('"NO"');
    expect(serialized).not.toContain('"MAYBE"');
  });
});

describe("gameplay: idempotency & concurrency", () => {
  it("duplicate clientActionId does not advance twice", async () => {
    const { a, sessionId } = await playingSession();
    const scenarioId = await publishedScenarioId("the-midnight-masquerade");
    const sel = await selectScenario(a, sessionId, scenarioId);
    const takeHand = (sel.body.data.state.node.choices as { id: string; key: string }[]).find(
      (c) => c.key === "take_hand",
    )!;
    const cid = uuid();
    const r1 = await choose(a, sessionId, takeHand.id, cid);
    const r2 = await choose(a, sessionId, takeHand.id, cid);
    expect(r1.body.data.state.turnNumber).toBe(1);
    expect(r2.body.data.state.turnNumber).toBe(1); // unchanged (idempotent)
    const { rows } = await pool.query(`SELECT turn_number FROM fantasy_sessions WHERE id = $1`, [
      sessionId,
    ]);
    expect(rows[0].turn_number).toBe(1);
  });

  it("concurrent submissions advance the session exactly one turn", async () => {
    const { a, b, sessionId } = await playingSession();
    const scenarioId = await publishedScenarioId("the-midnight-masquerade");
    const sel = await selectScenario(a, sessionId, scenarioId);
    const choices = sel.body.data.state.node.choices as { id: string; key: string }[];
    const takeHand = choices.find((c) => c.key === "take_hand")!;
    const stepBack = choices.find((c) => c.key === "step_back")!;
    // A and B submit different choices simultaneously. Exactly one wins and
    // advances the turn; the loser is serialized AFTER the winner committed, so
    // its (now-stale) choice no longer belongs to the new current node and is
    // safely rejected. Acceptable loser outcomes: 409 GAME_STATE_CONFLICT or
    // 400 INVALID_CHOICE (stale choice vs the advanced node). Exactly one 200.
    const [r1, r2] = await Promise.all([
      choose(a, sessionId, takeHand.id, uuid()),
      choose(b, sessionId, stepBack.id, uuid()),
    ]);
    const statuses = [r1.status, r2.status].sort();
    const okCount = statuses.filter((s) => s === 200).length;
    expect(okCount).toBe(1); // exactly one submission advanced the turn
    for (const s of statuses) expect([200, 400, 409]).toContain(s);
    const { rows } = await pool.query(`SELECT turn_number FROM fantasy_sessions WHERE id = $1`, [
      sessionId,
    ]);
    expect(rows[0].turn_number).toBe(1);
    // Exactly one recorded action advanced the turn to 1.
    const actions = await pool.query(
      `SELECT count(*)::int AS n FROM session_actions WHERE session_id = $1 AND result_turn = 1`,
      [sessionId],
    );
    expect(actions.rows[0].n).toBe(1);
  });

  it("concurrent scenario selection assigns exactly one version", async () => {
    const { a, b, sessionId } = await playingSession();
    const scenarioId = await publishedScenarioId("the-rooftop-secret");
    await Promise.all([
      selectScenario(a, sessionId, scenarioId),
      selectScenario(b, sessionId, scenarioId),
    ]);
    const { rows } = await pool.query(
      `SELECT scenario_version_id FROM fantasy_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(rows[0].scenario_version_id).toBeTruthy();
  });
});

describe("gameplay: authorization / IDOR", () => {
  it("unrelated user cannot view, select, or choose", async () => {
    const { sessionId } = await playingSession();
    const c = await registerUser(app);
    const scenarioId = await publishedScenarioId("the-midnight-masquerade");

    expect((await getState(c, sessionId)).status).toBe(403);
    expect((await selectScenario(c, sessionId, scenarioId)).status).toBe(403);
    const anyChoice = await pool.query<{ id: string }>(`SELECT id FROM scenario_choices LIMIT 1`);
    expect((await choose(c, sessionId, anyChoice.rows[0].id, uuid())).status).toBe(403);
  });

  it("unauthenticated requests are rejected", async () => {
    const { sessionId } = await playingSession();
    expect((await request(app).get(`/api/sessions/${sessionId}/state`)).status).toBe(401);
  });

  it("client cannot set turn/node/version — only choiceId is honored", async () => {
    const { a, sessionId } = await playingSession();
    const scenarioId = await publishedScenarioId("the-midnight-masquerade");
    const sel = await selectScenario(a, sessionId, scenarioId);
    const takeHand = (sel.body.data.state.node.choices as { id: string; key: string }[]).find(
      (c) => c.key === "take_hand",
    )!;
    // Inject bogus fields; they must be ignored.
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/choices/${takeHand.id}`)
      .set(...auth(a.accessToken))
      .send({
        clientActionId: uuid(),
        nextNodeId: "secret-ending",
        turnNumber: 999,
        scenarioVersionId: "00000000-0000-0000-0000-000000000000",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.state.turnNumber).toBe(1); // not 999
    expect(res.body.data.state.node.key).toBe("dance"); // resolved by server
  });
});
