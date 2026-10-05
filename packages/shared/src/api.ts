/** Standard API response envelope. Errors never leak internals (see §52). */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: ApiError;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Well-known error codes shared with clients. */
export const ErrorCodes = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  AGE_RESTRICTED: "AGE_RESTRICTED",
  SESSION_NOT_AUTHORIZED: "SESSION_NOT_AUTHORIZED",
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  // Discovery & matching (Increment 2).
  USER_NOT_FOUND: "USER_NOT_FOUND",
  CANNOT_INTERACT_WITH_SELF: "CANNOT_INTERACT_WITH_SELF",
  INTERACTION_NOT_ALLOWED: "INTERACTION_NOT_ALLOWED",
  MATCH_NOT_FOUND: "MATCH_NOT_FOUND",
  MATCH_NOT_AUTHORIZED: "MATCH_NOT_AUTHORIZED",
  // Chat (Increment 3).
  CONVERSATION_NOT_FOUND: "CONVERSATION_NOT_FOUND",
  CHAT_NOT_AUTHORIZED: "CHAT_NOT_AUTHORIZED",
  MATCH_NOT_ACTIVE: "MATCH_NOT_ACTIVE",
  MESSAGE_TOO_LONG: "MESSAGE_TOO_LONG",
  MESSAGE_EMPTY: "MESSAGE_EMPTY",
  INVALID_CURSOR: "INVALID_CURSOR",
  INVALID_WEBSOCKET_MESSAGE: "INVALID_WEBSOCKET_MESSAGE",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
