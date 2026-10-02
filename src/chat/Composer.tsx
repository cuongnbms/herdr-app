import { useState } from "react";
import { herdrCall } from "../lib/ipc";
import type { PaneRef } from "../lib/types";

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
      {error && <div className="chat-error composer-error" role="alert">{error}</div>}
      <div className="composer-keys">
        {KEYS.map((k) => (
          <button key={k.key} onClick={() => call("agent.send_keys", { target: pane.pane_id, keys: [k.key] }).catch(() => {})}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
