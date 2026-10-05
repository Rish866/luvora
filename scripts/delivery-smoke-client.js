// Live WebSocket smoke client for Increment 8 notification delivery + presence.
//
// With a matched pair (A, B): B registers a push device and connects a socket;
// A sends B a message. Verifies B receives notification.created over the bus,
// the payload carries no message body, and (via the shell's DB checks) a PUSH
// delivery row is recorded. Also exercises presence heartbeat keeping a socket
// ONLINE past the short TTL.
//
// Env: WS_PORT, WS_BASE, WS_TA, WS_TB, WS_UA, WS_MATCH
const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.WS_PORT;
const BASE = process.env.WS_BASE;
const TA = process.env.WS_TA;
const TB = process.env.WS_TB;
const UA = process.env.WS_UA;
const MATCH = process.env.WS_MATCH;

function openWs(token, path = "/ws/chat") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, {
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
    ws.on("unexpected-response", (_r, res) => reject(new Error("handshake " + res.statusCode)));
  });
}
function waitFor(ws, pred, ms = 4000) {
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
function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on("close", () => resolve());
    ws.close();
  });
}
function reqJson(method, path, token, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
    const headers = { Authorization: `Bearer ${token}` };
    if (data) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request(`${BASE}${path}`, { method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(JSON.parse(body || "{}")));
    });
    req.on("error", reject);
    if (data) req.end(data);
    else req.end();
  });
}

(async () => {
  const out = {};
  try {
    // B registers a push device (valid token).
    const dev = await reqJson("POST", "/api/notifications/devices", TB, {
      platform: "ANDROID",
      provider: "FCM",
      token: "live-smoke-token-ok-1",
    });
    out.D8_DEVICE_REGISTERED = dev.data && dev.data.device && dev.data.device.active ? "ok" : "fail";
    out.D8_DEVICE_NO_TOKEN_LEAK = !JSON.stringify(dev).includes("live-smoke-token-ok-1") ? "ok" : "fail";

    // B connects a socket and listens.
    const bSock = await openWs(TB, "/ws/chat");
    await waitFor(bSock, (m) => m.type === "connection.ready");

    // A sends B a message.
    const conv = (await reqJson("GET", `/api/matches/${MATCH}/messages`, TA)).data.conversationId;
    void conv;
    await reqJson("POST", `/api/matches/${MATCH}/messages`, TA, { body: "smoke secret body" });

    // B receives notification.created over the bus (payload has no body).
    const evt = await waitFor(bSock, (m) => m.type === "notification.created").catch(() => null);
    out.D8_NOTIF_EVENT = evt && evt.notification && evt.notification.type === "MESSAGE_RECEIVED" ? "ok" : "fail";
    out.D8_NOTIF_NO_BODY = evt && !JSON.stringify(evt).includes("smoke secret body") ? "ok" : "fail";

    // Presence heartbeat: inbound WS activity refreshes the presence TTL on the
    // server. Send a harmless typing event every 700ms for longer than the TTL
    // (2s) and confirm the user is still ONLINE (not reaped).
    const convId = (await reqJson("GET", `/api/matches/${MATCH}/messages`, TB)).data.conversationId;
    for (let i = 0; i < 5; i++) {
      bSock.send(JSON.stringify({ type: "typing.start", conversationId: convId }));
      await new Promise((r) => setTimeout(r, 700));
    }
    const pres = await reqJson("GET", `/api/users/${process.env.WS_UB}/presence`, TA);
    out.D8_PRESENCE_HEARTBEAT_ONLINE = pres.data && pres.data.status === "ONLINE" ? "ok" : "fail";

    await closeWs(bSock);
    void UA;
  } catch (e) {
    out.ERROR = e.message;
  }
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
  process.exit(0);
})();
