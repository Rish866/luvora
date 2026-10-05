import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@luvora/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Global setup: initializes the distributed abuse backend when configured
    // (ABUSE_BACKEND=redis) so the real app path is exercised over Redis.
    setupFiles: ["test/setup.ts"],
    // Integration tests share one Postgres database and TRUNCATE between tests,
    // so they must not run in parallel across files.
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
