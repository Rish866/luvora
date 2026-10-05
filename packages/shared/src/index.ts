/**
 * Shared domain types for the Luvora platform.
 *
 * These are the single source of truth for enums and contracts shared between
 * the backend, the mobile client, and the admin dashboard. Keeping the state
 * machines and consent vocabulary here prevents client/server drift — which is
 * a safety concern, not just a convenience, because consent and session state
 * are enforced server-side against exactly these values.
 */

export * from "./enums";
export * from "./consent";
export * from "./api";
export * from "./stateMachine";
export * from "./profile";
export * from "./discovery";
export * from "./media";
export * from "./chat";
export * from "./scenario";
export * from "./admin";
export * from "./notifications";
export * from "./delivery";
export * from "./jobs";
export * from "./observability";
export * from "./security";
