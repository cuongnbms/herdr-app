import { useEffect, useRef, useState } from "react";
import { herdrCall } from "../lib/ipc";
import { paneKey, type WorkspaceView } from "../lib/types";
import { useApp } from "../store/app";
import { getFolder, setFolder, suggestFolder } from "../workspaces/folder";
import { AgentIcon } from "./AgentIcon";
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
  // Clicking an agent submits the form; Enter in the folder field picks the first (claude).
  const picked = useRef<Agent>(AGENTS[0]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const start = async (agent: Agent) => {
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
      // A new agent opens on the Terminal; useTranscriptProbe turns it to Chat once its transcript exists.
      if (agent !== "shell") useApp.getState().setLensOverride(paneKey(pane), "terminal");
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
        onSubmit={(e) => {
          e.preventDefault();
          const agent = picked.current;
          picked.current = AGENTS[0];
          void start(agent);
        }}
      >
        <div className="dialog-head">
          <h3>New agent in {workspace.label}</h3>
          <kbd aria-hidden="true">esc</kbd>
        </div>
        {stored === null && (
          <label>
            Folder
            <input spellCheck={false} autoCorrect="off" autoCapitalize="off" autoFocus value={folder} placeholder="/path/to/project" onChange={(e) => setFolderValue(e.target.value)} />
          </label>
        )}
        <div className="agent-pick" role="group" aria-label="Agent">
          {AGENTS.map((a, i) => (
            <button key={a} type="submit" autoFocus={stored !== null && i === 0} onClick={() => (picked.current = a)}>
              <span aria-hidden="true"><AgentIcon agent={a === "shell" ? null : a} /></span>
              {a}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
