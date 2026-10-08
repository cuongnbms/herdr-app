import { create } from "zustand";
import type { WorkspaceRef } from "../workspaces/folder";
import type { FileMode } from "./FileView";

export interface FilesWs {
  expanded: string[];
  scroll: Record<string, number>;
  /** Last opened files, newest first. */
  recent: string[];
  /** Render or Source, as last chosen for each file. */
  modes: Record<string, FileMode>;
}

const RECENT_MAX = 20;

const recentWith = (recent: string[], rel: string) => [rel, ...recent.filter((r) => r !== rel)].slice(0, RECENT_MAX);
const EMPTY: FilesWs = { expanded: [], scroll: {}, recent: [], modes: {} };

export function wsKey(ref: WorkspaceRef): string {
  return [ref.machine_id, ref.session, ref.workspace_id].join("/");
}

/** Folds, scroll and recent files hold root-relative paths, so each root of a Workspace has its own. */
export function filesKey(ref: WorkspaceRef, root: string): string {
  return `${wsKey(ref)}|${root}`;
}

interface FilesState {
  byWs: Record<string, FilesWs>;
  ws: (key: string) => FilesWs;
  /** Puts `rel` first in the Workspace root's recent files. */
  addRecent: (key: string, rel: string) => void;
  toggleDir: (key: string, rel: string) => void;
  setScroll: (key: string, rel: string, top: number) => void;
  setMode: (key: string, rel: string, mode: FileMode) => void;
}

export const useFiles = create<FilesState>((set, get) => {
  const update = (key: string, fn: (w: FilesWs) => FilesWs) =>
    set((s) => ({ byWs: { ...s.byWs, [key]: fn(s.byWs[key] ?? EMPTY) } }));

  return {
    byWs: {},
    ws: (key) => get().byWs[key] ?? EMPTY,
    addRecent: (key, rel) => update(key, (w) => ({ ...w, recent: recentWith(w.recent, rel) })),
    toggleDir: (key, rel) =>
      update(key, (w) => ({
        ...w,
        expanded: w.expanded.includes(rel) ? w.expanded.filter((d) => d !== rel) : [...w.expanded, rel],
      })),
    setScroll: (key, rel, top) => update(key, (w) => ({ ...w, scroll: { ...w.scroll, [rel]: top } })),
    setMode: (key, rel, mode) => update(key, (w) => ({ ...w, modes: { ...w.modes, [rel]: mode } })),
  };
});
