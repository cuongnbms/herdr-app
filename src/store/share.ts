// Structural sharing for plain JSON values (views from the backend): returns `next`, but with
// every subtree that deep-equals its counterpart in `prev` replaced by `prev`'s object, so an
// unchanged Pane, Tab or Workspace keeps its identity and its selectors and memos stay quiet.
export function shareEqual<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (typeof prev !== "object" || typeof next !== "object" || prev === null || next === null) return next;
  if (Array.isArray(prev) !== Array.isArray(next)) return next;
  if (Array.isArray(prev)) {
    const p = prev as unknown[];
    const n = next as unknown[];
    const out = n.map((v, i) => (i < p.length ? shareEqual(p[i], v) : v));
    return (out.length === p.length && out.every((v, i) => v === p[i]) ? prev : out) as T;
  }
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const keys = Object.keys(n);
  let same = keys.length === Object.keys(p).length;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = k in p ? shareEqual(p[k], n[k]) : n[k];
    if (out[k] !== p[k] || !(k in p)) same = false;
  }
  return (same ? prev : out) as T;
}
