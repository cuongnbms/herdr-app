import type { FileChange } from "../lib/types";

/** The folder holding `rel`; `""` is the root and has no parent but itself. */
export function parentDir(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/** Folders whose listing a change batch may have altered, deduped in first-seen order. */
export function dirsToRelist(changes: FileChange[]): string[] {
  const dirs = new Set<string>();
  for (const c of changes) {
    dirs.add(parentDir(c.path));
    if (c.isDir && !c.removed) dirs.add(c.path);
  }
  return [...dirs];
}
