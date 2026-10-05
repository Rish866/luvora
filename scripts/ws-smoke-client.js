// Live WebSocket smoke client. Connects two authenticated sockets (G and H),
// sends a message from G, and verifies real-time delivery, sender identity,
// persistence (via HTTP history), and IDOR rejection for an unrelated socket.
// Prints KEY=ok / KEY=fail lines the smoke shell script greps for.
//
// Env: WS_PORT, WS_TG, WS_TH, WS_MATCH, WS_BASE
const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.WS_PORT;
const TG = process.env.WS_TG;
const TH = process.env.WS_TH;
const MATCH = process.env.WS_MATCH;
const BASE = process.env.WS_BASE;

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
    ws.on("unexpected-response", (_r, res) =>
      reject(new Error("handshake " + res.statusCode)),
    );
  });
}

function waitFor(ws, pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const existing = ws.messages.find(pred);
    if (existing) return resolve(existing);
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    const onMsg = () => {
      const m = ws.messages.find(pred);
      if (m) {
        clearTimeout(t);
        ws.off("message", onMsg);
        resolve(m);
      }
    };
    ws.on("message", onMsg);
  });
}

function getJson(path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}${path}`,
      { headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body)));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  const out = {};
  try {
    // Resolve the conversation id from history.
    const hist = await getJson(`/api/matches/${MATCH}/messages`, TG);
    const conversationId = hist.data.conversationId;

    const wsG = await openWs(TG);
    const wsH = await openWs(TH);
    out.WS_READY_G = (await waitFor(wsG, (m) => m.type === "connection.ready")).userId
      ? "ok"
      : "fail";
    out.WS_READY_H = (await waitFor(wsH, (m) => m.type === "connection.ready")).userId
      ? "ok"
      : "fail";

    // G sends over WS; H should receive message.created.
    wsG.send(
      JSON.stringify({ type: "message.send", conversationId, body: "WS hello" }),
    );
    const recvH = await waitFor(wsH, (m) => m.type === "message.created");
    out.WS_RECV_H = recvH.message && recvH.message.body === "WS hello" ? "ok" : "fail";
    const gUserId = (wsG.messages.find((m) => m.type === "connection.ready") || {})
      .userId;
    out.WS_RECV_SENDER_OK = recvH.message && recvH.message.senderId === gUserId ? "ok" : "fail";

    // Persisted: fetch history and confirm the message id is present.
    const hist2 = await getJson(`/api/matches/${MATCH}/messages`, TH);
    out.WS_PERSISTED = hist2.data.messages.some((m) => m.id === recvH.message.id)
      ? "ok"
      : "fail";

    // IDOR: an unrelated user's socket cannot send into this conversation.
    const TI = process.env.WS_TI;
    if (TI) {
      const wsI = await openWs(TI);
      await waitFor(wsI, (m) => m.type === "connection.ready");
      wsI.send(JSON.stringify({ type: "message.send", conversationId, body: "x" }));
      const err = await waitFor(wsI, (m) => m.type === "error").catch(() => null);
      out.WS_IDOR_REJECTED = err && err.code === "CHAT_NOT_AUTHORIZED" ? "ok" : "fail";
      wsI.close();
    } else {
      out.WS_IDOR_REJECTED = "skip";
    }

    wsG.close();
    wsH.close();
  } catch (e) {
    out.ERROR = e.message;
  }
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
  process.exit(0);
})();
