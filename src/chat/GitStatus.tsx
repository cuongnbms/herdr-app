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
  const { folder, path, branch, dirty, upstream, ahead, behind, staged, modified, untracked } = git.value;
  const upstreamName = upstream ?? "upstream";
  const marks = [
    { cls: "ahead", text: `↑${ahead}`, label: `${commits(ahead)} ahead of ${upstreamName}`, n: ahead },
    { cls: "behind", text: `↓${behind}`, label: `${commits(behind)} behind ${upstreamName}`, n: behind },
    { cls: "staged", text: `+${staged}`, label: `${staged} staged`, n: staged },
    { cls: "modified", text: `~${modified}`, label: `${modified} modified`, n: modified },
    { cls: "untracked", text: `?${untracked}`, label: `${untracked} untracked`, n: untracked },
  ].filter((m) => m.n > 0);
  return (
    <span className="composer-git" title={branch ? tooltip(git.value) : path}>
      <FolderIcon />
      <span className="composer-git-folder">{folder}</span>
      {branch && (
        <>
          <GitBranchIcon />
          <span className="composer-git-branch">{branch}</span>
          {marks.map((m) => (
            <span key={m.cls} className={`composer-git-mark ${m.cls}`} aria-label={m.label}>
              {m.text}
            </span>
          ))}
          {!dirty && ahead + behind === 0 && (
            <span className="composer-git-mark clean" aria-label="clean">✓</span>
          )}
        </>
      )}
    </span>
  );
}

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

/** The path, branch and upstream, then the changed files as `git status --short` lists them. */
function tooltip({ path, branch, upstream, changed, changes }: GitStatus) {
  const lines = [path, upstream ? `${branch} → ${upstream}` : `${branch}`];
  if (changes.length > 0) lines.push("", ...changes.map((c) => `${c.code} ${c.path}`));
  if (changed > changes.length) lines.push(`… ${changed - changes.length} more`);
  return lines.join("\n");
}
