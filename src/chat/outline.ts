import type { ChatRow } from "./workBlocks";

/** One user turn in the outline rail: `row` is its index in the virtualized rows. */
export interface OutlineEntry {
  row: number;
  key: string;
  label: string;
}

/** The user turns among `rows`, each labeled by its first line (or its Skill, or its image). */
export function outline(rows: ChatRow[]): OutlineEntry[] {
  return rows.flatMap((r, row) => {
    if (r.kind !== "item" || r.item.kind !== "user") return [];
    const it = r.item;
    const line = it.text.split("\n").map((l) => l.trim()).find((l) => l !== "");
    const label = line ?? (it.skills?.length ? `/${it.skills[0].name}` : it.images?.length ? "Image" : "");
    return label === "" ? [] : [{ row, key: r.key, label }];
  });
}

/** The entry being read: the last turn starting at or above the top visible row (-1: no turns). */
export function currentEntry(entries: OutlineEntry[], topRow: number): number {
  if (entries.length === 0) return -1;
  let at = 0;
  for (let i = 0; i < entries.length && entries[i].row <= topRow; i++) at = i;
  return at;
}
