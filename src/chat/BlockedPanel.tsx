import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import "../fonts/fonts.css";
import { herdrCall } from "../lib/ipc";
import { paneKey, type PaneRef, type PaneView } from "../lib/types";
import { useApp } from "../store/app";
import { watchTermFont } from "../settings/store";
import { TERM_THEME } from "../terminal/theme";

const QUICK: { label: string; key: string }[] = [
  { label: "1", key: "1" },
  { label: "2", key: "2" },
  { label: "3", key: "3" },
  { label: "Enter", key: "enter" },
  { label: "Esc", key: "esc" },
  { label: "↑", key: "up" },
  { label: "↓", key: "down" },
];

interface ReadResult {
  text?: string;
  read?: { text?: string };
}

export function BlockedPanel({ pane, view }: { pane: PaneRef; view: PaneView }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setLens = useApp((s) => s.setLens);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      scrollback: 200,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const unwatchFont = watchTermFont(term, fit, -1);
    term.open(host);
    termRef.current = term;
    try {
      fit.fit();
    } catch {
      /* not measurable yet */
    }
    return () => {
      termRef.current = null;
      unwatchFont();
      term.dispose();
    };
  }, []);

  // Refetch the visible screen on mount and on every status update.
  useEffect(() => {
    let live = true;
    herdrCall<ReadResult>(pane.machine_id, pane.session, "pane.read", {
      pane_id: pane.pane_id,
      source: "visible",
      format: "ansi",
      strip_ansi: false,
    })
      .then((r) => {
        const text = r?.text ?? r?.read?.text ?? "";
        if (live && termRef.current) {
          termRef.current.reset();
          termRef.current.write(text.replace(/\r?\n/g, "\r\n"));
        }
      })
      .catch((e) => console.error("pane.read failed", e));
    return () => {
      live = false;
    };
  }, [pane.machine_id, pane.session, pane.pane_id, view.status, view.title]);

  const sendKey = (key: string) =>
    void herdrCall(pane.machine_id, pane.session, "agent.send_keys", { target: pane.pane_id, keys: [key] }).then(
      () => setError(null),
      (e) => {
        console.error("send_keys failed", e);
        setError(`Send failed: ${e?.message ?? String(e)}`);
      },
    );

  return (
    <div className="blocked-panel">
      <div className="blocked-head">
        <span className="dot dot-blocked" aria-hidden="true" />
        The agent is waiting for input
      </div>
      <div className="blocked-screen" ref={hostRef} />
      {error && <div className="chat-error" role="alert">{error}</div>}
      <div className="blocked-keys">
        {QUICK.map((k) => (
          <button key={k.key} className="keycap" onClick={() => sendKey(k.key)}>
            {k.label}
          </button>
        ))}
        <button className="btn btn-xs blocked-open" onClick={() => setLens(paneKey(pane), "terminal")}>
          Open Terminal lens
        </button>
      </div>
    </div>
  );
}
