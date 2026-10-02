import { useEffect, useState } from "react";
import { machineAdd, machineConnect, sshHosts } from "../lib/ipc";
import type { MachineView } from "../lib/types";
import { Modal } from "../sidebar/ContextMenu";

const message = (e: unknown) => (e as { message?: string } | null)?.message ?? String(e);

/** `onNeedAuth` is called when the first (batch) connect fails with `ssh_auth`: open the Connect dialog. */
export function AddMachineDialog({ onClose, onNeedAuth }: { onClose: () => void; onNeedAuth?: (machine: MachineView) => void }) {
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [herdrPath, setHerdrPath] = useState("");
  const [hosts, setHosts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    sshHosts()
      .then((h) => live && setHosts(h))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const typed = target.trim().toLowerCase();
  const suggestions = hosts.filter((h) => h.toLowerCase().includes(typed) && h.toLowerCase() !== typed).slice(0, 6);

  const add = async () => {
    if (!target.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const m = await machineAdd(target.trim(), label.trim() || null, herdrPath.trim() || null);
      // Connecting can take a while (or ask for a password): do not hold the dialog open.
      void machineConnect(m.id).catch((e) => {
        if ((e as { code?: string } | null)?.code === "ssh_auth") onNeedAuth?.(m);
        else console.error("machine_connect failed", e);
      });
      onClose();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Add machine" onClose={onClose}>
      <label>
        SSH target
        <input
          autoFocus
          value={target}
          placeholder="user@host or an ssh config alias"
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
      </label>
      {suggestions.length > 0 && (
        <ul className="suggest" role="listbox" aria-label="ssh config hosts">
          {suggestions.map((h) => (
            <li key={h} role="option" aria-selected={false} onClick={() => setTarget(h)}>
              {h}
            </li>
          ))}
        </ul>
      )}
      <label>
        Label (optional)
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <details>
        <summary>Advanced</summary>
        <label>
          herdr path
          <input value={herdrPath} placeholder="found automatically" onChange={(e) => setHerdrPath(e.target.value)} />
        </label>
      </details>
      {error && <p className="error dialog-error" role="alert">{error}</p>}
      <div className="actions">
        <button onClick={onClose}>Cancel</button>
        <button disabled={busy || !target.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
    </Modal>
  );
}
