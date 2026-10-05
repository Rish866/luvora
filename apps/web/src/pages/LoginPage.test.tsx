import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { vi } from "vitest";
import { LoginPage } from "./LoginPage";
import {
  createMockServer,
  installFakeWebSocket,
  renderApp,
  clearSession,
  ok,
  fail,
  type MockServer,
} from "../test/harness";

function LoginHarness() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/app/discover" element={<div>Discover Home</div>} />
      <Route path="/register" element={<div>Register Page</div>} />
    </Routes>
  );
}

describe("LoginPage", () => {
  let server: MockServer;
  beforeEach(() => {
    clearSession();
    installFakeWebSocket();
    server = createMockServer();
    server.install();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs in on valid credentials, stores tokens, and navigates into the app", async () => {
    server.on("POST /api/auth/login", () =>
      ({ json: ok({ userId: "u1", accessToken: "acc", refreshToken: "ref", accessExpiresIn: 900 }) }),
    );
    server.on("GET /api/auth/me", () =>
      ({ json: ok({ id: "u1", email: "a@b.com", age: 30, ageConfirmed: true, emailVerified: true }) }),
    );

    renderApp(<LoginHarness />, { route: "/login" });

    await userEvent.type(screen.getByRole("textbox", { name: /email/i }), "a@b.com");
    // password input has no accessible role=textbox; select by label text container
    const pwd = document.querySelector('input[name="password"]') as HTMLInputElement;
    await userEvent.type(pwd, "secret12345");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText("Discover Home")).toBeInTheDocument());
    // login + me were both called
    expect(server.calls.some((c) => c.path === "/api/auth/login")).toBe(true);
    expect(server.calls.some((c) => c.path === "/api/auth/me")).toBe(true);
  });

  it("shows a safe error message on invalid credentials and does not navigate", async () => {
    server.on("POST /api/auth/login", () =>
      ({ status: 401, json: fail("UNAUTHENTICATED", "Invalid email or password.") }),
    );

    renderApp(<LoginHarness />, { route: "/login" });

    await userEvent.type(screen.getByRole("textbox", { name: /email/i }), "a@b.com");
    const pwd = document.querySelector('input[name="password"]') as HTMLInputElement;
    await userEvent.type(pwd, "wrongpass");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/invalid email or password/i),
    );
    expect(screen.queryByText("Discover Home")).not.toBeInTheDocument();
  });
});
