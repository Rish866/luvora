import { ConsentResponseValue } from "./enums";

/**
 * The catalogue of consent categories presented to both players before a
 * session. All categories are intentionally non-graphic. Each session records a
 * response per category per player.
 *
 * PRIVACY INVARIANT: a player's individual responses (especially NO / MAYBE)
 * are NEVER sent to the other player. The server only ever emits the *resolved*
 * allow-list (categories where BOTH players are compatible).
 */
export interface ConsentCategory {
  key: string;
  label: string;
  description: string;
}

export const CONSENT_CATEGORIES: ConsentCategory[] = [
  { key: "romantic_conversation", label: "Romantic conversation", description: "Warm, affectionate dialogue." },
  { key: "flirting", label: "Flirting", description: "Playful, flirtatious exchanges." },
  { key: "teasing", label: "Teasing", description: "Light, playful teasing." },
  { key: "intense_romance", label: "Intense romance", description: "Emotionally intense (non-graphic) romance." },
  { key: "jealousy_themes", label: "Jealousy themes", description: "Storylines involving jealousy." },
  { key: "roleplay", label: "Roleplay", description: "Playing fictional characters." },
  { key: "power_dynamics", label: "Dominant / submissive roleplay", description: "Non-explicit power-dynamic roleplay." },
  { key: "public_setting", label: "Public-setting fantasy", description: "Scenes set in public fictional settings." },
  { key: "mystery", label: "Mystery", description: "Suspense and mystery themes." },
  { key: "costume_roleplay", label: "Costume / character roleplay", description: "Character and costume roleplay." },
];

const CATEGORY_KEYS = new Set(CONSENT_CATEGORIES.map((c) => c.key));

export function isValidConsentCategory(key: string): boolean {
  return CATEGORY_KEYS.has(key);
}

/**
 * Resolve two players' private responses into the shared allow-list.
 *
 * Rule: a category is allowed only if BOTH players said YES. If either said NO,
 * or either said MAYBE while the other did not say YES, the category is
 * excluded. This is deliberately conservative — the stricter party always wins,
 * and no private boundary is ever leaked.
 *
 * Returns ONLY the allowed category keys. It must never return which player
 * declined what.
 */
export function resolveCompatibleCategories(
  playerA: Record<string, ConsentResponseValue>,
  playerB: Record<string, ConsentResponseValue>,
): string[] {
  const allowed: string[] = [];
  for (const { key } of CONSENT_CATEGORIES) {
    const a = playerA[key] ?? ConsentResponseValue.NO;
    const b = playerB[key] ?? ConsentResponseValue.NO;
    if (a === ConsentResponseValue.YES && b === ConsentResponseValue.YES) {
      allowed.push(key);
    }
  }
  return allowed;
}
