import { create } from "zustand";
import type { FileChange } from "../lib/types";

/** Numbered so each consumer handles a batch once. */
export interface ChangeBatch {
  seq: number;
  changes: FileChange[];
}

interface FilesBus {
  /** The latest watch batch, by filesKey. */
  batches: Record<string, ChangeBatch>;
  /** How often a reload was asked for, by filesKey. */
  reloads: Record<string, number>;
  /** Hands watch changes of a root to whoever shows it. */
  publish(key: string, changes: FileChange[]): void;
  /** Asks everything showing the root to read it again. */
  reload(key: string): void;
}

export const useFilesBus = create<FilesBus>((set) => ({
  batches: {},
  reloads: {},
  publish: (key, changes) =>
    set((s) => ({ batches: { ...s.batches, [key]: { seq: (s.batches[key]?.seq ?? 0) + 1, changes } } })),
  reload: (key) => set((s) => ({ reloads: { ...s.reloads, [key]: (s.reloads[key] ?? 0) + 1 } })),
}));
