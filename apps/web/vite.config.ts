import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Vite + Vitest config for the Luvora web frontend.
 *
 * The `@luvora/shared` alias points at the package SOURCE (TypeScript) rather
 * than its CommonJS `dist` build, so the browser bundle gets tree-shakeable ESM
 * types/values and we never bundle CJS. This mirrors how the backend's vitest
 * config aliases the same package.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@luvora/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    css: false,
  },
});
