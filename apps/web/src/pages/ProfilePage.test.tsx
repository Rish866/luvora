import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProfileView } from "@luvora/shared";
import { ProfilePage } from "./ProfilePage";
import {
  createMockServer,
  installFakeWebSocket,
  renderApp,
  seedSession,
  clearSession,
  ok,
  type MockServer,
} from "../test/harness";

const BASE_PROFILE: ProfileView = {
  userId: "u1",
  displayName: "Ada",
  bio: "Hello there",
  interests: ["chess", "coffee"],
  fantasyPreferences: [],
  discoverable: true,
  ageVisible: true,
  onlineStatusVisible: true,
  readReceiptsEnabled: true,
  photos: [],
  primaryPhoto: null,
  profileComplete: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function seedMe(server: MockServer) {
  server.on("GET /api/auth/me", () =>
    ({ json: ok({ id: "u1", email: "ada@luvora.test", age: 30, ageConfirmed: true, emailVerified: true }) }),
  );
}

describe("ProfilePage", () => {
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

  it("loads and shows the current profile values", async () => {
    server.on("GET /api/profile", () => ({ json: ok({ profile: BASE_PROFILE }) }));
    renderApp(<ProfilePage />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Hello there")).toBeInTheDocument();
    expect(screen.getByDisplayValue("chess, coffee")).toBeInTheDocument();
    expect(screen.getByText("ada@luvora.test")).toBeInTheDocument();
  });

  it("saves edits and sends only editable fields (never ids/photos/moderation)", async () => {
    server.on("GET /api/profile", () => ({ json: ok({ profile: BASE_PROFILE }) }));
    let patchBody: unknown = null;
    server.on("PATCH /api/profile", (req) => {
      patchBody = req.body;
      return { json: ok({ profile: { ...BASE_PROFILE, displayName: "Ada Lovelace" } }) };
    });

    renderApp(<ProfilePage />);
    const nameInput = await screen.findByDisplayValue("Ada");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Ada Lovelace");
    await userEvent.click(screen.getByRole("button", { name: /save profile/i }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/profile saved/i));

    expect(patchBody).not.toBeNull();
    const sent = patchBody as Record<string, unknown>;
    expect(sent.displayName).toBe("Ada Lovelace");
    // Only the editable allow-list is transmitted — no server-owned fields.
    const allowed = new Set([
      "displayName",
      "bio",
      "interests",
      "fantasyPreferences",
      "discoverable",
      "ageVisible",
      "onlineStatusVisible",
      "readReceiptsEnabled",
    ]);
    for (const key of Object.keys(sent)) {
      expect(allowed.has(key)).toBe(true);
    }
    expect(sent).not.toHaveProperty("userId");
    expect(sent).not.toHaveProperty("photos");
    expect(sent).not.toHaveProperty("profileComplete");
  });

  it("shows an error state with retry when the profile fails to load", async () => {
    let hits = 0;
    server.on("GET /api/profile", () => {
      hits += 1;
      // First attempt fails (envelope error); retry succeeds.
      if (hits === 1) {
        return { status: 503, json: { success: false, error: { code: "INTERNAL", message: "Server error." } } };
      }
      return { json: ok({ profile: BASE_PROFILE }) };
    });

    renderApp(<ProfilePage />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeInTheDocument());
  });
});
