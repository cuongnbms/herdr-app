import type { ChatRow } from "./workBlocks";

/** One user turn in the outline rail: `row` is its index in the virtualized rows. */
export interface OutlineEntry {
  row: number;
  key: string;
  label: string;
}

/** The user turns among `rows`, each labeled by its first line (or its Skill, or its image); a shell command by itself. */
export function outline(rows: ChatRow[]): OutlineEntry[] {
  return rows.flatMap((r, row) => {
    if (r.kind !== "item") return [];
    const it = r.item;
    if (it.kind === "shell_command") return [{ row, key: r.key, label: `!${it.command.split("\n")[0]}` }];
    if (it.kind !== "user") return [];
    const line = it.text.split("\n").map((l) => l.trim()).find((l) => l !== "");
    const label = line ?? (it.skills?.length ? `/${it.skills[0].name}` : it.images?.length ? "Image" : "");
    return label === "" ? [] : [{ row, key: r.key, label }];
  });
}

/**
 * The entry being read: the last turn starting at or above the top visible row (-1: no turns).
 * `atEnd`: scrolled to the bottom, where a short last turn is in view but cannot reach the top.
 */
export function currentEntry(entries: OutlineEntry[], topRow: number, atEnd = false): number {
  if (entries.length === 0) return -1;
  if (atEnd) return entries.length - 1;
  let at = 0;
  for (let i = 0; i < entries.length && entries[i].row <= topRow; i++) at = i;
  return at;
}
