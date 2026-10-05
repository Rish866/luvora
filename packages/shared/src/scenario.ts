/**
 * Scenario library + gameplay shared types (Increment 4).
 *
 * These describe the data-driven fantasy engine's public contracts. Scenario
 * CONTENT is data, not code; the server is authoritative for all gameplay
 * state. Clients submit intent (a choice key / id), never state.
 */

export enum ScenarioStatus {
  DRAFT = "DRAFT",
  PUBLISHED = "PUBLISHED",
  ARCHIVED = "ARCHIVED",
}

export enum ScenarioNodeType {
  START = "START",
  NARRATIVE = "NARRATIVE",
  CHOICE = "CHOICE",
  ENDING = "ENDING",
}

/** Public, library-safe view of a published scenario. Never exposes drafts or
 *  internal authoring metadata. */
export interface ScenarioSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  coverImageUrl: string | null;
  tags: string[];
  estimatedMinutes: number | null;
}

/** A choice as presented to a player for the current node. `available`
 *  reflects whether the choice is permitted under the *mutual* consent
 *  allow-list — it NEVER exposes the partner's individual responses. */
export interface GameChoiceView {
  id: string;
  key: string;
  label: string;
  description: string;
  /** True iff every required consent category is in the mutual allow-list. */
  available: boolean;
  /** The consent categories this choice requires (public, non-sensitive). */
  requires: string[];
}

/** A node as presented to a player. Contains only the current node — never the
 *  whole graph, next-node ids, or other branches. */
export interface GameNodeView {
  id: string;
  key: string;
  type: ScenarioNodeType;
  title: string;
  content: string;
  choices: GameChoiceView[];
  /** True when this node is an ENDING. */
  isEnding: boolean;
}

/** Full authoritative gameplay state returned by the server (e.g. on
 *  start / after a choice / on reconnect). */
export interface GameStateView {
  sessionId: string;
  sessionState: string; // SessionState value
  scenarioVersionId: string;
  turnNumber: number;
  stateVersion: number;
  completed: boolean;
  node: GameNodeView | null;
}

// ---------------------------------------------------------------------------
// Gameplay WebSocket protocol (channel: /ws/game)
// ---------------------------------------------------------------------------

/** Client -> server game events. */
export interface GameSubscribeEvent {
  type: "game.subscribe";
  sessionId: string;
}
export interface GameChooseEvent {
  type: "game.choose";
  sessionId: string;
  choiceId: string;
  clientActionId: string;
}

export type ClientGameEvent = GameSubscribeEvent | GameChooseEvent;
export type ClientGameEventType = ClientGameEvent["type"];

/** Server -> client game events. */
export interface GameReadyServerEvent {
  type: "game.ready";
  userId: string;
}
export interface GameStateServerEvent {
  type: "game.state";
  state: GameStateView;
}
export interface GameStateChangedServerEvent {
  type: "game.state.changed";
  state: GameStateView;
}
export interface GameCompletedServerEvent {
  type: "game.completed";
  state: GameStateView;
}
export interface GameErrorServerEvent {
  type: "game.error";
  code: string;
  message: string;
  clientActionId?: string;
}

export type ServerGameEvent =
  | GameReadyServerEvent
  | GameStateServerEvent
  | GameStateChangedServerEvent
  | GameCompletedServerEvent
  | GameErrorServerEvent;
export type ServerGameEventType = ServerGameEvent["type"];
