import { create } from "zustand";

interface FilesPanelState {
  /** Pixels of the panel; null is half the column. */
  height: number | null;
  collapsed: boolean;
  /** Bumped to focus the tree. */
  focusTick: number;
  /** Bumped to focus Go to file. */
  gotoTick: number;
  /** The ticks already acted on; a panel that mounts with a newer tick still has a request to act on. */
  focusHandled: number;
  gotoHandled: number;
  setHeight(px: number): void;
  setCollapsed(on: boolean): void;
  /** Expands the panel and asks for the tree's focus. */
  focusTree(): void;
  /** Expands the panel and asks for Go to file's focus. */
  focusGoto(): void;
  /** Marks the pending focus requests as acted on. */
  handled(which: "tree" | "goto" | "both"): void;
}

/** Layout of the Files panel for the running app; nothing here is persisted. */
export const useFilesPanel = create<FilesPanelState>((set) => ({
  height: null,
  collapsed: false,
  focusTick: 0,
  gotoTick: 0,
  focusHandled: 0,
  gotoHandled: 0,
  setHeight: (height) => set({ height }),
  setCollapsed: (collapsed) => set({ collapsed }),
  focusTree: () => set((s) => ({ collapsed: false, focusTick: s.focusTick + 1 })),
  focusGoto: () => set((s) => ({ collapsed: false, gotoTick: s.gotoTick + 1 })),
  handled: (which) =>
    set((s) => ({
      focusHandled: which === "goto" ? s.focusHandled : s.focusTick,
      gotoHandled: which === "tree" ? s.gotoHandled : s.gotoTick,
    })),
}));
