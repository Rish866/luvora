import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { closePool, pool } from "../src/db/pool";
import {
  resetDb,
  registerUser,
  createMatch,
  auth,
  insertBlock,
  makeJpeg,
  uploadImage,
  type RegisteredUser,
} from "./helpers";
import { setMediaProviders, resetMediaProviders } from "../src/media/mediaProviders";

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

async function matchedPair(): Promise<{ a: RegisteredUser; b: RegisteredUser; matchId: string }> {
  const a = await registerUser(app);
  const b = await registerUser(app);
  const matchId = await createMatch(a.userId, b.userId);
  return { a, b, matchId };
}

const sendMessage = (u: RegisteredUser, matchId: string, body: object) =>
  request(app).post(`/api/matches/${matchId}/messages`).set(...auth(u.accessToken)).send(body);

describe("chat attachments: happy path", () => {
  it("sends a message with a READY attachment and returns a safe attachment DTO", async () => {
    const { a, matchId } = await matchedPair();
    const { mediaId } = await uploadImage(app, a, await makeJpeg(), "image/jpeg");
    const res = await sendMessage(a, matchId, { body: "look!", attachmentIds: [mediaId] });
    expect(res.status).toBe(201);
    const att = res.body.data.message.attachments;
    expect(att).toHaveLength(1);
    expect(att[0].id).toBe(mediaId);
    expect(att[0].mimeType).toBe("image/jpeg");
    expect(att[0].url).toBe(`/api/media/${mediaId}/content`);
    // No storage internals leaked.
    expect(JSON.stringify(res.body)).not.toContain("storage_key");
  });

  it("allows an attachment-only message (empty body)", async () => {
    const { a, matchId } = await matchedPair();
    const { mediaId } = await uploadImage(app, a, await makeJpeg(), "image/jpeg");
    const res = await sendMessage(a, matchId, { attachmentIds: [mediaId] });
    expect(res.status).toBe(201);
    expect(res.body.data.message.attachments).toHaveLength(1);
  });

  it("history returns attachments for the page", async () => {
    const { a, b, matchId } = await matchedPair();
    const { mediaId } = await uploadImage(app, a, await makeJpeg(), "image/jpeg");
    await sendMessage(a, matchId, { body: "hi", attachmentIds: [mediaId] });
    const hist = await request(app)
      .get(`/api/matches/${matchId}/messages`)
      .set(...auth(b.accessToken));
    expect(hist.status).toBe(200);
    const msg = hist.body.data.messages[0];
    expect(msg.attachments[0].id).toBe(mediaId);
  });

  it("recipient can download the attachment bytes", async () => {
    const { a, b, matchId } = await matchedPair();
    const { mediaId } = await uploadImage(app, a, await makeJpeg(), "image/jpeg");
    await sendMessage(a, matchId, { body: "hi", attachmentIds: [mediaId] });
    const dl = await request(app).get(`/api/media/${mediaId}/content`).set(...auth(b.accessToken));
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toContain("image/jpeg");
    expect(dl.headers["cache-control"]).toContain("no-store");
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("chat attachments: validation & transaction", () => {
  it("rejects an attachment the sender does not own (no partial message)", async () => {
    const { a, b, matchId } = await matchedPair();
    const { mediaId } = await uploadImage(app, b, await makeJpeg(), "image/jpeg"); // owned by B
    const res = await sendMessage(a, matchId, { body: "x", attachmentIds: [mediaId] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("MEDIA_NOT_AUTHORIZED");
    // No message was created (rollback).
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM messages`);
    expect(rows[0].n).toBe(0);
  });

  it("rejects an attachment that is not READY (still UPLOADING)", async () => {
    const { a, matchId } = await matchedPair();
    const intent = await request(app)
      .post("/api/media")
      .set(...auth(a.accessToken))
      .send({ mimeType: "image/jpeg", sizeBytes: 100, context: "chat" });
    const res = await sendMessage(a, matchId, { body: "x", attachmentIds: [intent.body.data.mediaId] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MEDIA_NOT_READY");
  });

  it("rejects a rejected/quarantined attachment", async () => {
    const { a, matchId } = await matchedPair();
    // Force moderation to reject this upload, so the asset is not READY/APPROVED.
    setMediaProviders({
      moderation: { async moderate() { return { status: "REJECTED" as const }; } },
    });
    const up = await uploadImage(app, a, await makeJpeg(), "image/jpeg"); // becomes REJECTED
    resetMediaProviders();
    const res = await sendMessage(a, matchId, { body: "x", attachmentIds: [up.mediaId] });
    expect([403, 409]).toContain(res.status);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM messages`);
    expect(rows[0].n).toBe(0);
  });

  it("rejects too many attachments", async () => {
    const { a, matchId } = await matchedPair();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push((await uploadImage(app, a, await makeJpeg(), "image/jpeg")).mediaId);
    }
    const res = await sendMessage(a, matchId, { body: "x", attachmentIds: ids });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOO_MANY_ATTACHMENTS");
  });

  it("rejects an unknown attachment id", async () => {
    const { a, matchId } = await matchedPair();
    const res = await sendMessage(a, matchId, {
      body: "x",
      attachmentIds: ["00000000-0000-0000-0000-000000000000"],
    });
    expect(res.status).toBe(403);
  });

  it("duplicate clientMessageId is idempotent (no duplicate message or attachment rows)", async () => {
    const { a, matchId } = await matchedPair();
    const { mediaId } = await uploadImage(app, a, await makeJpeg(), "image/jpeg");
    const cmid = "33333333-3333-4333-8333-333333333333";
    const r1 = await sendMessage(a, matchId, { body: "x", attachmentIds: [mediaId], clientMessageId: cmid });
    const r2 = await sendMessage(a, matchId, { body: "x", attachmentIds: [mediaId], clientMessageId: cmid });
    expect(r1.body.data.message.id).toBe(r2.body.data.message.id);
    const msgs = await pool.query(`SELECT count(*)::int AS n FROM messages`);
    expect(msgs.rows[0].n).toBe(1);
    const atts = await pool.query(`SELECT count(*)::int AS n FROM message_attachments`);
    expect(atts.rows[0].n).toBe(1);
  });
});

describe("chat attachments: authorization & block", () => {
  it("unrelated user cannot download an attachment from a conversation they're not in", async () => {
    const { a, b, matchId } = await matchedPair();
    const c = await registerUser(app);
    const { mediaId } = await uploadImage(app, a, await makeJpeg(), "image/jpeg");
    await sendMessage(a, matchId, { body: "hi", attachmentIds: [mediaId] });
    void b;
    const dl = await request(app).get(`/api/media/${mediaId}/content`).set(...auth(c.accessToken));
    expect(dl.status).toBe(403);
  });

  it("after a block, the recipient can no longer download the attachment", async () => {
    const { a, b, matchId } = await matchedPair();
    const { mediaId } = await uploadImage(app, a, await makeJpeg(), "image/jpeg");
    await sendMessage(a, matchId, { body: "hi", attachmentIds: [mediaId] });
    // Before block: B can access.
    expect((await request(app).get(`/api/media/${mediaId}/content`).set(...auth(b.accessToken))).status).toBe(200);
    // A blocks B via the real API (sets match BLOCKED).
    const block = await request(app).post(`/api/users/${b.userId}/block`).set(...auth(a.accessToken));
    expect(block.status).toBe(200);
    // After block: B's media access follows the chat policy -> denied.
    const dl = await request(app).get(`/api/media/${mediaId}/content`).set(...auth(b.accessToken));
    expect(dl.status).toBe(403);
    // The owner (A) can still access their own asset.
    expect((await request(app).get(`/api/media/${mediaId}/content`).set(...auth(a.accessToken))).status).toBe(200);
  });

  it("blocked sender cannot send a new attachment message", async () => {
    const { a, b, matchId } = await matchedPair();
    await insertBlock(b.userId, a.userId);
    await pool.query(`UPDATE matches SET state = 'BLOCKED' WHERE id = $1`, [matchId]);
    const { mediaId } = await uploadImage(app, a, await makeJpeg(), "image/jpeg");
    const res = await sendMessage(a, matchId, { body: "x", attachmentIds: [mediaId] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CHAT_NOT_AUTHORIZED");
  });
});
