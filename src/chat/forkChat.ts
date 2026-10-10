import { openAgentTab } from "../agents/openAgentTab";
import { chatFork } from "../lib/ipc";
import { paneKey, type Located, type PaneRef } from "../lib/types";
import { useApp } from "../store/app";
import { showToast } from "../ui/Toast";
import type { ChatRow } from "./workBlocks";

/** Forking needs an agent whose transcript can be cut (claude, pi) and one certain transcript file. */
export function canFork(agent: string | null, located: Located | null): boolean {
  return (agent === "claude" || agent === "pi") && !!located && !located.pending && !located.ambiguous;
}

/** The row that offers "Fork from latest": the last one, when it is an answer and the agent is not live; -1 for none. */
export function latestForkRow(rows: ChatRow[], live: boolean): number {
  const last = rows[rows.length - 1];
  return !live && last?.kind === "item" && last.item.kind === "assistant_text" ? rows.length - 1 : -1;
}

/** The Pane's Workspace and the Pane's own cwd, walked like `findPane`. */
function whereIs(pane: PaneRef): { workspaceId: string; cwd: string | null } | undefined {
  const session = useApp.getState().machines[pane.machine_id]?.sessions.find((s) => s.name === pane.session);
  for (const ws of session?.workspaces ?? []) {
    for (const tab of ws.tabs) {
      const found = tab.panes.find((p) => p.pane_id === pane.pane_id);
      if (found) return { workspaceId: ws.workspace_id, cwd: found.cwd ?? null };
    }
  }
  return undefined;
}

/** Forks still running, by `${paneKey}|${entry id}` (`|latest` from the latest entry): a second click on the same message waits for none. */
const inFlight = new Set<string>();

/**
 * Forks the transcript at `path` from before the user message `item`, or from its latest entry on when
 * `item` is null: the cut becomes a new session, opened as a new agent Tab on Chat with the message's
 * text (or nothing) as its draft. Failures are toasted.
 */
export async function forkChat(pane: PaneRef, agent: "claude" | "pi", path: string, item: { id: string; text: string } | null): Promise<void> {
  const key = `${paneKey(pane)}|${item ? item.id : "latest"}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const at = whereIs(pane);
    if (!at) throw new Error("pane not found");
    const forked = await chatFork(pane.machine_id, agent, path, item?.id ?? null);
    const args =
      agent === "claude" ? (forked.id ? ["--resume", forked.id] : undefined) : forked.path ? ["--session", forked.path] : undefined;
    await openAgentTab(pane.machine_id, pane.session, at.workspaceId, agent, forked.cwd ?? at.cwd ?? "", { args, draft: item?.text ?? "" });
  } catch (err) {
    showToast(`Could not fork: ${(err as { message?: string } | null)?.message ?? String(err)}`);
  } finally {
    inFlight.delete(key);
  }
}
