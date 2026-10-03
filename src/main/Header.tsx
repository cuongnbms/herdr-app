import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { StatusDot } from "../sidebar/StatusDot";
import { chosenLens, selectedPane, useApp } from "../store/app";
import type { Lens } from "../store/app";
import { paneKey } from "../lib/types";
import { defaultLens } from "../lens";
import { ChatIcon, TerminalIcon } from "../ui/icons";

// Takes no props: memo keeps it out of App's re-renders; it reads the store itself.
export const Header = memo(function Header() {
  const sel = useApp(useShallow(selectedPane));
  const remembered = useApp((s) => (s.selected ? chosenLens(s, paneKey(s.selected)) : undefined));
  const setLens = useApp((s) => s.setLens);
  if (!sel) return null;
  const lens = defaultLens(sel.pane, remembered);
  const key = paneKey({ machine_id: sel.machine.id, session: sel.session.name, pane_id: sel.pane.pane_id });
  const crumbs = [sel.machine.label, sel.session.name, sel.workspace.label, sel.pane.title];
  return (
    <header className="header" data-tauri-drag-region>
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i} className={i === crumbs.length - 1 ? "crumb current" : "crumb"}>
            {i > 0 && <span className="sep"> › </span>}
            {c}
          </span>
        ))}
      </nav>
      <div className={`agent-status status-${sel.pane.status}`}>
        <StatusDot status={sel.pane.status} />
        <span>{sel.pane.agent ?? "no agent"} · {sel.pane.status}</span>
      </div>
      <div className={"seg" + (lens === "chat" ? " seg-right" : "")} role="group" aria-label="Lens">
        <span className="seg-thumb" aria-hidden="true" />
        {(["terminal", "chat"] as Lens[]).map((l) => (
          <button key={l} aria-pressed={lens === l} onClick={() => setLens(key, l)}>
            {l === "terminal" ? <TerminalIcon /> : <ChatIcon />}
            {l === "terminal" ? "Terminal" : "Chat"}
          </button>
        ))}
      </div>
    </header>
  );
});
