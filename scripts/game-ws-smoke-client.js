// Live gameplay WebSocket smoke client. Connects two authenticated sockets to
// /ws/game, subscribes to authoritative state, submits a valid choice, and
// verifies both participants receive the state-change broadcast + persistence.
// Prints KEY=ok / KEY=fail lines the smoke shell greps for.
//
// Env: WS_PORT, WS_TA, WS_TB, WS_SID
const WebSocket = require("ws");

const PORT = process.env.WS_PORT;
const TA = process.env.WS_TA;
const TB = process.env.WS_TB;
const SID = process.env.WS_SID;

function openWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/game`, {
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

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    ((Math.random() * 16) | 0).toString(16),
  );
}

(async () => {
  const out = {};
  try {
    const wsA = await openWs(TA);
    const wsB = await openWs(TB);
    out.GW_READY_A = (await waitFor(wsA, (m) => m.type === "game.ready")).userId ? "ok" : "fail";
    out.GW_READY_B = (await waitFor(wsB, (m) => m.type === "game.ready")).userId ? "ok" : "fail";

    // A subscribes -> authoritative state with a current node.
    wsA.send(JSON.stringify({ type: "game.subscribe", sessionId: SID }));
    const state = await waitFor(wsA, (m) => m.type === "game.state");
    const node = state.state && state.state.node;
    out.GW_SUBSCRIBE_STATE = node && node.key ? "ok" : "fail";

    // Choose a valid choice from the current node (the dance node after the
    // HTTP smoke advanced once); pick the first available choice.
    const choice = (node.choices || []).find((c) => c.available) || (node.choices || [])[0];
    const beforeTurn = state.state.turnNumber;

    const recvA = waitFor(wsA, (m) => m.type === "game.state.changed" || m.type === "game.completed");
    const recvB = waitFor(wsB, (m) => m.type === "game.state.changed" || m.type === "game.completed");
    wsA.send(
      JSON.stringify({
        type: "game.choose",
        sessionId: SID,
        choiceId: choice.id,
        clientActionId: uuid(),
      }),
    );
    const [ea, eb] = await Promise.all([recvA, recvB]);
    out.GW_CHOOSE_BROADCAST_A = ea.state && ea.state.turnNumber === beforeTurn + 1 ? "ok" : "fail";
    out.GW_CHOOSE_BROADCAST_B = eb.state && eb.state.turnNumber === beforeTurn + 1 ? "ok" : "fail";

    // Re-subscribe to confirm persisted authoritative state.
    wsB.send(JSON.stringify({ type: "game.subscribe", sessionId: SID }));
    const after = await waitFor(wsB, (m) => m.type === "game.state");
    out.GW_PERSISTED = after.state && after.state.turnNumber === beforeTurn + 1 ? "ok" : "fail";

    wsA.close();
    wsB.close();
  } catch (e) {
    out.ERROR = e.message;
  }
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
  process.exit(0);
})();
