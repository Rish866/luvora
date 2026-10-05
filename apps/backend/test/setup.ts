import { beforeAll } from "vitest";
import { config } from "../src/config";
import { initAbuseBackend } from "../src/http/abuseInit";

/**
 * Per-file test setup (vitest runs setupFiles once per test file). When the
 * suite is run with the distributed abuse backend (`npm run verify:redis` sets
 * ABUSE_BACKEND=redis), initialise it so the real app path (readiness probe,
 * login throttle) exercises Redis end-to-end — mirroring server.ts at startup.
 *
 * `initAbuseBackend` is idempotent: it installs the Redis backend on the shared
 * guard singleton and reuses the one cached ioredis connection, so running it
 * once per file is safe and cheap. We deliberately do NOT close the connection
 * between files — the ephemeral Redis + process teardown handles cleanup — so a
 * later file's readiness check never races a premature disconnect. With the
 * default memory backend this is a no-op.
 */
beforeAll(async () => {
  if (config.security.abuse.backend === "redis") {
    await initAbuseBackend();
  }
});
