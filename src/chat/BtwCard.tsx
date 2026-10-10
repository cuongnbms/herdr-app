import { useEffect, useLayoutEffect, useRef } from "react";
import Markdown from "react-markdown";
import { paneKey, type PaneRef } from "../lib/types";
import { closeSide, stopSide, useBtw } from "./btw";
import { CopyButton } from "./CopyButton";
import { mdComponents, rehypePlugins, remarkPlugins } from "./markdown";

/**
 * The Pane's side-question thread, above the Composer. Nothing without one. A header with Stop and
 * Close stays put while the turns scroll below it.
 */
export function BtwCard({ pane }: { pane: PaneRef }) {
  const key = paneKey(pane);
  const thread = useBtw((s) => s.threads[key]);
  const body = useRef<HTMLDivElement>(null);
  // Whether the turns are scrolled to (within 24px of) its bottom; a streaming answer follows only then.
  const atBottom = useRef(true);
  const count = thread?.turns.length ?? 0;
  const last = thread?.turns[count - 1];
  // A new turn, the last thing in the card, comes into view by scrolling the turns to their bottom.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
  }, [count]);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && last?.running && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [last?.a, last?.tools.length, last?.running]);
  if (!thread) return null;
  const running = last?.running ?? false;
  return (
    <div className="btw-card">
      <div className="btw-head">
        <span className="btw-tag">btw</span>
        <span className="btw-title">Side question · not in the Transcript</span>
        {running && (
          <button className="btw-stop" onClick={() => void stopSide(key)}>
            Stop
          </button>
        )}
        <button className="btw-close" aria-label="Close" title="Close" onClick={() => void closeSide(pane)}>
          ×
        </button>
      </div>
      <div
        className="btw-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
        }}
      >
        {thread.turns.map((t, i) => (
          <div key={i} className="btw-turn">
            <div className="btw-q">{t.q}</div>
            {t.tools.length > 0 && (
              <div className="btw-tools">
                {t.tools.map((name, j) => (
                  <span key={j} className="btw-tool">{name}</span>
                ))}
              </div>
            )}
            {t.a !== "" && (
              <div className="btw-a chat-assistant">
                <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>{t.a}</Markdown>
                {!t.running && <CopyButton text={t.a} />}
              </div>
            )}
            {t.error && <div className="btw-error">{t.error}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
