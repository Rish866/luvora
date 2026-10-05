import { MINIMUM_AGE } from "@luvora/shared";

/** Compute age in whole years from a date of birth, relative to `now`. */
export function ageInYears(dob: Date, now: Date = new Date()): number {
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) {
    age -= 1;
  }
  return age;
}

/** Server-side age gate. The client confirmation flag is NOT trusted on its
 *  own — the date of birth must independently prove 18+. */
export function meetsMinimumAge(dob: Date, now: Date = new Date()): boolean {
  return ageInYears(dob, now) >= MINIMUM_AGE;
}
