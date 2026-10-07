import { create } from "zustand";
import type { WorkspaceRef } from "../workspaces/folder";

export interface FilesWs {
  tabs: string[];
  /** The one tab (if any) that the next unpinned open replaces. */
  preview: string | null;
  active: string | null;
  expanded: string[];
  scroll: Record<string, number>;
  /** Last opened files, newest first. */
  recent: string[];
}

const RECENT_MAX = 20;
const EMPTY: FilesWs = { tabs: [], preview: null, active: null, expanded: [], scroll: {}, recent: [] };

export function wsKey(ref: WorkspaceRef): string {
  return [ref.machine_id, ref.session, ref.workspace_id].join("/");
}

/** Tabs, folds and scroll hold root-relative paths, so each root of a Workspace has its own. */
export function filesKey(ref: WorkspaceRef, root: string): string {
  return `${wsKey(ref)}|${root}`;
}

interface FilesState {
  byWs: Record<string, FilesWs>;
  ws: (key: string) => FilesWs;
  open: (key: string, rel: string, opts: { pin: boolean }) => void;
  pin: (key: string, rel: string) => void;
  close: (key: string, rel: string) => void;
  cycle: (key: string, delta: 1 | -1) => void;
  toggleDir: (key: string, rel: string) => void;
  setScroll: (key: string, rel: string, top: number) => void;
}

export const useFiles = create<FilesState>((set, get) => {
  const update = (key: string, fn: (w: FilesWs) => FilesWs) =>
    set((s) => ({ byWs: { ...s.byWs, [key]: fn(s.byWs[key] ?? EMPTY) } }));

  return {
    byWs: {},
    ws: (key) => get().byWs[key] ?? EMPTY,
    open: (key, rel, { pin }) =>
      update(key, (w) => {
        const recent = [rel, ...w.recent.filter((r) => r !== rel)].slice(0, RECENT_MAX);
        if (w.tabs.includes(rel)) {
          return { ...w, active: rel, recent, preview: pin && w.preview === rel ? null : w.preview };
        }
        if (pin) {
          // A pinned open promotes the current preview, so it stays.
          return { ...w, tabs: [...w.tabs, rel], preview: null, active: rel, recent };
        }
        const at = w.preview ? w.tabs.indexOf(w.preview) : -1;
        const tabs = at >= 0 ? w.tabs.map((t, i) => (i === at ? rel : t)) : [...w.tabs, rel];
        return { ...w, tabs, preview: rel, active: rel, recent };
      }),
    pin: (key, rel) => update(key, (w) => (w.preview === rel ? { ...w, preview: null } : w)),
    close: (key, rel) =>
      update(key, (w) => {
        const at = w.tabs.indexOf(rel);
        if (at < 0) return w;
        const tabs = w.tabs.filter((t) => t !== rel);
        const active = w.active === rel ? (tabs[at] ?? tabs[at - 1] ?? null) : w.active;
        return { ...w, tabs, active, preview: w.preview === rel ? null : w.preview };
      }),
    cycle: (key, delta) =>
      update(key, (w) => {
        if (w.tabs.length === 0) return w;
        const at = w.active ? w.tabs.indexOf(w.active) : -1;
        const next = at < 0 ? 0 : (at + delta + w.tabs.length) % w.tabs.length;
        return { ...w, active: w.tabs[next] };
      }),
    toggleDir: (key, rel) =>
      update(key, (w) => ({
        ...w,
        expanded: w.expanded.includes(rel) ? w.expanded.filter((d) => d !== rel) : [...w.expanded, rel],
      })),
    setScroll: (key, rel, top) => update(key, (w) => ({ ...w, scroll: { ...w.scroll, [rel]: top } })),
  };
});
