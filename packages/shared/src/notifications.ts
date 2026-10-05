/**
 * Notifications + presence shared types (Increment 7).
 *
 * Notifications are PostgreSQL-backed and authoritative; the WebSocket
 * `notification.created` event is a real-time optimization carrying the same
 * safe DTO. Presence is process-local; the `presence.changed` event and the
 * presence API expose only ONLINE/OFFLINE + last-seen to authorized observers.
 */

export enum NotificationType {
  MATCH_CREATED = "MATCH_CREATED",
  MESSAGE_RECEIVED = "MESSAGE_RECEIVED",
  FANTASY_INVITE = "FANTASY_INVITE",
  FANTASY_ACCEPTED = "FANTASY_ACCEPTED",
  FANTASY_STARTED = "FANTASY_STARTED",
  FANTASY_COMPLETED = "FANTASY_COMPLETED",
  SESSION_PAUSED = "SESSION_PAUSED",
  SESSION_RESUMED = "SESSION_RESUMED",
  SAFETY_ACTION = "SAFETY_ACTION",
  SYSTEM = "SYSTEM",
}

export enum NotificationCategory {
  MATCHES = "MATCHES",
  MESSAGES = "MESSAGES",
  FANTASY = "FANTASY",
  SYSTEM = "SYSTEM",
  SAFETY = "SAFETY",
}

/** Which category each type belongs to (used for preference checks). */
export const NOTIFICATION_CATEGORY: Record<NotificationType, NotificationCategory> = {
  [NotificationType.MATCH_CREATED]: NotificationCategory.MATCHES,
  [NotificationType.MESSAGE_RECEIVED]: NotificationCategory.MESSAGES,
  [NotificationType.FANTASY_INVITE]: NotificationCategory.FANTASY,
  [NotificationType.FANTASY_ACCEPTED]: NotificationCategory.FANTASY,
  [NotificationType.FANTASY_STARTED]: NotificationCategory.FANTASY,
  [NotificationType.FANTASY_COMPLETED]: NotificationCategory.FANTASY,
  [NotificationType.SESSION_PAUSED]: NotificationCategory.FANTASY,
  [NotificationType.SESSION_RESUMED]: NotificationCategory.FANTASY,
  [NotificationType.SAFETY_ACTION]: NotificationCategory.SAFETY,
  [NotificationType.SYSTEM]: NotificationCategory.SYSTEM,
};

/** Categories a user may NOT disable (critical safety/security). */
export const CRITICAL_CATEGORIES: ReadonlySet<NotificationCategory> = new Set([
  NotificationCategory.SAFETY,
]);

export const ALL_PREFERENCE_CATEGORIES: NotificationCategory[] = [
  NotificationCategory.MATCHES,
  NotificationCategory.MESSAGES,
  NotificationCategory.FANTASY,
  NotificationCategory.SYSTEM,
  NotificationCategory.SAFETY,
];

/** Safe, client-facing notification DTO. Never contains private bodies/PII. */
export interface NotificationView {
  id: string;
  type: NotificationType;
  category: NotificationCategory;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreferenceView {
  category: NotificationCategory;
  /** Whether the in-app notification is created for this category at all. */
  enabled: boolean;
  /** Whether out-of-band PUSH delivery is attempted (distinct from `enabled`;
   *  Increment 8). Disabling push never suppresses the in-app notification. */
  pushEnabled: boolean;
}

// ---- Presence ----

export enum PresenceStatus {
  ONLINE = "ONLINE",
  OFFLINE = "OFFLINE",
}

export interface PresenceView {
  status: PresenceStatus;
  /** Present only when OFFLINE and known. */
  lastSeenAt?: string | null;
}

// ---- WebSocket events (shared by /ws/chat and /ws/game) ----

export interface NotificationCreatedServerEvent {
  type: "notification.created";
  notification: NotificationView;
}

export interface PresenceChangedServerEvent {
  type: "presence.changed";
  userId: string;
  status: PresenceStatus;
  lastSeenAt?: string | null;
}

export type ServerRealtimeEvent =
  | NotificationCreatedServerEvent
  | PresenceChangedServerEvent;

/** Default retention for non-critical notifications (operational cleanup). */
export const NOTIFICATION_DEFAULT_RETENTION_DAYS = 90;
