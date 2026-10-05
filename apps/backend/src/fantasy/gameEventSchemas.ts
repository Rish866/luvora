import { z } from "zod";

/** Inbound (client → server) gameplay WebSocket event schemas. Every frame is
 *  validated before any action; invalid frames yield a structured error. */

const gameSubscribe = z.object({
  type: z.literal("game.subscribe"),
  sessionId: z.string().uuid(),
});

const gameChoose = z.object({
  type: z.literal("game.choose"),
  sessionId: z.string().uuid(),
  choiceId: z.string().uuid(),
  clientActionId: z.string().uuid(),
});

export const clientGameEventSchema = z.discriminatedUnion("type", [
  gameSubscribe,
  gameChoose,
]);

export type ParsedClientGameEvent = z.infer<typeof clientGameEventSchema>;
