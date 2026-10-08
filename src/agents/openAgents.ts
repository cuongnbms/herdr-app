import { paneKey, type MachineView, type PaneRef } from "../lib/types";
import type { CloseScope } from "../files/store";

/** The agent panes the user has opened, across every machine and session, in the order opened. */
export interface AgentTabs {
  tabs: PaneRef[];
  /** The paneKey of the one tab (if any) that the next unpinned open replaces. */
  preview: string | null;
}

export const NO_TABS: AgentTabs = { tabs: [], preview: null };

const indexOf = (tabs: PaneRef[], ref: PaneRef) => {
  const key = paneKey(ref);
  return tabs.findIndex((t) => paneKey(t) === key);
};

/** Opens `ref`'s tab: pinned, or as the preview, replacing the current preview tab. */
export function openTab(s: AgentTabs, ref: PaneRef, { pin }: { pin: boolean }): AgentTabs {
  const key = paneKey(ref);
  if (indexOf(s.tabs, ref) >= 0) return pin && s.preview === key ? { ...s, preview: null } : s;
  // A pinned open promotes the current preview, so it stays.
  if (pin) return { tabs: [...s.tabs, ref], preview: null };
  const at = s.preview ? s.tabs.findIndex((t) => paneKey(t) === s.preview) : -1;
  const tabs = at >= 0 ? s.tabs.map((t, i) => (i === at ? ref : t)) : [...s.tabs, ref];
  return { tabs, preview: key };
}

/** Closes tabs relative to `ref`'s; an unknown pane closes nothing. */
export function closeTabs(s: AgentTabs, scope: "one" | CloseScope, ref: PaneRef): AgentTabs {
  const at = indexOf(s.tabs, ref);
  if (at < 0) return s;
  const tabs =
    scope === "one" ? s.tabs.filter((_, i) => i !== at) : scope === "others" ? [s.tabs[at]] : scope === "right" ? s.tabs.slice(0, at + 1) : [];
  return { tabs, preview: keepPreview(tabs, s.preview) };
}

/** Drops the panes of machine `v` that its snapshot no longer has; other machines' are kept. */
export function pruneTabs(s: AgentTabs, v: MachineView): AgentTabs {
  const live = new Set<string>();
  for (const session of v.sessions)
    for (const w of session.workspaces)
      for (const t of w.tabs) for (const p of t.panes) live.add(paneKey({ machine_id: v.id, session: session.name, pane_id: p.pane_id }));
  return dropTabs(s, (t) => t.machine_id === v.id && !live.has(paneKey(t)));
}

/** Drops the tabs `gone` matches, keeping `s` itself when it matches none. */
export function dropTabs(s: AgentTabs, gone: (t: PaneRef) => boolean): AgentTabs {
  const tabs = s.tabs.filter((t) => !gone(t));
  return tabs.length === s.tabs.length ? s : { tabs, preview: keepPreview(tabs, s.preview) };
}

const keepPreview = (tabs: PaneRef[], preview: string | null) => (preview && tabs.some((t) => paneKey(t) === preview) ? preview : null);
