import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DiscoveryCandidate } from "@luvora/shared";
import { DiscoverPage } from "./DiscoverPage";
import {
  createMockServer,
  installFakeWebSocket,
  renderApp,
  seedSession,
  clearSession,
  ok,
  type MockServer,
} from "../test/harness";

function candidate(id: string, name: string): DiscoveryCandidate {
  return { id, displayName: name, bio: `${name}'s bio`, interests: ["x"], age: 29, photo: null };
}

function seedCommon(server: MockServer) {
  server.on("GET /api/auth/me", () =>
    ({ json: ok({ id: "u1", email: "a@b.com", age: 30, ageConfirmed: true, emailVerified: true }) }),
  );
  // InboxProvider loads this on mount.
  server.on("GET /api/matches", () => ({ json: ok({ matches: [], totalUnreadCount: 0 }) }));
}

describe("DiscoverPage", () => {
  let server: MockServer;
  beforeEach(() => {
    seedSession();
    installFakeWebSocket();
    server = createMockServer();
    server.install();
    seedCommon(server);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
  });

  it("renders the top candidate from the feed", async () => {
    server.on("GET /api/discovery", () =>
      ({ json: ok({ candidates: [candidate("c1", "Mina"), candidate("c2", "Ravi")], nextCursor: null }) }),
    );
    renderApp(<DiscoverPage />, { inbox: true });
    await waitFor(() => expect(screen.getByText("Mina")).toBeInTheDocument());
    // Only the top candidate is shown at a time.
    expect(screen.queryByText("Ravi")).not.toBeInTheDocument();
  });

  it("shows the empty state when the feed has no candidates", async () => {
    server.on("GET /api/discovery", () => ({ json: ok({ candidates: [], nextCursor: null }) }));
    renderApp(<DiscoverPage />, { inbox: true });
    await waitFor(() => expect(screen.getByText(/no one new right now/i)).toBeInTheDocument());
  });

  it("advances to the next candidate after a pass", async () => {
    server.on("GET /api/discovery", () =>
      ({ json: ok({ candidates: [candidate("c1", "Mina"), candidate("c2", "Ravi")], nextCursor: null }) }),
    );
    server.on("POST /api/discovery/c1/pass", () =>
      ({ json: ok({ action: "PASS", userId: "c1", matched: false, matchId: null }) }),
    );
    renderApp(<DiscoverPage />, { inbox: true });
    await screen.findByText("Mina");
    await userEvent.click(screen.getByRole("button", { name: /pass on mina/i }));
    await waitFor(() => expect(screen.getByText("Ravi")).toBeInTheDocument());
    expect(server.calls.some((c) => c.path === "/api/discovery/c1/pass")).toBe(true);
  });

  it("announces a match when a like results in a mutual match", async () => {
    server.on("GET /api/discovery", () =>
      ({ json: ok({ candidates: [candidate("c1", "Mina")], nextCursor: null }) }),
    );
    server.on("POST /api/discovery/c1/like", () =>
      ({ json: ok({ action: "LIKE", userId: "c1", matched: true, matchId: "m1" }) }),
    );
    renderApp(<DiscoverPage />, { inbox: true });
    await screen.findByText("Mina");
    await userEvent.click(screen.getByRole("button", { name: /like mina/i }));
    await waitFor(() => expect(screen.getByText(/it's a match with mina/i)).toBeInTheDocument());
  });
});
