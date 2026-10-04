import { useNewTab } from "../settings/newTab";
import { selectedPane, useApp } from "../store/app";
import { getFolder } from "../workspaces/folder";
import { openAgentTab } from "./openAgentTab";

/**
 * ⌘T: a new Tab in the selected pane's Workspace, at the Workspace's folder (else that pane's cwd),
 * running the agent chosen in Settings. Resolves false when no pane is selected.
 */
export async function openNewTabHere(): Promise<boolean> {
  const sel = selectedPane(useApp.getState());
  if (!sel) return false;
  const { machine, session, workspace, pane } = sel;
  const ref = { machine_id: machine.id, session: session.name, workspace_id: workspace.workspace_id };
  const cwd = getFolder(ref) ?? pane.cwd ?? "";
  await openAgentTab(machine.id, session.name, workspace.workspace_id, useNewTab.getState().agent, cwd);
  return true;
}
