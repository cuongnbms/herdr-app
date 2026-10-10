import { useEffect, useLayoutEffect, useRef } from "react";
import Markdown from "react-markdown";
import { paneKey, type PaneRef } from "../lib/types";
import { closeSide, setBtwMode, stopSide, useBtw } from "./btw";
import { mdComponents, rehypePlugins, remarkPlugins } from "./markdown";

/** The Pane's side-question thread, above the Composer. Nothing without one. */
export function BtwCard({ pane }: { pane: PaneRef }) {
  const key = paneKey(pane);
  const thread = useBtw((s) => s.threads[key]);
  const card = useRef<HTMLDivElement>(null);
  // Whether the card is scrolled to (within 24px of) its bottom; a streaming answer follows only then.
  const atBottom = useRef(true);
  const count = thread?.turns.length ?? 0;
  const last = thread?.turns[count - 1];
  // A new turn, the last thing in the card, comes into view by scrolling the card to its bottom
  // (scrollIntoView would stop at the turn, above the actions row, and read as scrolled up).
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
  }, [count]);
  useLayoutEffect(() => {
    const el = card.current;
    if (el && last?.running && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [last?.a, last?.tools.length, last?.running]);
  if (!thread) return null;
  const running = last?.running ?? false;
  return (
    <div
      className="btw-card"
      ref={card}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
      }}
    >
      {thread.turns.map((t, i) => (
        <div key={i} className="btw-turn">
          <div className="btw-q">btw ▸ {t.q}</div>
          {t.tools.map((name, j) => (
            <div key={j} className="btw-tool">⚙ {name}</div>
          ))}
          {t.a !== "" && (
            <div className="btw-a chat-assistant">
              <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>{t.a}</Markdown>
            </div>
          )}
          {t.error && <div className="btw-error">{t.error}</div>}
        </div>
      ))}
      <div className="btw-actions">
        {running && <button onClick={() => void stopSide(key)}>Dừng</button>}
        <button onClick={() => setBtwMode(key, true)}>Hỏi tiếp</button>
        <button onClick={() => void closeSide(pane)}>Đóng</button>
      </div>
    </div>
  );
}
