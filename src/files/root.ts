import type { WorkspaceView } from "../lib/types";
import { selectedPane } from "../store/app";
import type { AppState } from "../store/app";
import { getFolder, suggestFolder } from "../workspaces/folder";
import type { WorkspaceRef } from "../workspaces/folder";

export type Root = { path: string; source: "folder" | "pane" };

/** The folder the Files overlay browses: the Workspace's folder, else a pane's cwd. */
export function resolveRoot(ref: WorkspaceRef, ws: WorkspaceView | undefined, selectedCwd: string | null): Root | null {
  const folder = getFolder(ref);
  if (folder) return { path: folder, source: "folder" };
  const path = selectedCwd || (ws ? suggestFolder(ws) : "");
  return path ? { path, source: "pane" } : null;
}

/** The Workspace holding the selected pane, if any. */
export function workspaceOfSelection(state: Pick<AppState, "machines" | "selected">): WorkspaceRef | null {
  const sel = selectedPane(state);
  if (!sel) return null;
  return { machine_id: sel.machine.id, session: sel.session.name, workspace_id: sel.workspace.workspace_id };
}
