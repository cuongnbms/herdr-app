export type Match = { line: number; start: number; end: number };

/** What a view reports to the find bar: how many matches, and which one is current. */
export type FindStatus = { count: number; index: number };

/** What the overlay asks a view to find; `index` counts steps taken from the starting match. */
export type FindQuery = { query: string; index: number; matchCase: boolean };

/** `steps` past `base`, wrapped around `count` matches. */
export const wrapIndex = (base: number, steps: number, count: number) => (((base + steps) % count) + count) % count;

/** One code point lowercased, kept as is when lowercasing would change its length (`İ`). */
function lowerPoint(ch: string): string {
  const l = ch.toLowerCase();
  return l.length === ch.length ? l : ch;
}

/** The code point of `text` at unit `i` (one or two UTF-16 units). */
function pointAt(text: string, i: number): string {
  const c = text.codePointAt(i)!;
  return String.fromCodePoint(c);
}

/** Non-overlapping case-insensitive matches in `text`, as unit offsets into `text`. */
function matchRanges(text: string, qLower: string, qPoints: string[]): [number, number][] {
  const out: [number, number][] = [];
  const hay = text.toLowerCase();
  if (hay.length === text.length) {
    // Lowercasing kept every offset, so search the lowered text directly.
    for (let at = hay.indexOf(qLower); at >= 0; at = hay.indexOf(qLower, at + qLower.length)) {
      out.push([at, at + qLower.length]);
    }
    return out;
  }
  // Some character lowercases to more units: compare code point by code point so offsets
  // stay those of `text`.
  for (let i = 0; i < text.length; ) {
    let j = i;
    let k = 0;
    while (k < qPoints.length && j < text.length) {
      const p = pointAt(text, j);
      if (lowerPoint(p) !== qPoints[k]) break;
      j += p.length;
      k++;
    }
    if (k === qPoints.length) {
      out.push([i, j]);
      i = j;
    } else i += pointAt(text, i).length;
  }
  return out;
}

/** Non-overlapping matches of `query` in each line, case-insensitive unless `matchCase`;
 * offsets index the line. */
export function findMatches(lines: string[], query: string, matchCase = false): Match[] {
  if (!query) return [];
  if (matchCase) {
    const out: Match[] = [];
    lines.forEach((text, line) => {
      for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + query.length)) {
        out.push({ line, start: at, end: at + query.length });
      }
    });
    return out;
  }
  const qPoints = Array.from(query, lowerPoint);
  const qLower = query.toLowerCase();
  const out: Match[] = [];
  lines.forEach((text, line) => {
    for (const [start, end] of matchRanges(text, qLower, qPoints)) out.push({ line, start, end });
  });
  return out;
}
