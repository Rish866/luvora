import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

/**
 * Production fail-fast configuration tests (Increment 11).
 *
 * config.ts validates + fail-CLOSES at MODULE LOAD, so we exercise it the only
 * honest way: import the compiled module in a fresh Node process with a crafted
 * environment and assert on the exit code (and that no secret VALUE is echoed).
 * A clean env is passed (not inherited) so parent test vars never leak in.
 */

const CONFIG_JS = path.resolve(__dirname, "../dist/src/config.js");

// Guard: these tests require the compiled output. `npm run verify`/build
// produces it; skip loudly rather than silently pass if it is missing.
const built = fs.existsSync(CONFIG_JS);

/** Base env that satisfies the zod schema; individual tests mutate it. */
function baseProdEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    // Keep PATH so node can resolve itself; everything else is explicit.
    PATH: process.env.PATH,
    NODE_ENV: "production",
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    JWT_ACCESS_SECRET: "a".repeat(40),
    JWT_REFRESH_SECRET: "b".repeat(40),
    CORS_ALLOWED_ORIGINS: "https://app.example.com",
    BCRYPT_ROUNDS: "12",
    ...overrides,
  };
}

function loadConfig(env: NodeJS.ProcessEnv): { status: number; stderr: string } {
  const res = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(CONFIG_JS)})`], {
    env,
    encoding: "utf8",
  });
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

describe.skipIf(!built)("config: production fail-fast", () => {
  it("boots with a secure production configuration", () => {
    const { status } = loadConfig(baseProdEnv());
    expect(status).toBe(0);
  });

  it("refuses a short JWT access secret", () => {
    const { status, stderr } = loadConfig(baseProdEnv({ JWT_ACCESS_SECRET: "short-but-16chars" }));
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET/);
    // Never echoes the secret VALUE.
    expect(stderr).not.toContain("short-but-16chars");
  });

  it("refuses a development-looking JWT secret", () => {
    const { status, stderr } = loadConfig(
      baseProdEnv({ JWT_ACCESS_SECRET: "change-me-change-me-change-me-change-me" }),
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/JWT_ACCESS_SECRET/);
    expect(stderr).not.toContain("change-me-change-me-change-me-change-me");
  });

  it("refuses equal access and refresh secrets", () => {
    const same = "z".repeat(40);
    const { status, stderr } = loadConfig(
      baseProdEnv({ JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same }),
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/must differ/i);
  });

  it("refuses weak bcrypt rounds in production", () => {
    const { status, stderr } = loadConfig(baseProdEnv({ BCRYPT_ROUNDS: "6" }));
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/BCRYPT_ROUNDS/);
  });

  it("refuses an empty CORS allowlist in production", () => {
    const { status, stderr } = loadConfig(baseProdEnv({ CORS_ALLOWED_ORIGINS: "" }));
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/CORS_ALLOWED_ORIGINS/);
  });

  it("refuses a wildcard CORS origin with credentials in production", () => {
    const { status, stderr } = loadConfig(baseProdEnv({ CORS_ALLOWED_ORIGINS: "*" }));
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/wildcard/i);
  });

  it("refuses DEVELOPER_MODE=true in production", () => {
    const { status, stderr } = loadConfig(baseProdEnv({ DEVELOPER_MODE: "true" }));
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/DEVELOPER_MODE/);
  });

  it("accepts the legacy CORS_ORIGINS alias", () => {
    const { status } = loadConfig(
      baseProdEnv({ CORS_ALLOWED_ORIGINS: "", CORS_ORIGINS: "https://app.example.com" }),
    );
    expect(status).toBe(0);
  });

  it("does NOT fail-fast outside production even with weak values", () => {
    const { status } = loadConfig({
      PATH: process.env.PATH,
      NODE_ENV: "development",
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      JWT_ACCESS_SECRET: "dev-access-secret-16",
      JWT_REFRESH_SECRET: "dev-refresh-secret-16",
    });
    expect(status).toBe(0);
  });
});
