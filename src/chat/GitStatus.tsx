import { useEffect, useRef, useState } from "react";
import { chatGitStatus } from "../lib/ipc";
import { paneKey, type AgentStatus, type GitStatus, type PaneRef } from "../lib/types";
import { FolderIcon, GitBranchIcon } from "../ui/icons";

/** The Pane's folder and git branch, like a shell prompt. Refetched when a turn ends (the agent
 *  may have committed or switched branches) and when the window regains focus, never polled. */
export function GitStatusLine({ pane, status }: { pane: PaneRef; status?: AgentStatus }) {
  const key = paneKey(pane);
  const [git, setGit] = useState<{ key: string; value: GitStatus } | null>(null);
  const [tick, setTick] = useState(0);
  const prev = useRef(status);

  useEffect(() => {
    if (prev.current === "working" && status !== "working") setTick((t) => t + 1);
    prev.current = status;
  }, [status]);

  useEffect(() => {
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    let live = true;
    chatGitStatus(pane)
      .then((value) => live && setGit(value ? { key, value } : null))
      .catch(() => live && setGit(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` identifies `pane`
  }, [key, tick]);

  if (!git || git.key !== key) return null;
  const { folder, path, branch, dirty } = git.value;
  return (
    <span className="composer-git" title={branch ? `${path}\n${branch}${dirty ? " (uncommitted changes)" : ""}` : path}>
      <FolderIcon />
      <span className="composer-git-folder">{folder}</span>
      {branch && (
        <>
          <GitBranchIcon />
          <span className="composer-git-branch">{branch}</span>
          {dirty ? (
            <span className="composer-git-mark dirty" aria-label="uncommitted changes">●</span>
          ) : (
            <span className="composer-git-mark clean" aria-label="clean">✓</span>
          )}
        </>
      )}
    </span>
  );
}
