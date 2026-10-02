import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import "../fonts/fonts.css";
import { herdrCall } from "../lib/ipc";
import { paneKey, type PaneRef, type PaneView } from "../lib/types";
import { useApp } from "../store/app";

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
  const setLens = useApp((s) => s.setLens);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", Menlo, monospace',
      fontSize: 12,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 200,
      theme: { background: "#16171a", foreground: "#e4e5e8" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    try {
      fit.fit();
    } catch {
      /* not measurable yet */
    }
    return () => {
      termRef.current = null;
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
    void herdrCall(pane.machine_id, pane.session, "agent.send_keys", { target: pane.pane_id, keys: [key] }).catch((e) =>
      console.error("send_keys failed", e),
    );

  return (
    <div className="blocked-panel">
      <div className="blocked-head">The agent is waiting for input</div>
      <div className="blocked-screen" ref={hostRef} />
      <div className="blocked-keys">
        {QUICK.map((k) => (
          <button key={k.key} onClick={() => sendKey(k.key)}>
            {k.label}
          </button>
        ))}
        <button className="blocked-open" onClick={() => setLens(paneKey(pane), "terminal")}>
          Open Terminal lens
        </button>
      </div>
    </div>
  );
}
