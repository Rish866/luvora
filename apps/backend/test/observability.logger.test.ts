import { describe, it, expect } from "vitest";
import pino from "pino";
import { serializeError, sanitizeFields } from "../src/observability/logger";

/**
 * Structured logging tests (Increment 10): safe error serialization and that
 * sensitive values never make it into log fields. We also prove the chosen pino
 * configuration (same redact paths as src/logger.ts) censors secrets, by
 * capturing output from a pino logger writing to an in-memory stream.
 */

describe("serializeError", () => {
  it("serializes an Error to a bounded name + message (no raw object)", () => {
    const err = new Error("boom happened");
    const out = serializeError(err);
    expect(out.errorName).toBe("Error");
    expect(out.errorMessage).toBe("boom happened");
  });

  it("strips newlines and bounds the message length", () => {
    const err = new Error("line1\nline2" + "x".repeat(500));
    const out = serializeError(err);
    expect(out.errorMessage).not.toContain("\n");
    expect(out.errorMessage.length).toBeLessThanOrEqual(300);
  });

  it("handles non-Error values safely", () => {
    const out = serializeError("just a string");
    expect(out.errorName).toBe("UnknownError");
    expect(out.errorMessage).toContain("just a string");
  });
});

describe("sanitizeFields", () => {
  it("drops sensitive keys from log fields", () => {
    const out = sanitizeFields({
      userId: "u1",
      password: "secret",
      access_token: "jwt",
      pushToken: "device-token",
      authorization: "Bearer x",
      message_body: "hello world",
      consent: "YES",
      storageKey: "media/abc",
      safe: 42,
    });
    expect(out.userId).toBe("u1");
    expect(out.safe).toBe(42);
    expect(out.password).toBeUndefined();
    expect(out.access_token).toBeUndefined();
    expect(out.pushToken).toBeUndefined();
    expect(out.authorization).toBeUndefined();
    expect(out.message_body).toBeUndefined();
    expect(out.consent).toBeUndefined();
    expect(out.storageKey).toBeUndefined();
  });

  it("serializes a raw Error passed as a field instead of logging the object", () => {
    const out = sanitizeFields({ err: new Error("explode") });
    expect(out.err).toBeUndefined();
    expect(out.errorName).toBe("Error");
    expect(out.errorMessage).toBe("explode");
  });
});

describe("pino redaction (defense in depth)", () => {
  it("censors auth headers / password / token fields in emitted JSON", () => {
    const chunks: string[] = [];
    const stream = {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    };
    // Mirror the production redact config from src/logger.ts.
    const testLogger = pino(
      {
        level: "info",
        base: undefined,
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "password",
            "passwordHash",
            "*.password",
            "*.passwordHash",
            "token",
            "refreshToken",
          ],
          censor: "[redacted]",
        },
      },
      stream as unknown as NodeJS.WritableStream,
    );
    testLogger.info({ password: "hunter2", token: "jwt-abc", userId: "u1" }, "x");
    const out = chunks.join("");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("jwt-abc");
    expect(out).toContain("u1");
  });
});
