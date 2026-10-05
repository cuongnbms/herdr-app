import { paneKey, type PaneRef } from "../lib/types";
import { useApp } from "../store/app";

/** Covers the Terminal of a pane whose agent is still starting (see launchAgent). */
export function StartingOverlay({ pane }: { pane: PaneRef }) {
  const start = useApp((s) => s.starting[paneKey(pane)]);
  if (!start) return null;
  return (
    <div className="term-starting" role="status">
      <span className="term-starting-spinner" aria-hidden="true" />
      <span>{start.phase === "shell" ? "Waiting for the shell…" : `Starting ${start.agent}…`}</span>
    </div>
  );
}
