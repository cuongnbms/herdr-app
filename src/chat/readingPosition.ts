/** Where the user was reading in a transcript, by absolute item index so it survives paging and trims. */
export interface ReadingPosition {
  atBottom: boolean;
  item: number;
  delta: number;
  total: number;
}

/** How many reading positions are kept. */
export const READING_POSITIONS = 50;
/** How many older pages a restore may load to reach the saved row. */
export const RESTORE_PAGES = 10;

const positions = new Map<string, ReadingPosition>();

/** Remembers a position for this pane and transcript, dropping the oldest past the cap. */
export function savePosition(paneKey: string, path: string, p: ReadingPosition): void {
  const key = `${paneKey}\n${path}`;
  positions.delete(key);
  positions.set(key, p);
  while (positions.size > READING_POSITIONS) positions.delete(positions.keys().next().value as string);
}

/** The position last saved for this pane and transcript. */
export function savedPosition(paneKey: string, path: string): ReadingPosition | undefined {
  return positions.get(`${paneKey}\n${path}`);
}

export type Restore = { kind: "bottom" } | { kind: "row"; item: number; delta: number; unseen: boolean } | { kind: "page"; before: number };

/** Decides where a reopened transcript lands: the bottom, the saved row, or another older page first. */
export function restoreTarget(saved: ReadingPosition | undefined, total: number, windowStart: number, pages: number): Restore {
  if (!saved || saved.atBottom || saved.item >= total) return { kind: "bottom" };
  const unseen = total > saved.total;
  if (saved.item >= windowStart) return { kind: "row", item: saved.item, delta: saved.delta, unseen };
  if (pages < RESTORE_PAGES) return { kind: "page", before: windowStart };
  return { kind: "row", item: windowStart, delta: 0, unseen };
}

/** The last row whose first item is at or before `item`, 0 when none. */
export function rowForItem(rows: readonly { at: number }[], item: number): number {
  let found = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].at <= item) found = i;
    else break;
  }
  return found;
}

/** The first row reaching into the viewport and how far the viewport is scrolled past its start. */
export function topVisible(
  rows: readonly { at: number }[],
  shown: readonly { index: number; start: number; end: number }[],
  scrollTop: number,
): { item: number; delta: number } | null {
  const v = shown.find((s) => s.end > scrollTop);
  const row = v && rows[v.index];
  return v && row ? { item: row.at, delta: scrollTop - v.start } : null;
}
