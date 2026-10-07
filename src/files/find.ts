export type Match = { line: number; start: number; end: number };

/** Case-insensitive, non-overlapping matches of `query` in each line. */
export function findMatches(lines: string[], query: string): Match[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const out: Match[] = [];
  lines.forEach((text, line) => {
    const hay = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(q, from);
      if (at < 0) break;
      out.push({ line, start: at, end: at + q.length });
      from = at + q.length;
    }
  });
  return out;
}
