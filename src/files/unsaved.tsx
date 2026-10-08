import { create } from "zustand";
import { Modal } from "../sidebar/ContextMenu";

export type UnsavedChoice = "save" | "discard" | "cancel";

interface Pending {
  names: string[];
  resolve: (choice: UnsavedChoice) => void;
}

const usePending = create<{ pending: Pending | null }>(() => ({ pending: null }));

/** Asks Save / Discard / Cancel for the named files. One ask at a time: a second while one is open resolves "cancel". */
export function askUnsaved(names: string[]): Promise<UnsavedChoice> {
  if (usePending.getState().pending) return Promise.resolve("cancel");
  return new Promise((resolve) => usePending.setState({ pending: { names, resolve } }));
}

export function UnsavedDialog() {
  const pending = usePending((s) => s.pending);
  if (!pending) return null;
  const { names, resolve } = pending;
  const answer = (choice: UnsavedChoice) => {
    usePending.setState({ pending: null });
    resolve(choice);
  };
  const many = names.length > 1;
  return (
    <Modal title="Unsaved Changes" onClose={() => answer("cancel")}>
      <p>{many ? `Save changes to ${names.length} files?` : `Save changes to "${names[0]}"?`}</p>
      {many && (
        <ul>
          {names.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button className="btn" onClick={() => answer("cancel")}>Cancel</button>
        <button className="btn" onClick={() => answer("discard")}>Discard</button>
        <button className="btn btn-primary" autoFocus onClick={() => answer("save")}>
          {many ? "Save All" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
