import { useState } from "react";
import { herdrCall } from "../lib/ipc";
import { paneKey, type WorkspaceView } from "../lib/types";
import { useApp } from "../store/app";
import { getFolder, setFolder, suggestFolder } from "../workspaces/folder";
import { AgentChoice } from "./AgentChoice";
import { startAgent } from "./startAgent";

type Agent = "claude" | "pi" | "shell";
const AGENTS: readonly Agent[] = ["claude", "pi", "shell"];

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
      const pane = { machine_id: machineId, session, pane_id: res.root_pane.pane_id };
      // Claude writes its transcript only after the first prompt: show the Terminal from the start
      // instead of a Chat lens that falls back to it a few seconds later.
      if (agent === "claude") useApp.getState().setLensOverride(paneKey(pane), "terminal");
      useApp.getState().select(pane);
      if (agent === "shell") return;
      await startAgent((m, p) => herdrCall(machineId, session, m, p), { name: agent, kind: agent, pane_id: pane.pane_id });
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
        <AgentChoice options={AGENTS} value={agent} onChange={setAgent} autoFocus={stored !== null} />
        {stored === null && (
          <label>
            Folder
            <input spellCheck={false} autoCorrect="off" autoCapitalize="off" autoFocus value={folder} placeholder="/path/to/project" onChange={(e) => setFolderValue(e.target.value)} />
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
