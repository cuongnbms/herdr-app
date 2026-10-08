import { memo, useState } from "react";
import { createPortal } from "react-dom";
import { ContextMenu, type MenuItem } from "../sidebar/ContextMenu";
import { StatusDot } from "../sidebar/StatusDot";
import { useApp } from "../store/app";
import { paneKey, type MachineView, type PaneRef, type PaneView } from "../lib/types";
import { CloseIcon } from "../ui/icons";

interface Entry {
  ref: PaneRef;
  key: string;
  pane: PaneView;
  /** Where the pane lives: machine, session and workspace. */
  place: string;
}

function entries(machines: Record<string, MachineView>, refs: PaneRef[]): Entry[] {
  return refs.flatMap((ref) => {
    const machine = machines[ref.machine_id];
    for (const w of machine?.sessions.find((s) => s.name === ref.session)?.workspaces ?? [])
      for (const t of w.tabs)
        for (const pane of t.panes)
          if (pane.pane_id === ref.pane_id) return [{ ref, key: paneKey(ref), pane, place: `${machine.label}/${ref.session} · ${w.label}` }];
    return [];
  });
}

/** The agent panes opened in any session, like an editor's open files. */
export const AgentTabs = memo(function AgentTabs() {
  const machines = useApp((s) => s.machines);
  const { tabs: refs, preview } = useApp((s) => s.agentTabs);
  const selKey = useApp((s) => (s.selected ? paneKey(s.selected) : null));
  const select = useApp((s) => s.select);
  const pin = useApp((s) => s.pinAgentTab);
  const closeTabs = useApp((s) => s.closeAgentTabs);
  const [menu, setMenu] = useState<{ x: number; y: number; ref: PaneRef } | null>(null);
  const tabs = entries(machines, refs);
  if (tabs.length === 0) return null;

  const close = (ref: PaneRef) => closeTabs(ref, "one");
  // Commands that would close nothing are left out.
  const menuItems = (ref: PaneRef): MenuItem[] => {
    const at = tabs.findIndex((e) => e.key === paneKey(ref));
    const items: MenuItem[] = [{ label: "Close", icon: CloseIcon, onSelect: () => close(ref) }];
    if (tabs.length > 1) items.push({ label: "Close Others", icon: CloseIcon, onSelect: () => closeTabs(ref, "others") });
    if (at < tabs.length - 1) items.push({ label: "Close to the Right", icon: CloseIcon, onSelect: () => closeTabs(ref, "right") });
    items.push({ label: "Close All", icon: CloseIcon, onSelect: () => closeTabs(ref, "all") });
    return items;
  };

  return (
    <div className="files-tabs agent-tabs" role="tablist" aria-label="Open agents">
      {tabs.map(({ ref, key, pane, place }) => {
        const active = key === selKey;
        const state = `${active ? " active" : ""}${key === preview ? " preview" : ""}`;
        return (
          // The tab and its close button are siblings: a tab must not contain another control.
          <div
            key={key}
            role="none"
            title={`${place} · ${pane.title}`}
            className={`files-tab-item${state}`}
            onClick={() => select(ref)}
            onDoubleClick={() => pin(ref)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, ref });
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                close(ref);
              }
            }}
          >
            <StatusDot status={pane.status} />
            <span
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`files-tab${state}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select(ref);
                }
              }}
            >
              <span className="files-tab-name">{pane.title}</span>
            </span>
            <button
              type="button"
              className="files-tab-close"
              aria-label={`Close ${pane.title}`}
              onClick={(e) => {
                e.stopPropagation();
                close(ref);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
      {/* Out of the tablist, and fixed to the window rather than to an animating ancestor. */}
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.ref)} onClose={() => setMenu(null)} />, document.body)}
    </div>
  );
});
