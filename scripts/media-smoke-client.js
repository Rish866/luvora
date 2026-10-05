// Live media smoke client. Uploads a real generated PNG, verifies the server
// detects/normalizes it to READY, attaches it to a chat message, confirms the
// recipient receives a safe attachment DTO over /ws/chat, downloads the bytes
// through the authorized endpoint, and checks IDOR + block behavior.
// Prints KEY=ok / KEY=fail lines the smoke shell greps for.
//
// Env: WS_PORT, WS_BASE, WS_TA (owner/sender), WS_TB (recipient), WS_TC
// (unrelated), WS_UB (recipient user id), WS_MATCH (match id).
const http = require("http");
const WebSocket = require("ws");
const sharp = require("sharp");

const PORT = process.env.WS_PORT;
const BASE = process.env.WS_BASE;
const TA = process.env.WS_TA;
const TB = process.env.WS_TB;
const TC = process.env.WS_TC;
const UB = process.env.WS_UB;
const MATCH = process.env.WS_MATCH;

function req(method, path, token, body, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (body !== undefined && !raw) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    } else if (raw) {
      payload = body;
      headers["Content-Type"] = "application/octet-stream";
    }
    const r = http.request(`${BASE}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }),
      );
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const j = (r) => {
  try {
    return JSON.parse(r.buf.toString());
  } catch {
    return {};
  }
};

function openWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.messages = [];
    ws.on("message", (d) => {
      try {
        ws.messages.push(JSON.parse(d.toString()));
      } catch {
        /* ignore */
      }
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function waitFor(ws, pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const found = ws.messages.find(pred);
    if (found) return resolve(found);
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    const h = () => {
      const m = ws.messages.find(pred);
      if (m) {
        clearTimeout(t);
        ws.off("message", h);
        resolve(m);
      }
    };
    ws.on("message", h);
  });
}

(async () => {
  const out = {};
  try {
    const png = await sharp({
      create: { width: 48, height: 36, channels: 4, background: { r: 200, g: 50, b: 90, alpha: 1 } },
    })
      .png()
      .toBuffer();

    // Intent.
    const intent = await req("POST", "/api/media", TA, {
      filename: "pic.png",
      mimeType: "image/png",
      sizeBytes: png.length,
      context: "chat",
    });
    out.MD_INTENT = intent.status === 201 ? "ok" : "fail";
    const mediaId = j(intent).data.mediaId;

    // Upload bytes.
    const up = await req("PUT", `/api/media/${mediaId}/content`, TA, png, { raw: true });
    const upBody = j(up);
    out.MD_UPLOAD_READY = up.status === 200 && upBody.data.status === "READY" ? "ok" : "fail";
    out.MD_DETECT_PNG = upBody.data && upBody.data.mimeType === "image/png" ? "ok" : "fail";

    // Open recipient WS before attaching.
    const wsB = await openWs(TB);
    await waitFor(wsB, (m) => m.type === "connection.ready");

    // Attach to a chat message.
    const sent = await req("POST", `/api/matches/${MATCH}/messages`, TA, {
      body: "a picture",
      attachmentIds: [mediaId],
    });
    const sentBody = j(sent);
    out.MD_ATTACH =
      sent.status === 201 && sentBody.data.message.attachments.length === 1 ? "ok" : "fail";

    // Recipient receives it over WS with a safe DTO.
    const evt = await waitFor(wsB, (m) => m.type === "message.created");
    const att = evt.message && evt.message.attachments && evt.message.attachments[0];
    out.MD_WS_RECV = att && att.id === mediaId ? "ok" : "fail";
    out.MD_DTO_SAFE =
      att &&
      att.url === `/api/media/${mediaId}/content` &&
      !JSON.stringify(evt).includes("storage_key")
        ? "ok"
        : "fail";

    // Recipient downloads the bytes.
    const dl = await req("GET", `/api/media/${mediaId}/content`, TB);
    out.MD_DOWNLOAD_BYTES =
      dl.status === 200 && dl.buf.length > 0 && String(dl.headers["content-type"]).includes("image/png")
        ? "ok"
        : "fail";

    // IDOR: unrelated user cannot download.
    const idor = await req("GET", `/api/media/${mediaId}/content`, TC);
    out.MD_IDOR_REJECTED = idor.status === 403 ? "ok" : "fail";

    // Block: A blocks B, then B can no longer download.
    await req("POST", `/api/users/${UB}/block`, TA);
    const afterBlock = await req("GET", `/api/media/${mediaId}/content`, TB);
    out.MD_BLOCK_DENIES = afterBlock.status === 403 ? "ok" : "fail";

    wsB.close();
  } catch (e) {
    out.ERROR = e.message;
  }
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
  process.exit(0);
})();
