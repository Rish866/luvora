/**
 * Notification delivery + device registration shared types (Increment 8).
 *
 * PostgreSQL notifications remain authoritative (Increment 7). This module adds
 * the contracts for OUT-OF-BAND delivery channels: a registered push device and
 * the per-device delivery record. Push delivery is best-effort — a notification
 * is never rolled back because a device/provider was unavailable.
 *
 * IMPORTANT: raw push tokens are credentials. They are NEVER part of any DTO
 * returned to a client; only safe metadata (platform, provider, a short
 * non-reversible fingerprint, timestamps, revoked state) is exposed.
 */

/** Device platforms a push token may belong to. */
export enum DevicePlatform {
  WEB = "WEB",
  ANDROID = "ANDROID",
  IOS = "IOS",
}

/** Push providers the delivery abstraction knows about. Only the test/disabled
 *  providers are actually implemented end-to-end; FCM/APNS/WEB_PUSH are
 *  architectural placeholders behind the PushProvider interface and require
 *  real SDK + credentials to deliver (see docs/SECURITY.md). */
export enum PushProviderKind {
  FCM = "FCM",
  APNS = "APNS",
  WEB_PUSH = "WEB_PUSH",
  /** Deterministic in-process provider for tests/dev — no external network. */
  TEST = "TEST",
  /** Explicitly performs no delivery; the safe default. */
  DISABLED = "DISABLED",
}

/** Which real provider each platform expects in production. */
export const PLATFORM_DEFAULT_PROVIDER: Record<DevicePlatform, PushProviderKind> = {
  [DevicePlatform.WEB]: PushProviderKind.WEB_PUSH,
  [DevicePlatform.ANDROID]: PushProviderKind.FCM,
  [DevicePlatform.IOS]: PushProviderKind.APNS,
};

/** Lifecycle status of a single (notification, device, channel) delivery. */
export enum DeliveryStatus {
  /** Created, not yet dispatched. */
  PENDING = "PENDING",
  /** Handed to a provider; awaiting result. */
  SENT = "SENT",
  /** Provider accepted it. */
  DELIVERED = "DELIVERED",
  /** Temporary failure; eligible for a bounded retry. */
  FAILED = "FAILED",
  /** Permanent failure (invalid/unregistered token); device revoked, no retry. */
  REVOKED = "REVOKED",
}

/** Delivery channels. REALTIME = WebSocket (Increment 7); PUSH = out-of-band. */
export enum DeliveryChannel {
  REALTIME = "REALTIME",
  PUSH = "PUSH",
}

/** Safe, client-facing device DTO. NEVER contains the raw push token. */
export interface NotificationDeviceView {
  id: string;
  platform: DevicePlatform;
  provider: PushProviderKind;
  /** A short non-reversible fingerprint (first bytes of a SHA-256) for the
   *  user to recognise a device without exposing the token. */
  tokenFingerprint: string;
  label: string | null;
  active: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/** Admin/diagnostic delivery view — still NEVER exposes the raw token. */
export interface NotificationDeliveryView {
  id: string;
  notificationId: string;
  deviceId: string | null;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  attemptCount: number;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

/** Request to register a device. `userId` is NEVER taken from the body — the
 *  authenticated caller always owns the registration. */
export interface RegisterDeviceRequest {
  platform: DevicePlatform;
  provider: PushProviderKind;
  token: string;
  label?: string | null;
}

/** Bounded retry policy for temporary provider failures. */
export const PUSH_MAX_DELIVERY_ATTEMPTS = 5;

/** How a provider classifies a send failure. */
export enum PushFailureKind {
  /** Invalid/unregistered token — revoke the device, never retry. */
  PERMANENT = "PERMANENT",
  /** Timeout / provider unavailable / throttled — bounded retry. */
  TEMPORARY = "TEMPORARY",
}

/** Minimal, privacy-safe push payload. Carries only opaque references the
 *  recipient re-resolves through authenticated APIs — never message bodies,
 *  consent answers, media keys, moderation internals, or tokens. */
export interface PushPayload {
  type: string;
  notificationId: string;
  category: string;
  entityType: string | null;
  entityId: string | null;
}
