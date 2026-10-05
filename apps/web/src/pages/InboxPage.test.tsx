import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { act } from "@testing-library/react";
import type { MatchSummary } from "@luvora/shared";
import { InboxPage } from "./InboxPage";
import {
  createMockServer,
  installFakeWebSocket,
  renderApp,
  seedSession,
  clearSession,
  ok,
  FakeWebSocket,
  type MockServer,
} from "../test/harness";

function match(overrides: Partial<MatchSummary> = {}): MatchSummary {
  return {
    matchId: "m1",
    user: { id: "other1", displayName: "Mina", photo: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    conversationId: "conv1",
    lastMessage: {
      id: "msg1",
      text: "hey there",
      senderId: "other1",
      createdAt: "2026-01-02T00:00:00.000Z",
      hasAttachments: false,
    },
    unreadCount: 2,
    ...overrides,
  };
}

function seedMe(server: MockServer) {
  server.on("GET /api/auth/me", () =>
    ({ json: ok({ id: "u1", email: "a@b.com", age: 30, ageConfirmed: true, emailVerified: true }) }),
  );
}

describe("InboxPage", () => {
  let server: MockServer;
  beforeEach(() => {
    seedSession();
    installFakeWebSocket();
    server = createMockServer();
    server.install();
    seedMe(server);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
  });

  it("renders match rows with preview and unread badge", async () => {
    server.on("GET /api/matches", () => ({ json: ok({ matches: [match()], totalUnreadCount: 2 }) }));
    renderApp(<InboxPage />, { inbox: true });
    await waitFor(() => expect(screen.getByText("Mina")).toBeInTheDocument());
    expect(screen.getByText("hey there")).toBeInTheDocument();
    expect(screen.getByLabelText("2 unread")).toBeInTheDocument();
  });

  it("prefixes the preview with 'You:' for the viewer's own last message", async () => {
    const m = match({
      lastMessage: {
        id: "msg9",
        text: "my message",
        senderId: "u1",
        createdAt: "2026-01-02T00:00:00.000Z",
        hasAttachments: false,
      },
      unreadCount: 0,
    });
    server.on("GET /api/matches", () => ({ json: ok({ matches: [m], totalUnreadCount: 0 }) }));
    renderApp(<InboxPage />, { inbox: true });
    await waitFor(() => expect(screen.getByText(/You: my message/)).toBeInTheDocument());
  });

  it("shows the empty state when there are no matches", async () => {
    server.on("GET /api/matches", () => ({ json: ok({ matches: [], totalUnreadCount: 0 }) }));
    renderApp(<InboxPage />, { inbox: true });
    await waitFor(() => expect(screen.getByText(/no matches yet/i)).toBeInTheDocument());
  });

  it("bumps the unread badge live when a WebSocket message.created arrives", async () => {
    const m = match({ unreadCount: 1 });
    server.on("GET /api/matches", () => ({ json: ok({ matches: [m], totalUnreadCount: 1 }) }));
    renderApp(<InboxPage />, { inbox: true });
    await waitFor(() => expect(screen.getByLabelText("1 unread")).toBeInTheDocument());

    // Wait for the socket to open, then deliver an incoming message from the partner.
    await waitFor(() => expect(FakeWebSocket.latest()).toBeTruthy());
    await act(async () => {
      FakeWebSocket.latest()!.emit({
        type: "message.created",
        message: {
          id: "msgNew",
          conversationId: "conv1",
          senderId: "other1",
          body: "new incoming",
          clientMessageId: null,
          createdAt: "2026-01-03T00:00:00.000Z",
          attachments: [],
        },
      });
    });

    await waitFor(() => expect(screen.getByLabelText("2 unread")).toBeInTheDocument());
    expect(screen.getByText("new incoming")).toBeInTheDocument();
  });
});
