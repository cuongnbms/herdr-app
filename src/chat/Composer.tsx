import { useState } from "react";
import { herdrCall } from "../lib/ipc";
import type { PaneRef } from "../lib/types";
import { SendIcon } from "../ui/icons";

// Key names verified against herdr's key parser (pane.send_keys accepts esc, ctrl+c,
// shift+tab, enter, up, down, 1; unknown names fail with `invalid_key`).
const KEYS: { label: string; key: string }[] = [
  { label: "Esc", key: "esc" },
  { label: "Ctrl+C", key: "ctrl+c" },
  { label: "⇧Tab", key: "shift+tab" },
];

export function Composer({ pane }: { pane: PaneRef }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const call = (method: string, params: unknown) =>
    herdrCall(pane.machine_id, pane.session, method, params).then(
      () => setError(null),
      (e) => {
        console.error(method, "failed", e);
        setError(`Send failed: ${e?.message ?? String(e)}`);
        return Promise.reject(e);
      },
    );

  const send = () => {
    if (!text.trim()) return;
    const sent = text;
    setText("");
    // Optimistic clear; restore the text if the prompt did not go through (unless the user typed meanwhile).
    call("agent.prompt", { target: pane.pane_id, text: sent }).catch(() => setText((cur) => (cur === "" ? sent : cur)));
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          value={text}
          rows={2}
          placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-keys">
            {KEYS.map((k) => (
              <button key={k.key} className="keycap" onClick={() => call("agent.send_keys", { target: pane.pane_id, keys: [k.key] }).catch(() => {})}>
                {k.label}
              </button>
            ))}
          </div>
          <button className="send" aria-label="Send" disabled={!text.trim()} onClick={send}>
            <SendIcon />
          </button>
        </div>
      </div>
      {error && <div className="chat-error composer-error" role="alert">{error}</div>}
    </div>
  );
}
