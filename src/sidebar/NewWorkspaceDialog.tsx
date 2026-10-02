import { useState } from "react";
import { herdrCall } from "../lib/ipc";
import { setFolder } from "../workspaces/folder";

type Agent = "none" | "claude" | "pi";

interface WorkspaceCreated {
  workspace: { workspace_id: string };
  root_pane: { pane_id: string };
}

export function NewWorkspaceDialog({
  machineId,
  session,
  defaultCwd,
  onClose,
  onError,
}: {
  machineId: string;
  session: string;
  defaultCwd: string;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [label, setLabel] = useState("");
  const [agent, setAgent] = useState<Agent>("none");
  const create = async () => {
    onClose();
    try {
      const res = await herdrCall<WorkspaceCreated>(machineId, session, "workspace.create", {
        cwd: cwd.trim() || null,
        label: label.trim() || null,
        focus: false,
      });
      if (cwd.trim()) {
        setFolder({ machine_id: machineId, session, workspace_id: res.workspace.workspace_id }, cwd);
      }
      if (agent !== "none") {
        await herdrCall(machineId, session, "agent.start", {
          name: agent,
          kind: agent,
          pane_id: res.root_pane.pane_id,
        });
      }
    } catch (e) {
      onError((e as { message?: string }).message ?? String(e));
    }
  };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-label="New workspace"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h3>New workspace in {session}</h3>
        <label>
          Directory
          <input autoFocus value={cwd} placeholder="/path/to/project" onChange={(e) => setCwd(e.target.value)} />
        </label>
        <label>
          Label (optional)
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Agent
          <select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
            <option value="none">none</option>
            <option value="claude">claude</option>
            <option value="pi">pi</option>
          </select>
        </label>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Create</button>
        </div>
      </form>
    </div>
  );
}
