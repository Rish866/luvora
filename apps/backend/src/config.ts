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

  // Comma-separated explicit CORS allowlist. `CORS_ALLOWED_ORIGINS` is the
  // Increment-11 name; `CORS_ORIGINS` is accepted as a legacy alias.
  CORS_ORIGINS: z.string().default(""),
  CORS_ALLOWED_ORIGINS: z.string().default(""),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // ---- Security hardening (Increment 11) ----
  // Number of proxy hops to trust for client-IP derivation. 0 = trust none
  // (use the socket address; headers like X-Forwarded-For are NOT trusted).
  // Set to the real hop count ONLY when behind a trusted proxy/LB.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  // Master switch for abuse-control throttling (login/report/device/etc.).
  // Independent of the legacy express-rate-limit `rateLimitEnabled`, so the
  // test suite CAN exercise throttling deterministically.
  ABUSE_GUARD_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  // Failed-login throttle: after this many failures (per IP and per account)
  // within the window, further attempts are throttled.
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).max(1000).default(10),
  LOGIN_FAILURE_WINDOW_SECONDS: z.coerce.number().int().min(10).max(86_400).default(900),
  LOGIN_THROTTLE_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),
  // Max distinct abuse-guard keys held in memory (bounded; LRU-evicted).
  ABUSE_GUARD_MAX_KEYS: z.coerce.number().int().min(1000).max(5_000_000).default(100_000),
  // Request-input hard limits.
  JSON_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
  MAX_URL_LENGTH: z.coerce.number().int().min(256).max(16_384).default(2048),
  // HTTP security headers.
  HSTS_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  HSTS_MAX_AGE_SECONDS: z.coerce.number().int().min(0).max(63_072_000).default(15_552_000),
  // WebSocket limits.
  WS_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().min(1).max(1000).default(10),
  WS_MAX_FRAME_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(65_536),
  WS_EVENT_WINDOW_MS: z.coerce.number().int().min(100).max(600_000).default(10_000),
  WS_EVENT_MAX: z.coerce.number().int().min(1).max(100_000).default(50),
  // Media pixel-count cap (width*height) — decompression-bomb defence, in
  // addition to byte + per-dimension bounds.
  MEDIA_MAX_PIXELS: z.coerce.number().int().min(1_000).max(500_000_000).default(50_000_000),

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

  // ---- Observability & operations (Increment 10) ----
  // Minimum log level for the structured logger. Overridden to 'silent' under
  // test so the suite stays quiet. Accepts any case (normalized to lowercase);
  // an unrecognized value falls back to 'info' rather than failing startup.
  LOG_LEVEL: z
    .string()
    .default("info")
    .transform((v) => v.trim().toLowerCase())
    .transform((v) =>
      ["debug", "info", "warn", "error", "silent"].includes(v) ? v : "info",
    ),
  // Metrics endpoint controls. Disabled => /metrics returns 404. When auth is
  // required, an ADMIN access token is needed (safe default: enabled + auth).
  METRICS_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  METRICS_REQUIRE_AUTH: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  // Timeouts for the DB probe used by health/readiness (ms).
  HEALTH_DB_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
  READINESS_DB_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
  // Queue-pressure thresholds (claimable depth / oldest pending age seconds).
  JOB_QUEUE_WARNING_DEPTH: z.coerce.number().int().min(0).default(100),
  JOB_QUEUE_CRITICAL_DEPTH: z.coerce.number().int().min(0).default(1000),
  JOB_QUEUE_MAX_AGE_SECONDS: z.coerce.number().int().min(1).default(300),
  // Worker is considered UNHEALTHY if it was enabled but hasn't polled within
  // this window, or after this many consecutive claim-loop errors.
  WORKER_UNHEALTHY_POLL_SECONDS: z.coerce.number().int().min(5).default(120),
  WORKER_UNHEALTHY_ERROR_STREAK: z.coerce.number().int().min(1).default(10),
  // Retention for operational events (days). Audit logs are a SEPARATE policy
  // and are never deleted by this.
  OPERATIONAL_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // Retention for security events (days). Audit logs are a SEPARATE policy and
  // are never deleted by this.
  SECURITY_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
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

// Resolve the explicit CORS allowlist (Increment 11 name wins; legacy alias as
// fallback), normalized (lowercased, trailing-slash-trimmed, deduped).
function normalizeOrigin(o: string): string {
  const t = o.trim();
  if (!t) return "";
  return t.replace(/\/+$/, "").toLowerCase();
}
const corsRaw = env.CORS_ALLOWED_ORIGINS || env.CORS_ORIGINS;
const corsOriginsList = Array.from(
  new Set(corsRaw.split(",").map(normalizeOrigin).filter(Boolean)),
);

/**
 * Production fail-fast (fail CLOSED on insecure config). Beyond the zod schema,
 * production MUST NOT run with development-grade or missing security-critical
 * values. We never print secret VALUES — only names + a safe reason.
 */
if (env.NODE_ENV === "production") {
  const problems: string[] = [];
  const weakSecret = (name: string, v: string): void => {
    if (v.length < 32) problems.push(`${name} must be at least 32 chars in production`);
    if (/change-me|changeme|secret|test|dev|example|placeholder/i.test(v)) {
      problems.push(`${name} looks like a development/example value`);
    }
  };
  weakSecret("JWT_ACCESS_SECRET", env.JWT_ACCESS_SECRET);
  weakSecret("JWT_REFRESH_SECRET", env.JWT_REFRESH_SECRET);
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    problems.push("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ");
  }
  if (env.BCRYPT_ROUNDS < 10) {
    problems.push("BCRYPT_ROUNDS must be >= 10 in production");
  }
  if (corsOriginsList.length === 0) {
    problems.push("CORS_ALLOWED_ORIGINS must be an explicit allowlist in production");
  }
  if (corsOriginsList.includes("*")) {
    problems.push("CORS_ALLOWED_ORIGINS must not contain a wildcard when credentials are allowed");
  }
  if (env.DEVELOPER_MODE) {
    problems.push("DEVELOPER_MODE must be false in production");
  }
  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      "Insecure production configuration (fail-fast):\n - " + problems.join("\n - "),
    );
    throw new Error("Insecure production configuration");
  }
}

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
  // Explicit, normalized CORS allowlist (never a wildcard with credentials).
  corsOrigins: corsOriginsList,
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    authMax: env.AUTH_RATE_LIMIT_MAX,
  },
  // ---- Security hardening (Increment 11) ----
  security: {
    trustProxyHops: env.TRUST_PROXY_HOPS,
    abuseGuardEnabled: env.ABUSE_GUARD_ENABLED,
    abuseGuardMaxKeys: env.ABUSE_GUARD_MAX_KEYS,
    login: {
      maxFailures: env.LOGIN_MAX_FAILURES,
      failureWindowSeconds: env.LOGIN_FAILURE_WINDOW_SECONDS,
      throttleSeconds: env.LOGIN_THROTTLE_SECONDS,
    },
    jsonBodyLimitBytes: env.JSON_BODY_LIMIT_BYTES,
    maxUrlLength: env.MAX_URL_LENGTH,
    hstsEnabled: env.HSTS_ENABLED,
    hstsMaxAgeSeconds: env.HSTS_MAX_AGE_SECONDS,
    ws: {
      maxConnectionsPerUser: env.WS_MAX_CONNECTIONS_PER_USER,
      maxFrameBytes: env.WS_MAX_FRAME_BYTES,
      eventWindowMs: env.WS_EVENT_WINDOW_MS,
      eventMax: env.WS_EVENT_MAX,
    },
  },
  developerMode: env.DEVELOPER_MODE && env.NODE_ENV !== "production",
  // Rate limiting is disabled under test so the suite can register many users
  // against a single app instance. It is always enabled otherwise.
  rateLimitEnabled: env.NODE_ENV !== "test",
  media: {
    maxBytes: env.MEDIA_MAX_BYTES,
    maxWidth: env.MEDIA_MAX_WIDTH,
    maxHeight: env.MEDIA_MAX_HEIGHT,
    maxPixels: env.MEDIA_MAX_PIXELS,
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
    queueWarningDepth: env.JOB_QUEUE_WARNING_DEPTH,
    queueCriticalDepth: env.JOB_QUEUE_CRITICAL_DEPTH,
    queueMaxAgeSeconds: env.JOB_QUEUE_MAX_AGE_SECONDS,
    workerUnhealthyPollSeconds: env.WORKER_UNHEALTHY_POLL_SECONDS,
    workerUnhealthyErrorStreak: env.WORKER_UNHEALTHY_ERROR_STREAK,
  },
  // ---- Observability & operations (Increment 10) ----
  observability: {
    // Under test the logger is silenced regardless of LOG_LEVEL.
    logLevel: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
    metricsEnabled: env.METRICS_ENABLED,
    metricsRequireAuth: env.METRICS_REQUIRE_AUTH,
    healthDbTimeoutMs: env.HEALTH_DB_TIMEOUT_MS,
    readinessDbTimeoutMs: env.READINESS_DB_TIMEOUT_MS,
    operationalEventRetentionDays: env.OPERATIONAL_EVENT_RETENTION_DAYS,
    securityEventRetentionDays: env.SECURITY_EVENT_RETENTION_DAYS,
  },
} as const;

export type Config = typeof config;
