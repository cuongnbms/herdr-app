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

/** Whether `rel` is `path` or inside it. */
export const relUnder = (rel: string, path: string) => rel === path || rel.startsWith(path + "/");

/** `rel` after `from` became `to` (null: was deleted); paths outside `from` are kept. */
const moved = (rel: string, from: string, to: string | null): string | null =>
  !relUnder(rel, from) ? rel : to === null ? null : to + rel.slice(from.length);

function moveKeys<T>(m: Record<string, T>, from: string, to: string | null): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [rel, v] of Object.entries(m)) {
    const next = moved(rel, from, to);
    if (next !== null) out[next] = v;
  }
  return out;
}

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
  /** After `from` was renamed to `to`, or deleted (`to` null): folds, recent files, scroll and modes follow. */
  moveRel: (key: string, from: string, to: string | null) => void;
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
    moveRel: (key, from, to) =>
      update(key, (w) => {
        const list = (l: string[]) => l.map((r) => moved(r, from, to)).filter((r): r is string => r !== null);
        return { expanded: list(w.expanded), recent: list(w.recent), scroll: moveKeys(w.scroll, from, to), modes: moveKeys(w.modes, from, to) };
      }),
  };
});
