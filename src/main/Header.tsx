import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { chosenLens, selectedPane, useApp } from "../store/app";
import type { Lens } from "../store/app";
import { paneKey } from "../lib/types";
import { defaultLens } from "../lens";
import { ChatIcon, SearchIcon, TerminalIcon } from "../ui/icons";

// Takes no props: memo keeps it out of App's re-renders; it reads the store itself.
export const Header = memo(function Header() {
  const sel = useApp(useShallow(selectedPane));
  const remembered = useApp((s) => (s.selected ? chosenLens(s, paneKey(s.selected)) : undefined));
  const setLens = useApp((s) => s.setLens);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  if (!sel) return null;
  const lens = defaultLens(sel.pane, remembered);
  const key = paneKey({ machine_id: sel.machine.id, session: sel.session.name, pane_id: sel.pane.pane_id });
  return (
    <header className="header" data-tauri-drag-region>
      <div className={"seg" + (lens === "chat" ? " seg-right" : "")} role="group" aria-label="Lens">
        <span className="seg-thumb" aria-hidden="true" />
        {(["terminal", "chat"] as Lens[]).map((l) => (
          <button
            key={l}
            aria-pressed={lens === l}
            disabled={l === "chat" && !sel.pane.agent}
            title={l === "chat" && !sel.pane.agent ? "No agent in this pane" : undefined}
            onClick={() => setLens(key, l)}
          >
            {l === "terminal" ? <TerminalIcon /> : <ChatIcon />}
            {l === "terminal" ? "Terminal" : "Chat"}
          </button>
        ))}
      </div>
      {/* The same as ⌘K. */}
      <button className="header-search" onClick={() => setPaletteOpen(true)}>
        <SearchIcon />
        <span className="header-search-label">Search panes…</span>
        <kbd aria-hidden="true">⌘K</kbd>
      </button>
    </header>
  );
});
