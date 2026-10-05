// Live WebSocket smoke client for notifications + presence (Increment 7).
//
// Connects authenticated sockets for a matched pair (A and B), then verifies:
//   - B receives a `notification.created` event (no private message body) when
//     A sends a chat message, and the same notification is persisted.
//   - B receives a `presence.changed` ONLINE event when A connects.
//   - A second socket for A keeps A ONLINE; closing one socket does not flip
//     A offline; closing the final socket flips A OFFLINE and emits
//     `presence.changed` OFFLINE with a lastSeenAt to the authorized observer.
// Prints KEY=ok / KEY=fail lines the smoke shell script greps for.
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

function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on("close", () => resolve());
    ws.close();
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

function postJson(path, token, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request(
      `${BASE}${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body || "{}")));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

(async () => {
  const out = {};
  try {
    // B connects first and listens for presence + notification events about A.
    const wsB = await openWs(TB, "/ws/chat");
    out.NP_READY_B = (await waitFor(wsB, (m) => m.type === "connection.ready")).userId
      ? "ok"
      : "fail";

    // A connects on chat -> B should observe A going ONLINE.
    const wsA1 = await openWs(TA, "/ws/chat");
    await waitFor(wsA1, (m) => m.type === "connection.ready");
    const onlineEvt = await waitFor(
      wsB,
      (m) => m.type === "presence.changed" && m.userId === UA && m.status === "ONLINE",
    ).catch(() => null);
    out.NP_PRESENCE_ONLINE = onlineEvt ? "ok" : "fail";

    // Presence API: B sees A ONLINE.
    const pres1 = await getJson(`/api/users/${UA}/presence`, TB);
    out.NP_API_ONLINE = pres1.data && pres1.data.status === "ONLINE" ? "ok" : "fail";

    // A opens a SECOND socket (game channel) -> still ONLINE.
    const wsA2 = await openWs(TA, "/ws/game");
    await waitFor(wsA2, (m) => m.type === "game.ready");
    const pres2 = await getJson(`/api/users/${UA}/presence`, TB);
    out.NP_API_STILL_ONLINE_2SOCK = pres2.data && pres2.data.status === "ONLINE" ? "ok" : "fail";

    // A sends B a chat message -> B gets notification.created (no body leak) +
    // the notification is persisted.
    const hist = await getJson(`/api/matches/${MATCH}/messages`, TA);
    const conversationId = hist.data.conversationId;
    wsA1.send(
      JSON.stringify({ type: "message.send", conversationId, body: "top secret payload" }),
    );
    const notifEvt = await waitFor(wsB, (m) => m.type === "notification.created").catch(() => null);
    out.NP_NOTIF_EVENT =
      notifEvt && notifEvt.notification && notifEvt.notification.type === "MESSAGE_RECEIVED"
        ? "ok"
        : "fail";
    out.NP_NOTIF_NO_BODY_LEAK =
      notifEvt && !JSON.stringify(notifEvt).includes("top secret payload") ? "ok" : "fail";
    const feed = await getJson(`/api/notifications`, TB);
    out.NP_NOTIF_PERSISTED =
      feed.data &&
      feed.data.notifications.some((n) => n.type === "MESSAGE_RECEIVED")
        ? "ok"
        : "fail";
    const unread = await getJson(`/api/notifications/unread-count`, TB);
    out.NP_UNREAD_COUNT = unread.data && unread.data.count >= 1 ? "ok" : "fail";

    // Close the FIRST A socket -> A still ONLINE (game socket remains).
    await closeWs(wsA1);
    await new Promise((r) => setTimeout(r, 300));
    const pres3 = await getJson(`/api/users/${UA}/presence`, TB);
    out.NP_STILL_ONLINE_AFTER_1_CLOSE =
      pres3.data && pres3.data.status === "ONLINE" ? "ok" : "fail";

    // Close the FINAL A socket -> A OFFLINE + presence.changed OFFLINE w/ lastSeen.
    await closeWs(wsA2);
    const offlineEvt = await waitFor(
      wsB,
      (m) => m.type === "presence.changed" && m.userId === UA && m.status === "OFFLINE",
    ).catch(() => null);
    out.NP_PRESENCE_OFFLINE = offlineEvt ? "ok" : "fail";
    out.NP_PRESENCE_OFFLINE_LASTSEEN =
      offlineEvt && offlineEvt.lastSeenAt ? "ok" : "fail";
    const pres4 = await getJson(`/api/users/${UA}/presence`, TB);
    out.NP_API_OFFLINE_LASTSEEN =
      pres4.data && pres4.data.status === "OFFLINE" && pres4.data.lastSeenAt
        ? "ok"
        : "fail";

    await closeWs(wsB);
  } catch (e) {
    out.ERROR = e.message;
  }
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
  process.exit(0);
})();
