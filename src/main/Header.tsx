import { useShallow } from "zustand/react/shallow";
import { StatusDot } from "../sidebar/StatusDot";
import { selectedPane, useApp } from "../store/app";
import type { Lens } from "../store/app";
import { paneKey } from "../lib/types";

export function Header() {
  const sel = useApp(useShallow(selectedPane));
  const lens = useApp((s) => (s.selected ? s.lens[paneKey(s.selected)] : undefined)) ?? "terminal";
  const setLens = useApp((s) => s.setLens);
  if (!sel) return null;
  const key = paneKey({ machine_id: sel.machine.id, session: sel.session.name, pane_id: sel.pane.pane_id });
  const crumbs = [sel.machine.label, sel.session.name, sel.workspace.label, sel.pane.title];
  return (
    <header className="header">
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i}>
            {i > 0 && <span className="sep"> › </span>}
            {c}
          </span>
        ))}
      </nav>
      <div className="agent-status">
        <StatusDot status={sel.pane.status} />
        <span>{sel.pane.agent ?? "no agent"} · {sel.pane.status}</span>
      </div>
      <div className="seg" role="group" aria-label="Lens">
        {(["terminal", "chat"] as Lens[]).map((l) => (
          <button key={l} aria-pressed={lens === l} onClick={() => setLens(key, l)}>
            {l === "terminal" ? "Terminal" : "Chat"}
          </button>
        ))}
      </div>
    </header>
  );
}
