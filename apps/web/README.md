# @luvora/web — Luvora Web Frontend (MVP)

The browser client for Luvora. A React 18 + TypeScript + Vite single-page app
that consumes the **existing** Luvora backend REST + WebSocket contracts. It
adds no backend behavior of its own — the server remains authoritative for
eligibility, privacy, blocking, matching, authorization, and message delivery.

End-to-end journey covered by this MVP:

> **Auth → onboarding/profile → discovery → match → inbox → conversation →
> messaging → read state.**

## Tech stack

| Concern            | Choice                                             |
| ------------------ | -------------------------------------------------- |
| Framework          | React 18                                           |
| Language           | TypeScript (strict)                                |
| Build/dev server   | Vite 5                                             |
| Routing            | React Router v6                                    |
| State              | React Context + hooks (no Redux/Zustand)           |
| Shared contracts   | `@luvora/shared` (consumed from source via alias)  |
| Tests              | Vitest + Testing Library + jsdom                   |

Shared DTOs come from `@luvora/shared`; the app never redefines backend
response shapes. The Vite/TS alias points at the package **source**
(`packages/shared/src`), mirroring the backend's test config.

## Project layout

```
apps/web/
  index.html
  vite.config.ts            # Vite + Vitest config, @luvora/shared + @ aliases
  tsconfig.json
  .env.example              # PUBLIC VITE_ config only (never secrets)
  src/
    main.tsx                # Provider stack + router bootstrap
    App.tsx                 # Route table
    api/
      client.ts             # ApiClient + ApiError (envelope parse, 401 refresh+retry)
      endpoints.ts          # Typed, resource-oriented facade over ApiClient
      tokenStore.ts         # Access token in-memory, refresh token in localStorage
      ApiContext.tsx        # Provides ApiClient + endpoints to the tree
      RealtimeContext.tsx   # Single /ws/chat WebSocket, bounded reconnect
    auth/AuthContext.tsx    # Session lifecycle (bootstrap/login/register/logout)
    hooks/useInbox.tsx      # Match list + unread counts, kept live from WS events
    components/             # AuthedImage, ProtectedRoute, AppShell, states
    pages/                  # Login, Register, Discover, Inbox, Conversation, Profile
    lib/                    # config, errors, time helpers
    test/                   # setup + shared render harness
```

## Configuration (environment variables)

Only **public** `VITE_`-prefixed variables are read; Vite bundles nothing else
into the browser. **Never put secrets, service keys, or DB credentials here.**

| Variable             | Required | Default        | Purpose                                              |
| -------------------- | -------- | -------------- | ---------------------------------------------------- |
| `VITE_API_BASE_URL`  | no       | `""` (same-origin) | Base URL of the backend HTTP API (no trailing slash). |
| `VITE_WS_BASE_URL`   | no       | derived from API base (`http→ws`, `https→wss`) | Base URL of the backend WebSocket server.            |

Copy `.env.example` to `.env` (or `.env.local`) and set values for your setup.
When `VITE_API_BASE_URL` is empty the app makes same-origin relative requests —
appropriate when the frontend is served behind the same origin / reverse proxy
as the API in production.

## Local development

Prerequisites: Node ≥ 20, the Luvora backend running and reachable.

```bash
# From the repo root (installs all workspaces incl. the web app):
npm install

# Point the app at your running backend:
cp apps/web/.env.example apps/web/.env
# edit apps/web/.env -> VITE_API_BASE_URL / VITE_WS_BASE_URL

# Start the dev server (http://localhost:5173):
npm run dev:web
# or: npm run -w @luvora/web dev
```

### CORS note (dev)

The dev server runs on `http://localhost:5173` and calls the API cross-origin
(e.g. `http://localhost:4000`). The backend must allow that origin: set its
`CORS_ALLOWED_ORIGINS` to include `http://localhost:5173`. Alternatively, serve
the built frontend behind the same origin as the API and leave
`VITE_API_BASE_URL` empty.

## Scripts

Run from the repo root (preferred) or inside `apps/web`:

| Command                              | What it does                                   |
| ------------------------------------ | ---------------------------------------------- |
| `npm run dev:web`                    | Vite dev server with HMR.                      |
| `npm run build:web`                  | Typecheck then production `vite build`.        |
| `npm run typecheck:web`              | `tsc --noEmit` (strict).                       |
| `npm run test:web`                   | Vitest run (single pass).                      |
| `npm run -w @luvora/web preview`     | Serve the production build locally.            |
| `npm run -w @luvora/web test:watch`  | Vitest in watch mode.                          |

The aggregate root scripts (`npm run build`, `npm run typecheck`, `npm run
test`) build/check/test the backend **and** this web app.

## Auth & session behavior

- **Access token** is kept **in memory only** (never persisted) to minimize
  exposure.
- **Refresh token** is persisted in `localStorage` (there is no httpOnly-cookie
  flow in this backend; refresh tokens are opaque, and only their hash is stored
  server-side). On reload the app re-establishes the session from it.
- The `ApiClient` transparently **refreshes once and retries** on a `401`, with
  concurrent 401s de-duplicated to a single refresh. If refresh fails the
  session is treated as lost and the router sends the user to `/login`.
- Protected routes show a spinner while the session bootstraps (they never flash
  the login screen), redirect unauthenticated users to `/login`, and preserve
  the intended path for post-login return.

## Realtime (WebSocket)

- A **single** `/ws/chat` connection is opened while authenticated. The browser
  can't set WebSocket headers, so the access token is passed as the
  `?access_token=` query parameter.
- The connection reconnects with **bounded exponential backoff**. It is a
  transport only: it holds no messaging state machine — the server stays
  authoritative. Incoming `message.created` / `message.read` events update the
  inbox unread badges and the open conversation live.

## Security posture

- No secrets are referenced in the bundle — only `VITE_` public config.
- The token store key is an internal detail; the UI never renders a raw storage
  key, and photo references expose only media ids + authenticated application
  URLs (never raw storage keys).
- Protected media (`/api/media/:id/content`) requires an `Authorization` header,
  which browsers don't send on `<img src>`. `AuthedImage` fetches the bytes with
  auth, renders a blob object URL, and revokes it on unmount.
- Message bodies are rendered as **text** (React escapes by default) — no
  `dangerouslySetInnerHTML` — so hostile message content cannot inject markup.
- WebSocket events are filtered by conversation id before rendering, so one
  conversation never shows another's messages.
- **Messaging has no optimistic insert**: only server-confirmed messages are
  rendered, and sends carry a `clientMessageId` for idempotency.
- All authorization is enforced by the backend; the UI only reflects what the
  API returns.

## Deployment

The app is a static SPA. `npm run build:web` emits `apps/web/dist` (hashed
assets + `index.html`). Serve that directory from any static host/CDN with an
SPA fallback (all unknown routes → `index.html`).

- Externalize `VITE_API_BASE_URL` / `VITE_WS_BASE_URL` at **build time** for the
  target environment (they are inlined into the bundle by Vite). No `localhost`
  values are hardcoded in source.
- For a same-origin deployment, serve the built assets behind the same
  origin/reverse proxy as the API and leave the API base empty.
- Ensure the backend's `CORS_ALLOWED_ORIGINS` includes the frontend origin for
  any cross-origin deployment.

## Scope boundary (MVP)

In scope: the end-to-end journey above. **Out of scope** for this increment:
push notifications, presence, Android, moderation UI, account deletion/password
change, discovery filters, new caching, and new DB schema.
