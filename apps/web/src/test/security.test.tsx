import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import type { ChatMessage, MatchSummary } from "@luvora/shared";
import { ConversationPage } from "../pages/ConversationPage";
import {
  createMockServer,
  installFakeWebSocket,
  renderApp,
  seedSession,
  clearSession,
  ok,
  FakeWebSocket,
  type MockServer,
} from "./harness";

const MATCH: MatchSummary = {
  matchId: "m1",
  user: { id: "other1", displayName: "Mina", photo: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  conversationId: "conv1",
  lastMessage: null,
  unreadCount: 0,
};

function msg(id: string, conversationId: string, senderId: string, body: string): ChatMessage {
  return {
    id,
    conversationId,
    senderId,
    body,
    clientMessageId: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    attachments: [],
  };
}

function seedMe(server: MockServer) {
  server.on("GET /api/auth/me", () =>
    ({ json: ok({ id: "u1", email: "a@b.com", age: 30, ageConfirmed: true, emailVerified: true }) }),
  );
}

function Harness() {
  return (
    <Routes>
      <Route path="/app/inbox/:matchId" element={<ConversationPage />} />
      <Route path="/app/inbox" element={<div>Inbox List</div>} />
    </Routes>
  );
}

describe("security — frontend trust boundaries", () => {
  let server: MockServer;
  beforeEach(() => {
    seedSession("the-access-token", "the-refresh-token");
    installFakeWebSocket();
    server = createMockServer();
    server.install();
    seedMe(server);
    server.on("GET /api/matches", () => ({ json: ok({ matches: [MATCH], totalUnreadCount: 0 }) }));
    server.on("GET /api/matches/m1", () => ({ json: ok({ match: MATCH }) }));
    server.on("GET /api/matches/m1/messages", () =>
      ({ json: ok({ conversationId: "conv1", messages: [], nextCursor: null }) }),
    );
    server.on("POST /api/conversations/conv1/read", () =>
      ({ json: ok({ conversationId: "conv1", lastReadMessageId: null, unreadCount: 0 }) }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
  });

  it("ignores WebSocket messages addressed to a different conversation (no cross-match leak)", async () => {
    renderApp(<Harness />, { route: "/app/inbox/m1", inbox: true });
    await screen.findByRole("textbox", { name: /message/i });
    await waitFor(() => expect(FakeWebSocket.latest()).toBeTruthy());

    // A message for conv1 (this conversation) should render; one for conv2 must not.
    await act(async () => {
      FakeWebSocket.latest()!.emit({ type: "message.created", message: msg("ok1", "conv1", "other1", "belongs here") });
      FakeWebSocket.latest()!.emit({ type: "message.created", message: msg("leak1", "conv2", "stranger", "SECRET FROM ANOTHER CHAT") });
    });

    await waitFor(() => expect(screen.getByText("belongs here")).toBeInTheDocument());
    expect(screen.queryByText("SECRET FROM ANOTHER CHAT")).not.toBeInTheDocument();
  });

  it("renders message text as inert text, not HTML (XSS-safe)", async () => {
    renderApp(<Harness />, { route: "/app/inbox/m1", inbox: true });
    await screen.findByRole("textbox", { name: /message/i });
    await waitFor(() => expect(FakeWebSocket.latest()).toBeTruthy());

    const payload = '<img src=x onerror="window.__xss=1">hello';
    await act(async () => {
      FakeWebSocket.latest()!.emit({ type: "message.created", message: msg("x1", "conv1", "other1", payload) });
    });

    // The literal text is shown; no <img> element was injected and no script ran.
    await waitFor(() => expect(screen.getByText(payload)).toBeInTheDocument());
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("never puts the access token in a request URL (sent via Authorization header only)", async () => {
    renderApp(<Harness />, { route: "/app/inbox/m1", inbox: true });
    await screen.findByRole("textbox", { name: /message/i });
    await waitFor(() => expect(server.calls.length).toBeGreaterThan(0));

    for (const call of server.calls) {
      expect(call.path).not.toContain("the-access-token");
      expect(call.path).not.toContain("the-refresh-token");
    }
    // The authenticated calls carry the token in the Authorization header.
    const authed = server.calls.find((c) => c.path === "/api/matches/m1");
    expect(authed?.headers.Authorization ?? authed?.headers.authorization).toContain("Bearer");
  });
});
