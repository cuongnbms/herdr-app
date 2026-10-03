import { useState } from "react";
import { sessionStart } from "../lib/ipc";
import { useApp } from "../store/app";

/** The backend's rule for a session name (`valid_session_name` in machines.rs). */
const VALID = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

function problem(name: string, existing: readonly string[]): string | null {
  if (!name) return null;
  if (!VALID.test(name)) return "Use letters, digits, '.', '_' or '-', not starting with '-'.";
  if (existing.includes(name)) return `Session "${name}" already exists.`;
  return null;
}

export function NewSessionDialog({
  machineId,
  existing,
  onClose,
  onError,
}: {
  machineId: string;
  existing: readonly string[];
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const error = problem(trimmed, existing);
  const ok = trimmed !== "" && !error;
  const create = async () => {
    onClose();
    try {
      await sessionStart(machineId, trimmed);
      useApp.getState().view({ machine_id: machineId, session: trimmed });
    } catch (e) {
      onError((e as { message?: string }).message ?? String(e));
    }
  };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-label="New session"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void create();
        }}
      >
        <h3>New session</h3>
        <label>
          Name
          <input spellCheck={false} autoCorrect="off" autoCapitalize="off" autoFocus value={name} placeholder="my-project" onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p className="error dialog-error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!ok}>Create</button>
        </div>
      </form>
    </div>
  );
}
