/**
 * Expiry arithmetic for access keys, in one place.
 *
 * It lives outside the components on purpose: reading the clock is impure, and the
 * React Compiler is right to refuse it in render. A module-level helper is also the
 * only way the create dialog, the edit dialog and the rotate dialog can agree on
 * what "90 days" means.
 */

export const DAY_MS = 86_400_000;

/** An ISO timestamp `days` from now. */
export function isoInDays(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

/** An ISO timestamp `seconds` from now. */
export function isoInSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Milliseconds until `iso`, negative once it has passed. */
export function msUntil(iso: string): number {
  return Date.parse(iso) - Date.now();
}
