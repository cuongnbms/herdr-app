import { useEffect, useRef } from "react";
import type { OutlineEntry } from "./outline";

/** The rail beside a wide chat: one line per user turn, the one being read highlighted. */
export function ChatOutline({ entries, current, onJump }: { entries: OutlineEntry[]; current: number; onJump: (row: number) => void }) {
  const listRef = useRef<HTMLOListElement>(null);
  // Keep the highlighted turn in the rail's own view as the chat scrolls past it.
  useEffect(() => {
    const el = listRef.current?.children[current]?.firstElementChild as HTMLElement | null | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  if (entries.length < 2) return null;
  return (
    <nav className="chat-outline" aria-label="Conversation outline">
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
