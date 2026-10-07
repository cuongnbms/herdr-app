import { useState } from "react";
import { ChevronIcon } from "../ui/icons";
import { OUTLINE_DEFAULT, useOutline } from "./outlineStore";

export interface Heading {
  id: string;
  level: number;
  text: string;
}

const LEVELS = [1, 2, 3];

/** Dragging the outline's left edge widens it, since it sits to the right of the document. */
function startResize(e: React.MouseEvent) {
  e.preventDefault();
  const { width: w0, setWidth } = useOutline.getState();
  const x0 = e.clientX;
  let w = w0;
  const move = (ev: MouseEvent) => {
    w = w0 + x0 - ev.clientX;
    setWidth(w);
  };
  const up = () => {
    setWidth(w, true);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

export function Outline({ items, activeId, onSelect }: { items: Heading[]; activeId: string | null; onSelect(id: string): void }) {
  const width = useOutline((s) => s.width);
  const setWidth = useOutline((s) => s.setWidth);
  // Keyed by position, since a heading's id can repeat only if the document changes under it.
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const minLevel = Math.min(...items.map((h) => h.level));
  const toggle = (i: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  // A heading's parent is the nearest earlier heading of a shallower level; it is hidden when any ancestor is collapsed.
  const ancestors: { level: number; collapsed: boolean }[] = [];
  const rows = items.map((h, i) => {
    while (ancestors.length && ancestors[ancestors.length - 1].level >= h.level) ancestors.pop();
    const hidden = ancestors.some((a) => a.collapsed);
    const isCollapsed = collapsed.has(i);
    ancestors.push({ level: h.level, collapsed: isCollapsed });
    const hasChildren = (items[i + 1]?.level ?? 0) > h.level;
    return { h, i, hidden, isCollapsed, hasChildren };
  });

  // Shows headings down to `level`: each heading at that level or deeper folds its subtree, shallower ones unfold.
  const collapseTo = (level: number) =>
    setCollapsed(new Set(rows.filter((r) => r.hasChildren && r.h.level - minLevel + 1 >= level).map((r) => r.i)));

  return (
    <>
      <div
        className="files-outline-resize"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize, double-click to reset"
        onMouseDown={startResize}
        onDoubleClick={() => setWidth(OUTLINE_DEFAULT, true)}
      />
      <nav className="files-outline" aria-label="Outline" style={{ width }}>
        <div className="files-outline-head">
          <span className="files-outline-title">Outline</span>
          {LEVELS.map((n) => (
            <button key={n} type="button" title={`Show up to H${n}`} aria-label={`Show up to H${n}`} onClick={() => collapseTo(n)}>
              H{n}
            </button>
          ))}
        </div>
        <ul>
          {rows
            .filter((r) => !r.hidden)
            .map(({ h, i, isCollapsed, hasChildren }) => (
              <li
                key={i}
                aria-label={h.text}
                aria-current={h.id === activeId ? "true" : undefined}
                style={{ paddingLeft: 4 + (h.level - minLevel) * 12 }}
                title={h.text}
                onClick={() => onSelect(h.id)}
              >
                {hasChildren ? (
                  <span
                    className={"files-outline-toggle" + (isCollapsed ? "" : " open")}
                    role="button"
                    aria-label={isCollapsed ? "Expand" : "Collapse"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(i);
                    }}
                  >
                    <ChevronIcon />
                  </span>
                ) : (
                  <span className="files-outline-toggle" />
                )}
                <span className="files-outline-text">{h.text}</span>
              </li>
            ))}
        </ul>
      </nav>
    </>
  );
}
