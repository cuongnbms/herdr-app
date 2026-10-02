import type { QuotaWindow } from "../lib/types";

export const WARN_PERCENT = 90;

export type Tone = "muted" | "ok" | "warn";

export function percent(n: number): string {
  return `${Math.round(n)}%`;
}

/** Compact time until a reset, or null when the Provider gave none. */
export function untilReset(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const secs = Math.floor((resetsAt - now) / 1000);
  if (secs <= 0) return "reset pending";
  if (secs < 60) return "<1m";
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  return `${m}m`;
}

export function updatedAgo(fetchedAt: number, now: number): string {
  const secs = Math.floor((now - fetchedAt) / 1000);
  if (secs < 60) return "updated just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

/** How far through its window we are, 0…1; null without a reset time and a positive length. */
export function elapsedFraction(resetsAt: number | null, durationSecs: number | null, now: number): number | null {
  if (resetsAt === null || durationSecs === null || durationSecs <= 0) return null;
  return Math.min(1, Math.max(0, 1 - (resetsAt - now) / (durationSecs * 1000)));
}

/** Warn when nearly exhausted or burning faster than the window elapses. */
export function tone(w: QuotaWindow, now: number): Tone {
  if (w.usedPercent >= WARN_PERCENT) return "warn";
  const fraction = elapsedFraction(w.resetsAt, w.durationSecs, now);
  if (fraction === null) return "muted";
  return w.usedPercent > fraction * 100 ? "warn" : "ok";
}
