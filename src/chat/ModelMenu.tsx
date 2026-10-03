import { useEffect } from "react";
import type { ChatMeta } from "../lib/types";

// Claude Code's `/model` aliases and `/effort` levels (2.1.288); each takes its argument
// without opening a picker in the terminal.
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku"];
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Claude's model and effort, picked from the Composer's label. Opens above `anchor`, since
 * the Composer sits at the bottom of the Chat lens; `onPick` gets the Slash command to send.
 */
export function ModelMenu({
  anchor,
  meta,
  onPick,
  onClose,
}: {
  anchor: DOMRect;
  meta?: ChatMeta;
  onPick: (command: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const item = (label: string, checked: boolean, command: string) => (
    <li key={command} role="none">
      <button
        role="menuitemradio"
        aria-checked={checked}
        onClick={() => {
          onClose();
          onPick(command);
        }}
      >
        {label}
      </button>
    </li>
  );

  return (
    <div className="overlay clear" onMouseDown={onClose}>
      <ul
        className="ctx-menu model-menu"
        role="menu"
        aria-label="Model and effort"
        style={{ right: window.innerWidth - anchor.right, bottom: window.innerHeight - anchor.top + 6 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <li role="presentation" className="model-menu-heading">Model</li>
        {CLAUDE_MODELS.map((m) => item(m, !!meta?.model?.includes(m), `/model ${m}`))}
        <li role="separator" className="model-menu-sep" />
        <li role="presentation" className="model-menu-heading">Effort</li>
        {CLAUDE_EFFORTS.map((e) => item(e, meta?.effort === e, `/effort ${e}`))}
      </ul>
    </div>
  );
}
