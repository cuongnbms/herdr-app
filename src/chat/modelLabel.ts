import type { ChatMeta } from "../lib/types";

/** A token count, short: `950`, `48.6k`, `1.02M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${+(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${+(n / 1_000_000).toFixed(2)}M`;
}

/** The Composer's `model · effort · tokens` label; whichever is unknown is left out, null when all are. */
export function modelLabel(meta: ChatMeta | undefined): string | null {
  const tokens = meta?.context_tokens ? formatTokens(meta.context_tokens) : null;
  const parts = [meta?.model, meta?.effort, tokens].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : null;
}
