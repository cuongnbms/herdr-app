import { paneKey, type AgentStatus, type MachineView, type PaneRef } from "../lib/types";

export interface PaneHit {
  ref: PaneRef;
  title: string;
  /** "machine › session › workspace" */
  subtitle: string;
  agent: string | null;
  status: AgentStatus;
}

/** Index of the first matched character if `q` is a subsequence of `text`, else -1. */
function subsequence(text: string, q: string): number {
  if (q === "") return 0;
  let first = -1;
  let from = 0;
  for (const ch of q) {
    const i = text.indexOf(ch, from);
    if (i < 0) return -1;
    if (first < 0) first = i;
    from = i + 1;
  }
  return first;
}

/** Panes matching `query`, by status (blocked, done, working, idle, the rest), then newest status
 *  change first (`since`, by paneKey), then panes with no known time; ties by match position, then sidebar order. */
export function search(machines: MachineView[], query: string, since: Record<string, number> = {}): PaneHit[] {
  const q = query.trim().toLowerCase();
  const scored: { hit: PaneHit; pos: number }[] = [];
  for (const m of machines) {
    for (const s of m.sessions) {
      for (const w of s.workspaces) {
        for (const t of w.tabs) {
          for (const p of t.panes) {
            const hay = [p.title, p.agent ?? "", p.cwd ?? "", w.label].join(" ").toLowerCase();
            const pos = subsequence(hay, q);
            if (pos < 0) continue;
            scored.push({
              pos,
              hit: {
                ref: { machine_id: m.id, session: s.name, pane_id: p.pane_id },
                title: p.title,
                subtitle: `${m.label} › ${s.name} › ${w.label}`,
                agent: p.agent,
                status: p.status,
              },
            });
          }
        }
      }
    }
  }
  const RANK: Partial<Record<AgentStatus, number>> = { blocked: 0, done: 1, working: 2, idle: 3 };
  const rank = (h: PaneHit) => RANK[h.status] ?? 4;
  const time = (h: PaneHit) => since[paneKey(h.ref)] ?? 0;
  return scored
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => rank(a.hit) - rank(b.hit) || time(b.hit) - time(a.hit) || a.pos - b.pos || a.i - b.i)
    .map((x) => x.hit);
}
