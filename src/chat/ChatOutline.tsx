import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { OutlineEntry } from "./outline";
import { clampOutlineWidth, loadOutlineWidth, OUTLINE_DEFAULT, OUTLINE_MAX, OUTLINE_MIN, saveOutlineWidth } from "./outlineWidth";

/** The rail beside a wide chat: one line per user turn, the one being read highlighted. */
export function ChatOutline({ entries, current, onJump }: { entries: OutlineEntry[]; current: number; onJump: (row: number) => void }) {
  const listRef = useRef<HTMLOListElement>(null);
  const [width, setWidth] = useState(loadOutlineWidth);
  // Where a drag of the left edge began: the rail sits at the right, so moving left widens it.
  const drag = useRef<{ x: number; width: number } | null>(null);
  // Keep the highlighted turn in the rail's own view as the chat scrolls past it.
  useEffect(() => {
    const el = listRef.current?.children[current]?.firstElementChild as HTMLElement | null | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  if (entries.length < 2) return null;

  const resize = (px: number) => {
    const w = clampOutlineWidth(px);
    setWidth(w);
    return w;
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) resize(drag.current.width + drag.current.x - e.clientX);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    saveOutlineWidth(resize(drag.current.width + drag.current.x - e.clientX));
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? 16 : e.key === "ArrowRight" ? -16 : 0;
    if (step === 0) return;
    e.preventDefault();
    saveOutlineWidth(resize(width + step));
  };

  return (
    <nav className="chat-outline" aria-label="Conversation outline" style={{ width }}>
      <div
        className="chat-outline-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize outline"
        aria-valuemin={OUTLINE_MIN}
        aria-valuemax={OUTLINE_MAX}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => saveOutlineWidth(resize(OUTLINE_DEFAULT))}
        onKeyDown={onKeyDown}
      />
      <div className="chat-outline-head">Outline</div>
      <ol ref={listRef}>
        {entries.map((e, i) => (
          <li key={e.key}>
            <button type="button" title={e.label} aria-current={i === current ? "true" : undefined} onClick={() => onJump(e.row)}>
              {e.label}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
