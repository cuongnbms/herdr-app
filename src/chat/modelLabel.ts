import type { ChatMeta } from "../lib/types";

/** The Composer's `model · effort` label; whichever is unknown is left out, null when both are. */
export function modelLabel(meta: ChatMeta | undefined): string | null {
  const parts = [meta?.model, meta?.effort].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : null;
}
