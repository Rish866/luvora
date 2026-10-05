import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { ProtectedRoute } from "./ProtectedRoute";
import {
  createMockServer,
  installFakeWebSocket,
  renderApp,
  seedSession,
  clearSession,
  ok,
  fail,
  type MockServer,
} from "../test/harness";

function Harness() {
  return (
    <Routes>
      <Route
        path="/app/discover"
        element={
          <ProtectedRoute>
            <div>Secret Content</div>
          </ProtectedRoute>
        }
      />
      <Route path="/login" element={<div>Login Screen</div>} />
    </Routes>
  );
}

describe("ProtectedRoute", () => {
  let server: MockServer;
  beforeEach(() => {
    installFakeWebSocket();
    server = createMockServer();
    server.install();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
  });

  it("redirects an unauthenticated visitor to /login", async () => {
    clearSession();
    renderApp(<Harness />, { route: "/app/discover" });
    await waitFor(() => expect(screen.getByText("Login Screen")).toBeInTheDocument());
    expect(screen.queryByText("Secret Content")).not.toBeInTheDocument();
  });

  it("renders protected content for an authenticated visitor", async () => {
    seedSession();
    server.on("GET /api/auth/me", () =>
      ({ json: ok({ id: "u1", email: "a@b.com", age: 30, ageConfirmed: true, emailVerified: true }) }),
    );
    renderApp(<Harness />, { route: "/app/discover" });
    await waitFor(() => expect(screen.getByText("Secret Content")).toBeInTheDocument());
  });

  it("redirects to /login when a stored session can no longer be validated", async () => {
    seedSession();
    // /me 401s and refresh also fails -> session is unrecoverable.
    server.on("GET /api/auth/me", () => ({ status: 401, json: fail("UNAUTHENTICATED", "Expired.") }));
    server.on("POST /api/auth/refresh", () => ({ status: 401, json: fail("UNAUTHENTICATED", "Expired.") }));
    renderApp(<Harness />, { route: "/app/discover" });
    await waitFor(() => expect(screen.getByText("Login Screen")).toBeInTheDocument());
    expect(screen.queryByText("Secret Content")).not.toBeInTheDocument();
  });
});
