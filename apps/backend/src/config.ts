import { config as loadEnv } from "dotenv";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";

/**
 * Centralised, validated configuration. Fails fast on startup if required
 * values are missing or malformed, so misconfiguration never reaches runtime.
 */

// Load the env file matching NODE_ENV, falling back to .env. Does not override
// variables already present in the process environment (e.g. in CI).
const nodeEnv = process.env.NODE_ENV ?? "development";
for (const candidate of [`.env.${nodeEnv}`, ".env"]) {
  const full = path.resolve(process.cwd(), candidate);
  if (fs.existsSync(full)) {
    loadEnv({ path: full });
    break;
  }
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET too short"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET too short"),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  CORS_ORIGINS: z.string().default(""),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  DEVELOPER_MODE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  // ---- Media (Increment 5) ----
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MEDIA_MAX_WIDTH: z.coerce.number().int().positive().default(8000),
  MEDIA_MAX_HEIGHT: z.coerce.number().int().positive().default(8000),
  MEDIA_MAX_ATTACHMENTS_PER_MESSAGE: z.coerce.number().int().positive().default(5),
  MEDIA_MAX_TOTAL_MESSAGE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  MEDIA_THUMBNAIL_SIZE: z.coerce.number().int().positive().default(320),
  MEDIA_STORAGE_PROVIDER: z.enum(["local"]).default("local"),
  // Where the local storage provider writes bytes. Defaults to an OS temp dir
  // per-process when empty, so tests never require config.
  MEDIA_LOCAL_STORAGE_PATH: z.string().default(""),
  // Scanner / moderation behaviour. 'test' uses deterministic dev providers.
  MEDIA_SCAN_MODE: z.enum(["test", "disabled"]).default("test"),
  MEDIA_MODERATION_MODE: z.enum(["test", "disabled"]).default("test"),
  // Policy when the scanner returns UNKNOWN: 'quarantine' (safe) or 'allow'.
  MEDIA_UNKNOWN_SCAN_POLICY: z.enum(["quarantine", "allow"]).default("quarantine"),
  MEDIA_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    "Invalid environment configuration:\n" +
      JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  throw new Error("Configuration validation failed");
}

const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
  },
  bcryptRounds: env.BCRYPT_ROUNDS,
  corsOrigins: env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    authMax: env.AUTH_RATE_LIMIT_MAX,
  },
  developerMode: env.DEVELOPER_MODE && env.NODE_ENV !== "production",
  // Rate limiting is disabled under test so the suite can register many users
  // against a single app instance. It is always enabled otherwise.
  rateLimitEnabled: env.NODE_ENV !== "test",
  media: {
    maxBytes: env.MEDIA_MAX_BYTES,
    maxWidth: env.MEDIA_MAX_WIDTH,
    maxHeight: env.MEDIA_MAX_HEIGHT,
    maxAttachmentsPerMessage: env.MEDIA_MAX_ATTACHMENTS_PER_MESSAGE,
    maxTotalMessageBytes: env.MEDIA_MAX_TOTAL_MESSAGE_BYTES,
    thumbnailSize: env.MEDIA_THUMBNAIL_SIZE,
    storageProvider: env.MEDIA_STORAGE_PROVIDER,
    localStoragePath: env.MEDIA_LOCAL_STORAGE_PATH,
    scanMode: env.MEDIA_SCAN_MODE,
    moderationMode: env.MEDIA_MODERATION_MODE,
    unknownScanPolicy: env.MEDIA_UNKNOWN_SCAN_POLICY,
    signedUrlTtlSeconds: env.MEDIA_SIGNED_URL_TTL_SECONDS,
  },
} as const;

export type Config = typeof config;
