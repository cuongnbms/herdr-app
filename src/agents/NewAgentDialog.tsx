import { useState } from "react";
import { herdrCall } from "../lib/ipc";
import type { WorkspaceView } from "../lib/types";
import { useApp } from "../store/app";
import { getFolder, setFolder, suggestFolder } from "../workspaces/folder";

type Agent = "claude" | "pi";

interface TabCreated {
  root_pane: { pane_id: string };
}

export function NewAgentDialog({
  machineId,
  session,
  workspace,
  onClose,
  onError,
}: {
  machineId: string;
  session: string;
  workspace: WorkspaceView;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const ref = { machine_id: machineId, session, workspace_id: workspace.workspace_id };
  const [stored] = useState(() => getFolder(ref));
  const [folder, setFolderValue] = useState(() => suggestFolder(workspace));
  const [agent, setAgent] = useState<Agent>("claude");
  const start = async () => {
    const cwd = (stored ?? folder).trim();
    if (!cwd) return;
    onClose();
    try {
      if (stored === null) setFolder(ref, cwd);
      const res = await herdrCall<TabCreated>(machineId, session, "tab.create", {
        workspace_id: workspace.workspace_id,
        cwd,
        label: agent,
        focus: false,
      });
      const paneId = res.root_pane.pane_id;
      useApp.getState().select({ machine_id: machineId, session, pane_id: paneId });
      await herdrCall(machineId, session, "agent.start", { name: agent, kind: agent, pane_id: paneId });
    } catch (e) {
      onError((e as { message?: string }).message ?? String(e));
    }
  };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-label="New agent"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <h3>New agent in {workspace.label}</h3>
        <label>
          Agent
          <select autoFocus={stored !== null} value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
            <option value="claude">claude</option>
            <option value="pi">pi</option>
          </select>
        </label>
        {stored === null && (
          <label>
            Folder
            <input autoFocus value={folder} placeholder="/path/to/project" onChange={(e) => setFolderValue(e.target.value)} />
          </label>
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Start</button>
        </div>
      </form>
    </div>
  );
}
