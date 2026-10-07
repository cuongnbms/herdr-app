import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store/app";
import { StatusDot } from "../sidebar/StatusDot";
import { search } from "./search";
import { SearchIcon } from "../ui/icons";

export function Palette({ onClose }: { onClose: () => void }) {
  const machines = useApp((s) => s.machines);
  const order = useApp((s) => s.order);
  const since = useApp((s) => s.statusSince);
  const select = useApp((s) => s.select);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(
    () => search(order.flatMap((id) => (machines[id] ? [machines[id]] : [])), query, since),
    [machines, order, query, since],
  );
  useEffect(() => input.current?.focus(), []);
  const choose = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    select(hit.ref);
    onClose();
  };
  const active = Math.min(index, Math.max(hits.length - 1, 0));
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <SearchIcon />
          <input
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            ref={input}
            value={query}
            placeholder="Jump to pane…"
            aria-label="Search panes"
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(active);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex(Math.min(active + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex(Math.max(active - 1, 0));
              }
            }}
          />
        </div>
        <ul role="listbox">
          {hits.map((h, i) => (
            <li key={`${h.ref.machine_id}/${h.ref.session}/${h.ref.pane_id}`} role="option" aria-selected={i === active}>
              <button className={"hit" + (i === active ? " active" : "")} onClick={() => choose(i)}>
                <StatusDot status={h.status} />
                <span className="title mono">{h.title}</span>
                {h.agent && <span className="agent">{h.agent}</span>}
                <span className="subtitle">{h.subtitle}</span>
              </button>
            </li>
          ))}
          {hits.length === 0 && <li className="empty">No matching panes</li>}
        </ul>
        <div className="palette-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
