const SEPARATORS = "/-_.";

function isBoundary(path: string, i: number): boolean {
  if (i === 0) return true;
  const prev = path[i - 1];
  if (SEPARATORS.includes(prev)) return true;
  const ch = path[i];
  return prev !== prev.toUpperCase() && ch !== ch.toLowerCase();
}

// Greedy left-to-right subsequence scan from `from`; O(path length).
function scan(q: string, path: string, lower: string, from: number): number | null {
  let score = 0;
  let prev = -2;
  let pos = from;
  for (let k = 0; k < q.length; k++) {
    const idx = lower.indexOf(q[k], pos);
    if (idx < 0) return null;
    score += 1;
    if (idx === prev + 1) score += 5;
    if (isBoundary(path, idx)) score += 8;
    prev = idx;
    pos = idx + 1;
  }
  return score;
}

/** Case-insensitive subsequence score; null when `query` does not match. */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase();
  if (q === "") return 0;
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const inName = scan(q, path, lower, nameStart);
  if (inName !== null) return inName + 10;
  return scan(q, path, lower, 0);
}

export function rankFiles(query: string, paths: string[], recent: string[], limit: number): string[] {
  if (query === "") {
    const known = new Set(paths);
    const head = recent.filter((p) => known.has(p));
    const seen = new Set(head);
    const out = head.slice(0, limit);
    for (const p of paths) {
      if (out.length >= limit) break;
      if (!seen.has(p)) out.push(p);
    }
    return out;
  }
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const score = fuzzyScore(query, path);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return scored.slice(0, limit).map((s) => s.path);
}
