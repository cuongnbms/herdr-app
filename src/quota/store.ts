import { create } from "zustand";
import { quotaFetch } from "../lib/ipc";
import type { QuotaOutcome, QuotaProvider } from "../lib/types";
import { applying, QUOTA_PROVIDERS, type QuotaEntry } from "./entry";
import { isDue, type QuotaTrigger } from "./schedule";

export interface QuotaSlot {
  entry: QuotaEntry;
  lastStarted: number | null;
  rateLimitedUntil: number | null;
  inFlight: boolean;
}

export interface QuotaState {
  slots: Record<QuotaProvider, QuotaSlot>;
  refresh: (trigger: QuotaTrigger) => Promise<void>;
}

export const initialSlots = (): Record<QuotaProvider, QuotaSlot> => {
  const slot = (): QuotaSlot => ({ entry: { kind: "loading" }, lastStarted: null, rateLimitedUntil: null, inFlight: false });
  return { claude: slot(), codex: slot(), opencodeGo: slot(), grok: slot() };
};

export const useQuota = create<QuotaState>((set, get) => {
  const settle = (p: QuotaProvider, outcome: QuotaOutcome) =>
    set((s) => ({
      slots: {
        ...s.slots,
        [p]: {
          ...s.slots[p],
          entry: applying(s.slots[p].entry, outcome, p),
          rateLimitedUntil: outcome.kind === "rateLimited" ? outcome.until : null,
          inFlight: false,
        },
      },
    }));

  return {
    slots: initialSlots(),
    refresh: async (trigger) => {
      const now = Date.now();
      const due = QUOTA_PROVIDERS.filter((p) => {
        const s = get().slots[p];
        return !s.inFlight && isDue(trigger, s.lastStarted, s.rateLimitedUntil, now);
      });
      if (due.length === 0) return;
      set((s) => {
        const slots = { ...s.slots };
        for (const p of due) slots[p] = { ...slots[p], inFlight: true, lastStarted: now };
        return { slots };
      });
      await Promise.all(
        due.map((p) =>
          quotaFetch(p).then(
            (outcome) => settle(p, outcome),
            (err) => settle(p, { kind: "failed", reason: err instanceof Error ? err.message : String(err) }),
          ),
        ),
      );
    },
  };
});
