import { create } from "zustand";
import type { MachineView, PaneRef, PaneView, SessionView, TabView, WorkspaceView } from "../lib/types";

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
  lens: Record<string, Lens>;
  expanded: Record<string, boolean>;
  upsertMachine: (v: MachineView) => void;
  select: (ref: PaneRef | null) => void;
  setLens: (key: string, lens: Lens) => void;
  toggle: (nodeKey: string, current?: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  machines: {},
  order: [],
  selected: null,
  ...load(),
  upsertMachine: (v) =>
    set((s) => ({
      machines: { ...s.machines, [v.id]: v },
      order: s.order.includes(v.id) ? s.order : [...s.order, v.id],
    })),
  select: (ref) => set({ selected: ref }),
  setLens: (key, lens) => {
    set((s) => ({ lens: { ...s.lens, [key]: lens } }));
    save(get());
  },
  // `current` is the effective (possibly defaulted) open state of the node.
  toggle: (nodeKey, current) => {
    set((s) => ({ expanded: { ...s.expanded, [nodeKey]: !(current ?? s.expanded[nodeKey] ?? true) } }));
    save(get());
  },
}));

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
