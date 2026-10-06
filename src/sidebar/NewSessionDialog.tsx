import { useState } from "react";
import { sessionStart } from "../lib/ipc";
import { useApp } from "../store/app";
import { moveNode, sessionKey, useLayout } from "./groups";

/** The backend's rule for a session name (`valid_session_name` in machines.rs). */
const VALID = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

function problem(name: string, existing: readonly string[]): string | null {
  if (!name) return null;
  if (!VALID.test(name)) return "Use letters, digits, '.', '_' or '-', not starting with '-'.";
  if (existing.includes(name)) return `Session "${name}" already exists.`;
  return null;
}

/** Without `machineId` the dialog offers a picker over the connected machines; with `groupId` the
 *  new session is placed into that group. */
export function NewSessionDialog({
  machineId: fixed,
  groupId,
  onClose,
  onError,
}: {
  machineId?: string;
  groupId?: string;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const machines = useApp((s) => s.machines);
  const order = useApp((s) => s.order);
  const connected = order.filter((id) => machines[id]?.state === "connected");
  const [picked, setPicked] = useState(() => connected[0] ?? "");
  // Falls back to a connected machine when the picked one drops while the dialog is open.
  const machineId = fixed ?? (connected.includes(picked) ? picked : connected[0] ?? "");
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const existing = machines[machineId]?.sessions.map((s) => s.name) ?? [];
  const error = problem(trimmed, existing);
  const ok = machineId !== "" && trimmed !== "" && !error;
  const create = async () => {
    onClose();
    try {
      await sessionStart(machineId, trimmed);
      if (groupId) {
        const key = sessionKey(machineId, trimmed);
        useLayout.getState().update((l) => moveNode(l, { kind: "session", key }, { kind: "into", groupId }, [key]));
      }
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
        {fixed === undefined && (
          <label>
            Machine
            <select value={machineId} onChange={(e) => setPicked(e.target.value)}>
              {connected.map((id) => (
                <option key={id} value={id}>{machines[id].label}</option>
              ))}
            </select>
          </label>
        )}
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
