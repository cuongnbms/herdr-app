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
  const call = (method: string, params: unknown) =>
    herdrCall(pane.machine_id, pane.session, method, params).catch((e) => console.error(method, "failed", e));

  const send = () => {
    if (!text.trim()) return;
    void call("agent.prompt", { target: pane.pane_id, text });
    setText("");
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
      <div className="composer-keys">
        {KEYS.map((k) => (
          <button key={k.key} onClick={() => void call("agent.send_keys", { target: pane.pane_id, keys: [k.key] })}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
