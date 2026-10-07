import { useApp } from "../store/app";
import { FolderOpenIcon } from "../ui/icons";
import { showToast } from "../ui/Toast";
import { workspaceOfSelection } from "./root";

/** Closes the Files overlay, or opens it on the selected pane's Workspace (closing the dashboard). */
export function toggleFilesOverlay() {
  const state = useApp.getState();
  if (state.filesOverlay) {
    state.setFilesOverlay(null);
    return;
  }
  const ws = workspaceOfSelection(state);
  if (ws) state.setFilesOverlay(ws);
  else showToast("Select a workspace first");
}

/** The sidebar row under the dashboard's that toggles the Files overlay. */
export function FilesEntry() {
  const open = useApp((s) => !!s.filesOverlay);
  return (
    <button className={"row files-entry" + (open ? " active" : "")} aria-pressed={open} title="Browse Files (⌘E)" onClick={toggleFilesOverlay}>
      <FolderOpenIcon className="icon machine-icon" />
      <span className="label">Browse Files</span>
    </button>
  );
}
