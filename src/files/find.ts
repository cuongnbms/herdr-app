export type Match = { line: number; start: number; end: number };

/** One UTF-16 unit lowercased, kept as is when lowercasing would change its length (`İ`). */
function lowerUnit(ch: string): string {
  const l = ch.toLowerCase();
  return l.length === ch.length ? l : ch;
}

/** Start offsets (in `text`) of non-overlapping case-insensitive matches of `q` (lowercase units). */
function matchStarts(text: string, q: string[], qJoined: string): number[] {
  const out: number[] = [];
  const hay = text.toLowerCase();
  if (hay.length === text.length) {
    // Lowercasing kept every offset, so search the lowered text directly.
    for (let at = hay.indexOf(qJoined); at >= 0; at = hay.indexOf(qJoined, at + q.length)) out.push(at);
    return out;
  }
  // Some character lowercases to more units: compare unit by unit so offsets stay those of `text`.
  for (let i = 0; i + q.length <= text.length; ) {
    let j = 0;
    while (j < q.length && lowerUnit(text[i + j]) === q[j]) j++;
    if (j === q.length) {
      out.push(i);
      i += q.length;
    } else i++;
  }
  return out;
}

/** Case-insensitive, non-overlapping matches of `query` in each line; offsets index the line. */
export function findMatches(lines: string[], query: string): Match[] {
  if (!query) return [];
  const q = Array.from({ length: query.length }, (_, i) => lowerUnit(query[i]));
  const qJoined = q.join("");
  const out: Match[] = [];
  lines.forEach((text, line) => {
    for (const start of matchStarts(text, q, qJoined)) out.push({ line, start, end: start + q.length });
  });
  return out;
}
