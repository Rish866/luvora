import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import type { ApiResponse } from "@luvora/shared";
import { ApiProvider } from "../api/ApiContext";
import { AuthProvider } from "../auth/AuthContext";
import { RealtimeProvider } from "../api/RealtimeContext";
import { InboxProvider } from "../hooks/useInbox";
import { tokenStore } from "../api/tokenStore";

/**
 * A tiny request-router used by tests to stub the global `fetch`. Keys are
 * "METHOD /path" (path matched by prefix, ignoring query string); the value is
 * a function returning the envelope body (or a Response-like for raw calls).
 */
export type RouteHandler = (req: {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;

export interface MockServer {
  on: (key: string, handler: RouteHandler) => void;
  calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }>;
  install: () => void;
}

export function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}
export function fail(code: string, message: string, details?: unknown): ApiResponse<never> {
  return { success: false, error: { code, message, ...(details !== undefined ? { details } : {}) } } as ApiResponse<never>;
}

/** Build a mock fetch that routes by "METHOD /path". Unmatched routes 404. */
export function createMockServer(): MockServer {
  const routes = new Map<string, RouteHandler>();
  const calls: MockServer["calls"] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const u = new URL(url, "http://localhost");
    const path = u.pathname;
    const key = `${method} ${path}`;
    const headers = (init?.headers as Record<string, string>) ?? {};
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, path, body, headers });

    // Match exact, then by longest matching prefix (so "/api/matches/:id" works).
    let handler = routes.get(key);
    if (!handler) {
      for (const [rk, rh] of routes) {
        const [rm, rp] = rk.split(" ");
        if (rm === method && path.startsWith(rp)) {
          handler = rh;
          break;
        }
      }
    }
    if (!handler) {
      return new Response(JSON.stringify(fail("NOT_FOUND", `No route for ${key}`)), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await handler({ method, path, body, headers });
    return new Response(JSON.stringify(result.json), {
      status: result.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  return {
    calls,
    on(key, handler) {
      routes.set(key, handler);
    },
    install() {
      vi.stubGlobal("fetch", fetchImpl);
    },
  };
}

/** A controllable fake WebSocket so tests can drive server events. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    // Open asynchronously, like a real socket.
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(): void {
    /* no-op in tests */
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  /** Test helper: deliver a server event to this socket. */
  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  static latest(): FakeWebSocket | undefined {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }
  static reset(): void {
    FakeWebSocket.instances = [];
  }
}

export function installFakeWebSocket(): void {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
}

/** Seed a logged-in session (access + refresh token) before rendering. */
export function seedSession(access = "access-token", refresh = "refresh-token"): void {
  tokenStore.setTokens(access, refresh);
}

export function clearSession(): void {
  tokenStore.clear();
}

/** Render children wrapped in the full provider stack + a MemoryRouter.
 *  Set `inbox: true` to also mount the InboxProvider (needed for pages that
 *  consume useInbox, e.g. Discover/Inbox/Conversation). */
export function renderApp(
  ui: ReactElement,
  { route = "/", inbox = false }: { route?: string; inbox?: boolean } = {},
): RenderResult {
  function Wrapper({ children }: { children: ReactNode }) {
    const inner = inbox ? <InboxProvider>{children}</InboxProvider> : children;
    return (
      <MemoryRouter
        initialEntries={[route]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ApiProvider>
          <AuthProvider>
            <RealtimeProvider>{inner}</RealtimeProvider>
          </AuthProvider>
        </ApiProvider>
      </MemoryRouter>
    );
  }
  return render(ui, { wrapper: Wrapper });
}
