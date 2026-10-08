import { create } from "zustand";
import { paneKey } from "../lib/types";
import type { MachineView, PaneRef, PaneView, SessionView, TabView, WorkspaceView } from "../lib/types";
import { pruneFolders, type WorkspaceRef } from "../workspaces/folder";
import { shareEqual } from "./share";
import { forgetMachine, forgetSessions, sessionKey, useLayout } from "../sidebar/groups";
import { newAgentOnTerminal } from "../settings/lens";
import { useFiles, filesKey } from "../files/store";
import {
  closeItems,
  cycleItem,
  dropItems,
  findItem,
  itemKey,
  NO_ITEMS,
  openItem,
  pinItem,
  pruneItems,
  setActive,
  type CloseScope,
  type OpenItem,
  type OpenItems,
} from "./openItems";

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

/** An agent being started in a new pane: first waiting for its shell, then for herdr to report the agent. */
export interface AgentStart {
  agent: string;
  phase: "shell" | "agent";
}

export interface AppState {
  machines: Record<string, MachineView>;
  order: string[];
  selected: PaneRef | null;
  /** The session listed in the Agents column. Selecting a pane views its session. Not persisted. */
  viewed: SessionRef | null;
  /** The pane last selected in each session (by sessionKey), opened again when the session is viewed. Not persisted. */
  lastPane: Record<string, PaneRef>;
  lens: Record<string, Lens>;
  expanded: Record<string, boolean>;
  /** Automatic lens choices (the Chat lens falling back to Terminal). Not persisted; they win
   *  over `lens` until the user picks a lens again. */
  lensOverride: Record<string, Lens>;
  setLensOverride: (key: string, lens: Lens | null) => void;
  /** Panes (by paneKey) whose agent is still starting, shown under a loading overlay. Not persisted. */
  starting: Record<string, AgentStart>;
  setStarting: (key: string, start: AgentStart | null) => void;
  /** Whether the Agent Dashboard overlay is open. Not persisted. */
  dashboardOpen: boolean;
  setDashboardOpen: (open: boolean) => void;
  /** Whether the Command Palette is open. Not persisted. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** Done panes the user has looked at (by paneKey); a seen Done pane counts as Idle on the
   *  dashboard. Cleared when the pane leaves done. Not persisted. */
  doneSeen: Record<string, true>;
  /** When each pane's status last changed (by paneKey, ms since epoch), as seen by this app run:
   *  panes in a machine's first snapshot have none. Orders the dashboard's Idle column. Not persisted. */
  statusSince: Record<string, number>;
  /** The agents and files opened, across machines and workspaces, shown as tabs above the lens. Not persisted. */
  openItems: OpenItems;
  /** Opens a file item (pinned or as the preview) and makes it active; `selected` is unchanged. Records it in useFiles recent. */
  openFile: (ws: WorkspaceRef, root: string, rel: string, opts: { pin: boolean }) => void;
  /** Activates an item: an agent item selects its Pane; a file item only becomes active. */
  activateItem: (key: string) => void;
  pinItem: (key: string) => void;
  /** Closes relative to `key`; if the new active item is an agent, selects its Pane. */
  closeItems: (key: string, scope: "one" | CloseScope) => void;
  cycleItems: (delta: 1 | -1) => void;
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
  lastPane: {},
  lensOverride: {},
  starting: {},
  dashboardOpen: false,
  paletteOpen: false,
  doneSeen: {},
  statusSince: {},
  openItems: NO_ITEMS,
  ...load(),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  // Closing returns to the selected pane, so a done one counts as seen then.
  setDashboardOpen: (open) =>
    set((s) => ({
      dashboardOpen: open,
      doneSeen:
        !open && s.selected && findPane(s.machines, s.selected)?.status === "done"
          ? { ...s.doneSeen, [paneKey(s.selected)]: true }
          : s.doneSeen,
    })),
  upsertMachine: (v) => {
    // Prune by diff against the previous view so a folder saved for a
    // just-created Workspace survives until the snapshot lists it.
    const prev = get().machines[v.id]?.sessions;
    for (const s of v.sessions) pruneFolders(v.id, s, prev?.find((p) => p.name === s.name));
    // Only a connected snapshot is authoritative about which Sessions exist.
    if (v.state === "connected" && prev) {
      const gone = prev.filter((p) => !v.sessions.some((s) => s.name === p.name)).map((p) => sessionKey(v.id, p.name));
      if (gone.length) useLayout.getState().update((l) => forgetSessions(l, gone));
    }
    set((s) => {
      // Unchanged Panes, Tabs and Workspaces keep their objects, so their readers stay quiet.
      const shared = s.machines[v.id] ? shareEqual(s.machines[v.id], v) : v;
      // The dashboard hides the selected pane, so it is not seen while the dashboard is open.
      const doneSeen = seenAfterSnapshot(s.doneSeen, shared, s.dashboardOpen ? null : s.selected);
      const statusSince = sinceAfterSnapshot(s.statusSince, s.machines[v.id], shared, Date.now());
      const openItems = itemsAfterSnapshot(s.openItems, s.machines[v.id], shared, s.selected);
      return {
        machines: s.machines[v.id] === shared ? s.machines : { ...s.machines, [v.id]: shared },
        lensOverride: agentStarted(s, shared) ? { ...s.lensOverride, [paneKey(s.selected!)]: "terminal" } : s.lensOverride,
        order: s.order.includes(v.id) ? s.order : [...s.order, v.id],
        doneSeen: sameKeys(doneSeen, s.doneSeen) ? s.doneSeen : doneSeen,
        statusSince: sameTimes(statusSince, s.statusSince) ? s.statusSince : statusSince,
        openItems,
      };
    });
  },
  removeMachine: (id) => {
    useLayout.getState().update((l) => forgetMachine(l, id));
    set((s) => {
      const { [id]: _gone, ...machines } = s.machines;
      return {
        machines,
        order: s.order.filter((o) => o !== id),
        selected: s.selected?.machine_id === id ? null : s.selected,
        openItems: dropItems(s.openItems, (i) => (i.kind === "agent" ? i.ref : i.ws).machine_id === id),
        viewed: s.viewed?.machine_id === id ? null : s.viewed,
      };
    });
  },
  select: (ref) =>
    set((s) => ({
      selected: ref,
      dashboardOpen: ref ? false : s.dashboardOpen,
      viewed: ref ? { machine_id: ref.machine_id, session: ref.session } : s.viewed,
      lastPane: ref ? { ...s.lastPane, [sessionKey(ref.machine_id, ref.session)]: ref } : s.lastPane,
      doneSeen: ref && findPane(s.machines, ref)?.status === "done" ? { ...s.doneSeen, [paneKey(ref)]: true } : s.doneSeen,
      openItems: !ref
        ? s.openItems
        : findItem(s.openItems, itemKey({ kind: "agent", ref }))
          ? setActive(s.openItems, itemKey({ kind: "agent", ref }))
          : findPane(s.machines, ref)?.agent
            ? openItem(s.openItems, { kind: "agent", ref }, { pin: false })
            : setActive(s.openItems, null),
    })),
  openFile: (ws, root, rel, opts) => {
    set((s) => ({ openItems: openItem(s.openItems, { kind: "file", ws, root, rel }, opts) }));
    useFiles.getState().addRecent(filesKey(ws, root), rel);
  },
  activateItem: (key) => {
    const item = findItem(get().openItems, key);
    if (!item) return;
    if (item.kind === "agent") get().select(item.ref);
    else set((s) => ({ openItems: setActive(s.openItems, key) }));
  },
  pinItem: (key) => set((s) => ({ openItems: pinItem(s.openItems, key) })),
  closeItems: (key, scope) => {
    const old = get().openItems;
    const next = closeItems(old, scope, key);
    if (next === old) return;
    set({ openItems: next });
    if (next.active !== old.active) selectIfAgent(get(), next);
  },
  cycleItems: (delta) => {
    const next = cycleItem(get().openItems, delta);
    set({ openItems: next });
    selectIfAgent(get(), next);
  },
  // Viewing another session also opens its pane: the one last selected there, else its first.
  view: (ref) => {
    const s = get();
    const sel = s.selected;
    if (!ref) return set({ viewed: ref });
    // Reselecting the current pane still closes the dashboard.
    if (sel && sel.machine_id === ref.machine_id && sel.session === ref.session) return s.select(sel);
    const last = s.lastPane[sessionKey(ref.machine_id, ref.session)];
    const pane = last && findPane(s.machines, last) ? last : firstPane(s.machines, ref);
    if (pane) s.select(pane);
    else set({ viewed: ref });
  },
  setLensOverride: (key, lens) =>
    set((s) => {
      const { [key]: _old, ...rest } = s.lensOverride;
      return { lensOverride: lens ? { ...rest, [key]: lens } : rest };
    }),
  setStarting: (key, start) =>
    set((s) => {
      const { [key]: _old, ...rest } = s.starting;
      return { starting: start ? { ...rest, [key]: start } : rest };
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

/** The item being shown above the lens, if any. */
export function activeItem(s: Pick<AppState, "openItems">): OpenItem | null {
  return (s.openItems.active && findItem(s.openItems, s.openItems.active)) || null;
}

/** Selects the Pane of the active item when it is an agent. */
function selectIfAgent(s: AppState, items: OpenItems) {
  const active = items.active ? findItem(items, items.active) : undefined;
  if (active?.kind === "agent") s.select(active.ref);
}

/** Drops closed panes' and workspaces' items (only a connected snapshot says they are gone) and opens
 *  the item of an agent started in the selected pane. */
function itemsAfterSnapshot(prev: OpenItems, before: MachineView | undefined, v: MachineView, selected: PaneRef | null): OpenItems {
  const next = v.state === "connected" ? pruneItems(prev, v) : prev;
  if (selected?.machine_id !== v.id || !findPane({ [v.id]: v }, selected)?.agent) return next;
  const item: OpenItem = { kind: "agent", ref: selected };
  const started = !before || !findPane({ [v.id]: before }, selected)?.agent;
  return started && !findItem(next, itemKey(item)) ? openItem(next, item, { pin: false }) : next;
}

export function findPane(machines: Record<string, MachineView>, ref: PaneRef): PaneView | undefined {
  const session = machines[ref.machine_id]?.sessions.find((s) => s.name === ref.session);
  for (const ws of session?.workspaces ?? []) {
    for (const tab of ws.tabs) {
      const pane = tab.panes.find((p) => p.pane_id === ref.pane_id);
      if (pane) return pane;
    }
  }
  return undefined;
}

/** An agent (any kind) started in the selected pane, shown on the Terminal with no lens chosen, while
 *  new agents open on the Terminal: stay on the Terminal the user is typing in until they switch. */
function agentStarted(s: Pick<AppState, "machines" | "selected" | "lens" | "lensOverride">, v: MachineView): boolean {
  const sel = s.selected;
  if (!sel || sel.machine_id !== v.id || chosenLens(s, paneKey(sel)) || !newAgentOnTerminal()) return false;
  const before = findPane(s.machines, sel);
  const agent = findPane({ [v.id]: v }, sel)?.agent;
  return !!before && !!agent && before.agent !== agent;
}

function firstPane(machines: Record<string, MachineView>, ref: SessionRef): PaneRef | null {
  const session = machines[ref.machine_id]?.sessions.find((s) => s.name === ref.session);
  for (const ws of session?.workspaces ?? []) {
    for (const tab of ws.tabs) {
      const pane = tab.panes[0];
      if (pane) return { machine_id: ref.machine_id, session: ref.session, pane_id: pane.pane_id };
    }
  }
  return null;
}

/** This machine's seen marks after a snapshot: only panes still done keep theirs, and the
 *  selected pane is seen as soon as it is done. Other machines' marks are untouched. */
function seenAfterSnapshot(prev: Record<string, true>, v: MachineView, selected: PaneRef | null): Record<string, true> {
  const next: Record<string, true> = {};
  const prefix = v.id + "/";
  for (const k of Object.keys(prev)) if (!k.startsWith(prefix)) next[k] = true;
  const selKey = selected ? paneKey(selected) : null;
  for (const s of v.sessions)
    for (const ws of s.workspaces)
      for (const tab of ws.tabs)
        for (const p of tab.panes) {
          if (p.status !== "done") continue;
          const k = paneKey({ machine_id: v.id, session: s.name, pane_id: p.pane_id });
          if (prev[k] || k === selKey) next[k] = true;
        }
  return next;
}

/** This machine's status-change times after a snapshot: a pane whose status changed, or that
 *  appeared since the last snapshot, is stamped `now`; gone panes are dropped. A machine's first
 *  snapshot stamps nothing, as when each status began is unknown. Other machines' times are untouched. */
function sinceAfterSnapshot(prev: Record<string, number>, before: MachineView | undefined, v: MachineView, now: number): Record<string, number> {
  const next: Record<string, number> = {};
  const prefix = v.id + "/";
  for (const k of Object.keys(prev)) if (!k.startsWith(prefix)) next[k] = prev[k];
  for (const s of v.sessions)
    for (const ws of s.workspaces)
      for (const tab of ws.tabs)
        for (const p of tab.panes) {
          const ref = { machine_id: v.id, session: s.name, pane_id: p.pane_id };
          const k = paneKey(ref);
          if (!before) continue;
          const old = findPane({ [v.id]: before }, ref);
          if (!old || old.status !== p.status) next[k] = now;
          else if (k in prev) next[k] = prev[k];
        }
  return next;
}

function sameTimes(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

function sameKeys(a: Record<string, true>, b: Record<string, true>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b);
}

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
