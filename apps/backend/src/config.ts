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

  // ---- Notification delivery + presence (Increment 8) ----
  // Push delivery master switch. When false, the DisabledPushProvider is used
  // (no external delivery); in-app notifications + WebSocket are unaffected.
  NOTIFICATION_PUSH_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // Which provider to use when push is enabled. 'test' is the deterministic
  // in-process provider; 'fcm'/'apns' are placeholders requiring real SDKs +
  // credentials (they fail safely until implemented); 'disabled' never delivers.
  PUSH_PROVIDER: z.enum(["disabled", "test", "fcm", "apns"]).default("disabled"),
  // Presence backend selection. 'local' is process-local (default). 'distributed'
  // is an architectural placeholder (requires a shared store such as Redis).
  PRESENCE_BACKEND: z.enum(["local", "distributed"]).default("local"),
  // Realtime event bus. 'local' is an in-process emitter (default). 'distributed'
  // is a placeholder for a cross-instance bus (e.g. Redis pub/sub).
  REALTIME_BUS: z.enum(["local", "distributed"]).default("local"),
  // Presence heartbeat/TTL (seconds). A connection refreshes its TTL on each
  // heartbeat; if no heartbeat arrives within the TTL the entry is considered
  // stale and the user may be treated as OFFLINE even without a clean disconnect.
  PRESENCE_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(30),
  PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(90),
  // Optional provider credentials (never committed; empty = not configured).
  FCM_PROJECT_ID: z.string().default(""),
  FCM_CREDENTIALS_JSON: z.string().default(""),
  APNS_KEY_ID: z.string().default(""),
  APNS_TEAM_ID: z.string().default(""),
  APNS_PRIVATE_KEY: z.string().default(""),
  // Optional Redis URL for a future distributed presence/bus (empty = local).
  REDIS_URL: z.string().default(""),
  // Device registration rate limit (per IP window).
  DEVICE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

  // ---- Background jobs + worker (Increment 9) ----
  // Whether THIS process runs the embedded worker loop. The API server does not
  // require a worker; `npm run worker` runs a dedicated worker process.
  JOB_WORKER_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  JOB_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(500),
  JOB_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  JOB_LEASE_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(1800).default(20),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
  JOB_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).max(600_000).default(1000),
  JOB_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).max(3_600_000).default(60_000),
  JOB_RETRY_JITTER: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  JOB_RECLAIM_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  JOB_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(15_000),
  JOB_SUCCESS_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  JOB_DEAD_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  // Safety valve: refuse to enqueue if the queue is this deep (0 = unbounded).
  JOB_MAX_QUEUE_DEPTH: z.coerce.number().int().min(0).default(0),
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
  // ---- Notification delivery + presence (Increment 8) ----
  notifications: {
    pushEnabled: env.NOTIFICATION_PUSH_ENABLED,
    // When push is disabled globally, force the disabled provider regardless of
    // PUSH_PROVIDER so no accidental delivery can occur.
    pushProvider: env.NOTIFICATION_PUSH_ENABLED ? env.PUSH_PROVIDER : "disabled",
    deviceRateLimitMax: env.DEVICE_RATE_LIMIT_MAX,
    fcm: {
      // "configured" only when BOTH a project id and credentials are present.
      configured: env.FCM_PROJECT_ID.length > 0 && env.FCM_CREDENTIALS_JSON.length > 0,
    },
    apns: {
      configured:
        env.APNS_KEY_ID.length > 0 &&
        env.APNS_TEAM_ID.length > 0 &&
        env.APNS_PRIVATE_KEY.length > 0,
    },
  },
  presence: {
    backend: env.PRESENCE_BACKEND,
    heartbeatSeconds: env.PRESENCE_HEARTBEAT_SECONDS,
    ttlSeconds: env.PRESENCE_TTL_SECONDS,
    redisUrl: env.REDIS_URL,
  },
  realtime: {
    bus: env.REALTIME_BUS,
    redisUrl: env.REDIS_URL,
  },
  jobs: {
    workerEnabled: env.JOB_WORKER_ENABLED,
    concurrency: env.JOB_WORKER_CONCURRENCY,
    pollIntervalMs: env.JOB_POLL_INTERVAL_MS,
    leaseSeconds: env.JOB_LEASE_SECONDS,
    leaseHeartbeatSeconds: env.JOB_LEASE_HEARTBEAT_SECONDS,
    maxAttempts: env.JOB_MAX_ATTEMPTS,
    retryBaseDelayMs: env.JOB_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: env.JOB_RETRY_MAX_DELAY_MS,
    retryJitter: env.JOB_RETRY_JITTER,
    reclaimIntervalSeconds: env.JOB_RECLAIM_INTERVAL_SECONDS,
    shutdownGraceMs: env.JOB_SHUTDOWN_GRACE_MS,
    successRetentionDays: env.JOB_SUCCESS_RETENTION_DAYS,
    deadRetentionDays: env.JOB_DEAD_RETENTION_DAYS,
    maxQueueDepth: env.JOB_MAX_QUEUE_DEPTH,
  },
} as const;

export type Config = typeof config;
