import Markdown from "react-markdown";
import { paneKey, type PaneRef } from "../lib/types";
import { closeSide, setBtwMode, stopSide, useBtw } from "./btw";
import { mdComponents, rehypePlugins, remarkPlugins } from "./markdown";

/** The Pane's side-question thread, above the Composer. Nothing without one. */
export function BtwCard({ pane }: { pane: PaneRef }) {
  const key = paneKey(pane);
  const thread = useBtw((s) => s.threads[key]);
  if (!thread) return null;
  const running = thread.turns[thread.turns.length - 1]?.running ?? false;
  return (
    <div className="btw-card">
      {thread.turns.map((t, i) => (
        <div key={i} className="btw-turn">
          <div className="btw-q">btw ▸ {t.q}</div>
          {t.tools.map((name, j) => (
            <div key={j} className="btw-tool">⚙ {name}</div>
          ))}
          {t.a !== "" && (
            <div className="btw-a">
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
