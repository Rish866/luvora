import { ErrorCodes, type ErrorCode } from "@luvora/shared";

/**
 * Application errors carry a stable machine code + safe user-facing message.
 * They never embed stack traces or DB internals — the error handler guarantees
 * that nothing beyond `code` and `message` reaches the client (§52).
 */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  validation: (message = "Invalid request.", details?: unknown) =>
    new AppError(ErrorCodes.VALIDATION_ERROR, 400, message, details),
  unauthenticated: (message = "Authentication required.") =>
    new AppError(ErrorCodes.UNAUTHENTICATED, 401, message),
  unauthorized: (message = "You are not authorized to perform this action.") =>
    new AppError(ErrorCodes.UNAUTHORIZED, 403, message),
  notFound: (message = "Resource not found.") =>
    new AppError(ErrorCodes.NOT_FOUND, 404, message),
  conflict: (message = "Conflict.") =>
    new AppError(ErrorCodes.CONFLICT, 409, message),
  rateLimited: (message = "Too many requests.") =>
    new AppError(ErrorCodes.RATE_LIMITED, 429, message),
  ageRestricted: (message = "You must be at least 18 years old.") =>
    new AppError(ErrorCodes.AGE_RESTRICTED, 403, message),
  sessionNotAuthorized: (message = "You are not authorized to access this session.") =>
    new AppError(ErrorCodes.SESSION_NOT_AUTHORIZED, 403, message),
  invalidTransition: (message = "Invalid state transition.") =>
    new AppError(ErrorCodes.INVALID_STATE_TRANSITION, 409, message),

  // ---- Discovery & matching (Increment 2) ----
  userNotFound: (message = "User not found.") =>
    new AppError(ErrorCodes.USER_NOT_FOUND, 404, message),
  cannotInteractWithSelf: (message = "You cannot perform this action on yourself.") =>
    new AppError(ErrorCodes.CANNOT_INTERACT_WITH_SELF, 400, message),
  /** Deliberately generic: used for blocked-either-direction and other
   *  unavailable interactions, so we never reveal that the other party blocked
   *  the caller. */
  interactionNotAllowed: (message = "This interaction is not available.") =>
    new AppError(ErrorCodes.INTERACTION_NOT_ALLOWED, 403, message),
  matchNotFound: (message = "Match not found.") =>
    new AppError(ErrorCodes.MATCH_NOT_FOUND, 404, message),
  matchNotAuthorized: (message = "You are not authorized to access this match.") =>
    new AppError(ErrorCodes.MATCH_NOT_AUTHORIZED, 403, message),

  // ---- Chat (Increment 3) ----
  conversationNotFound: (message = "Conversation not found.") =>
    new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, 404, message),
  /** Generic chat authorization failure — used for non-participants AND for
   *  blocked relationships, so we never reveal who blocked whom. */
  chatNotAuthorized: (message = "You are not authorized to use this conversation.") =>
    new AppError(ErrorCodes.CHAT_NOT_AUTHORIZED, 403, message),
  matchNotActive: (message = "This match is not active.") =>
    new AppError(ErrorCodes.MATCH_NOT_ACTIVE, 409, message),
  messageTooLong: (message = `Message exceeds the ${4000}-character limit.`) =>
    new AppError(ErrorCodes.MESSAGE_TOO_LONG, 400, message),
  messageEmpty: (message = "Message cannot be empty.") =>
    new AppError(ErrorCodes.MESSAGE_EMPTY, 400, message),
  invalidCursor: (message = "Invalid pagination cursor.") =>
    new AppError(ErrorCodes.INVALID_CURSOR, 400, message),
  invalidWebSocketMessage: (message = "Invalid WebSocket message.") =>
    new AppError(ErrorCodes.INVALID_WEBSOCKET_MESSAGE, 400, message),

  internal: (message = "An unexpected error occurred.") =>
    new AppError(ErrorCodes.INTERNAL, 500, message),
};
