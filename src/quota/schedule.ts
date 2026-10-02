export type QuotaTrigger = "tick" | "shown" | "manual";

export const POLL_MS = 300_000;
export const SHOW_DEBOUNCE_MS = 60_000;

/** Whether a Provider's quota should be fetched now. A rate limit is always waited out. */
export function isDue(trigger: QuotaTrigger, lastStarted: number | null, rateLimitedUntil: number | null, now: number): boolean {
  if (rateLimitedUntil !== null && now < rateLimitedUntil) return false;
  if (trigger === "manual") return true;
  if (lastStarted === null) return true;
  return now - lastStarted >= (trigger === "tick" ? POLL_MS : SHOW_DEBOUNCE_MS);
}
