import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import type { ChatMessage, MatchSummary } from "@luvora/shared";
import { ConversationPage } from "./ConversationPage";
import {
  createMockServer,
  installFakeWebSocket,
  renderApp,
  seedSession,
  clearSession,
  ok,
  fail,
  FakeWebSocket,
  type MockServer,
} from "../test/harness";

const MATCH: MatchSummary = {
  matchId: "m1",
  user: { id: "other1", displayName: "Mina", photo: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  conversationId: "conv1",
  lastMessage: null,
  unreadCount: 0,
};

function msg(id: string, senderId: string, body: string): ChatMessage {
  return {
    id,
    conversationId: "conv1",
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

describe("ConversationPage", () => {
  let server: MockServer;
  beforeEach(() => {
    seedSession();
    installFakeWebSocket();
    server = createMockServer();
    server.install();
    seedMe(server);
    server.on("GET /api/matches", () => ({ json: ok({ matches: [MATCH], totalUnreadCount: 0 }) }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
  });

  it("loads match + history and marks the conversation read on open", async () => {
    server.on("GET /api/matches/m1/messages", () =>
      ({ json: ok({ conversationId: "conv1", messages: [msg("a", "other1", "hi"), msg("b", "u1", "yo")], nextCursor: null }) }),
    );
    // Exact-match route for the match detail must beat the messages prefix; the
    // harness checks exact keys first.
    server.on("GET /api/matches/m1", () => ({ json: ok({ match: MATCH }) }));
    let readCalled = false;
    server.on("POST /api/conversations/conv1/read", () => {
      readCalled = true;
      return { json: ok({ conversationId: "conv1", lastReadMessageId: "b", unreadCount: 0 }) };
    });

    renderApp(<Harness />, { route: "/app/inbox/m1", inbox: true });

    await waitFor(() => expect(screen.getByText("hi")).toBeInTheDocument());
    expect(screen.getByText("yo")).toBeInTheDocument();
    await waitFor(() => expect(readCalled).toBe(true));
  });

  it("sends a message and renders only the server-confirmed message (no optimistic insert)", async () => {
    server.on("GET /api/matches/m1", () => ({ json: ok({ match: MATCH }) }));
    server.on("GET /api/matches/m1/messages", () =>
      ({ json: ok({ conversationId: "conv1", messages: [], nextCursor: null }) }),
    );
    server.on("POST /api/conversations/conv1/read", () =>
      ({ json: ok({ conversationId: "conv1", lastReadMessageId: null, unreadCount: 0 }) }),
    );
    let sentBody: unknown = null;
    server.on("POST /api/matches/m1/messages", (req) => {
      sentBody = req.body;
      return { json: ok({ message: msg("new1", "u1", "hello world") }) };
    });

    renderApp(<Harness />, { route: "/app/inbox/m1", inbox: true });
    const input = await screen.findByRole("textbox", { name: /message/i });
    await userEvent.type(input, "hello world");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText("hello world")).toBeInTheDocument());
    // The send carried an idempotency clientMessageId.
    expect(sentBody).not.toBeNull();
    const body = sentBody as Record<string, unknown>;
    expect(body.body).toBe("hello world");
    expect(body.clientMessageId).toBeTruthy();
  });

  it("appends an incoming WebSocket message for this conversation", async () => {
    server.on("GET /api/matches/m1", () => ({ json: ok({ match: MATCH }) }));
    server.on("GET /api/matches/m1/messages", () =>
      ({ json: ok({ conversationId: "conv1", messages: [], nextCursor: null }) }),
    );
    server.on("POST /api/conversations/conv1/read", () =>
      ({ json: ok({ conversationId: "conv1", lastReadMessageId: null, unreadCount: 0 }) }),
    );

    renderApp(<Harness />, { route: "/app/inbox/m1", inbox: true });
    await screen.findByRole("textbox", { name: /message/i });

    await waitFor(() => expect(FakeWebSocket.latest()).toBeTruthy());
    await act(async () => {
      FakeWebSocket.latest()!.emit({ type: "message.created", message: msg("live1", "other1", "live message") });
    });
    await waitFor(() => expect(screen.getByText("live message")).toBeInTheDocument());
  });

  it("shows an unavailable message when the match is not authorized for the viewer", async () => {
    server.on("GET /api/matches/m1", () =>
      ({ status: 403, json: fail("MATCH_NOT_AUTHORIZED", "Not your match.") }),
    );
    renderApp(<Harness />, { route: "/app/inbox/m1", inbox: true });
    await waitFor(() =>
      expect(screen.getByText(/this conversation is not available/i)).toBeInTheDocument(),
    );
  });
});
