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

/**
 * The best of the greedy scan from `from` and scans whose first character sits on a later
 * segment boundary (`a_ab` matches `ab` at the second `a`). At most `q.length` extra
 * scans, so O(path length · query length).
 */
function bestScan(q: string, path: string, lower: string, from: number): number | null {
  let best = scan(q, path, lower, from);
  if (best === null) return null;
  const first = lower.indexOf(q[0], from);
  let tries = q.length;
  for (let i = lower.indexOf(q[0], first + 1); i >= 0 && tries > 0; i = lower.indexOf(q[0], i + 1)) {
    if (!isBoundary(path, i)) continue;
    tries--;
    const s = scan(q, path, lower, i);
    if (s === null) break; // a later start cannot match either
    if (s > best) best = s;
  }
  return best;
}

/** `fuzzyScore` for a query that is already lowercase. */
function scoreLower(q: string, path: string): number | null {
  if (q === "") return 0;
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const inName = bestScan(q, path, lower, nameStart);
  const whole = bestScan(q, path, lower, 0);
  if (inName === null) return whole;
  return Math.max(inName + 10, whole ?? 0);
}

/** Case-insensitive subsequence score; null when `query` does not match. */
export function fuzzyScore(query: string, path: string): number | null {
  return scoreLower(query.toLowerCase(), path);
}

export function rankFiles(query: string, paths: string[], recent: string[], limit: number): string[] {
  if (query === "") {
    const known = new Set(paths);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...recent, ...paths]) {
      if (out.length >= limit) break;
      if (seen.has(p) || !known.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  }
  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const score = scoreLower(q, path);
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
