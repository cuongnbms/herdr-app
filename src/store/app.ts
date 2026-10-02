import { create } from "zustand";
import type { MachineView, PaneRef, PaneView, SessionView, TabView, WorkspaceView } from "../lib/types";

export interface SessionRef {
  machine_id: string;
  session: string;
}

export type Lens = "terminal" | "chat";

const STORAGE_KEY = "herdr-app:ui";

interface Persisted {
  lens: Record<string, Lens>;
  expanded: Record<string, boolean>;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      return { lens: p.lens ?? {}, expanded: p.expanded ?? {} };
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return { lens: {}, expanded: {} };
}

function save(s: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lens: s.lens, expanded: s.expanded }));
  } catch {
    /* ignore */
  }
}

export interface AppState {
  machines: Record<string, MachineView>;
  order: string[];
  selected: PaneRef | null;
  /** The session listed in the Agents column. Selecting a pane views its session. Not persisted. */
  viewed: SessionRef | null;
  lens: Record<string, Lens>;
  expanded: Record<string, boolean>;
  /** One-line notes shown in the Terminal lens, e.g. after a Chat lens fallback. Not persisted. */
  lensNote: Record<string, string>;
  setLensNote: (key: string, note: string | null) => void;
  /** Automatic lens choices (the Chat lens falling back to Terminal). Not persisted; they win
   *  over `lens` until the user picks a lens again. */
  lensOverride: Record<string, Lens>;
  setLensOverride: (key: string, lens: Lens | null) => void;
  upsertMachine: (v: MachineView) => void;
  removeMachine: (id: string) => void;
  select: (ref: PaneRef | null) => void;
  view: (ref: SessionRef | null) => void;
  setLens: (key: string, lens: Lens) => void;
  toggle: (nodeKey: string, current?: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  machines: {},
  order: [],
  selected: null,
  viewed: null,
  lensNote: {},
  lensOverride: {},
  ...load(),
  setLensNote: (key, note) =>
    set((s) => {
      const { [key]: _old, ...rest } = s.lensNote;
      return { lensNote: note ? { ...rest, [key]: note } : rest };
    }),
  upsertMachine: (v) =>
    set((s) => ({
      machines: { ...s.machines, [v.id]: v },
      order: s.order.includes(v.id) ? s.order : [...s.order, v.id],
    })),
  removeMachine: (id) =>
    set((s) => {
      const { [id]: _gone, ...machines } = s.machines;
      return {
        machines,
        order: s.order.filter((o) => o !== id),
        selected: s.selected?.machine_id === id ? null : s.selected,
        viewed: s.viewed?.machine_id === id ? null : s.viewed,
      };
    }),
  select: (ref) =>
    set((s) => ({ selected: ref, viewed: ref ? { machine_id: ref.machine_id, session: ref.session } : s.viewed })),
  view: (ref) => set({ viewed: ref }),
  setLensOverride: (key, lens) =>
    set((s) => {
      const { [key]: _old, ...rest } = s.lensOverride;
      return { lensOverride: lens ? { ...rest, [key]: lens } : rest };
    }),
  // An explicit choice: persisted, and it ends any automatic override.
  setLens: (key, lens) => {
    set((s) => {
      const { [key]: _old, ...lensOverride } = s.lensOverride;
      return { lens: { ...s.lens, [key]: lens }, lensOverride };
    });
    save(get());
  },
  // `current` is the effective (possibly defaulted) open state of the node.
  toggle: (nodeKey, current) => {
    set((s) => ({ expanded: { ...s.expanded, [nodeKey]: !(current ?? s.expanded[nodeKey] ?? true) } }));
    save(get());
  },
}));

/** The lens chosen for a pane (automatic override first, then the remembered choice). */
export function chosenLens(state: Pick<AppState, "lens" | "lensOverride">, key: string): Lens | undefined {
  return state.lensOverride[key] ?? state.lens[key];
}

export interface SelectedPane {
  machine: MachineView;
  session: SessionView;
  workspace: WorkspaceView;
  tab: TabView;
  pane: PaneView;
}

export function selectedPane(state: Pick<AppState, "machines" | "selected">): SelectedPane | null {
  const sel = state.selected;
  if (!sel) return null;
  const machine = state.machines[sel.machine_id];
  const session = machine?.sessions.find((s) => s.name === sel.session);
  if (!machine || !session) return null;
  for (const workspace of session.workspaces) {
    for (const tab of workspace.tabs) {
      const pane = tab.panes.find((p) => p.pane_id === sel.pane_id);
      if (pane) return { machine, session, workspace, tab, pane };
    }
  }
  return null;
}
