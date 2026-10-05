import { describe, it, expect } from "vitest";
import {
  ConsentResponseValue,
  resolveCompatibleCategories,
  SessionState,
  canTransition,
  isTerminal,
} from "@luvora/shared";
import { ageInYears, meetsMinimumAge } from "../src/auth/age";

describe("age gate", () => {
  const now = new Date("2026-10-05T00:00:00Z");

  it("computes whole-year age correctly", () => {
    expect(ageInYears(new Date("2008-10-05"), now)).toBe(18);
    expect(ageInYears(new Date("2008-10-06"), now)).toBe(17); // birthday tomorrow
  });

  it("accepts users who are exactly 18 or older", () => {
    expect(meetsMinimumAge(new Date("2008-10-05"), now)).toBe(true);
    expect(meetsMinimumAge(new Date("1990-01-01"), now)).toBe(true);
  });

  it("rejects users under 18", () => {
    expect(meetsMinimumAge(new Date("2008-10-06"), now)).toBe(false);
    expect(meetsMinimumAge(new Date("2015-01-01"), now)).toBe(false);
  });
});

describe("consent compatibility resolver", () => {
  const Y = ConsentResponseValue.YES;
  const M = ConsentResponseValue.MAYBE;
  const N = ConsentResponseValue.NO;

  it("allows a category only when BOTH say YES", () => {
    const a = { flirting: Y, teasing: Y, mystery: Y };
    const b = { flirting: Y, teasing: N, mystery: M };
    expect(resolveCompatibleCategories(a, b)).toEqual(["flirting"]);
  });

  it("treats a missing answer as NO (conservative default)", () => {
    const a = { flirting: Y };
    const b = {}; // no answers at all
    expect(resolveCompatibleCategories(a, b)).toEqual([]);
  });

  it("never allows a category one party declined", () => {
    const a = { power_dynamics: Y };
    const b = { power_dynamics: N };
    expect(resolveCompatibleCategories(a, b)).toEqual([]);
  });

  it("the stricter party always wins (MAYBE is not YES)", () => {
    const a = { roleplay: Y };
    const b = { roleplay: M };
    expect(resolveCompatibleCategories(a, b)).toEqual([]);
  });
});

describe("session state machine", () => {
  it("permits the canonical happy path", () => {
    expect(canTransition(SessionState.WAITING, SessionState.INVITED)).toBe(true);
    expect(canTransition(SessionState.INVITED, SessionState.ACCEPTED)).toBe(true);
    expect(canTransition(SessionState.ACCEPTED, SessionState.CONSENT)).toBe(true);
    expect(canTransition(SessionState.CONSENT, SessionState.PLAYING)).toBe(true);
    expect(canTransition(SessionState.PLAYING, SessionState.COMPLETED)).toBe(true);
  });

  it("forbids skipping the consent stage", () => {
    expect(canTransition(SessionState.ACCEPTED, SessionState.PLAYING)).toBe(false);
    expect(canTransition(SessionState.INVITED, SessionState.PLAYING)).toBe(false);
    expect(canTransition(SessionState.WAITING, SessionState.PLAYING)).toBe(false);
  });

  it("marks terminal states as terminal with no exits", () => {
    expect(isTerminal(SessionState.COMPLETED)).toBe(true);
    expect(isTerminal(SessionState.ABANDONED)).toBe(true);
    expect(canTransition(SessionState.COMPLETED, SessionState.PLAYING)).toBe(false);
  });
});
