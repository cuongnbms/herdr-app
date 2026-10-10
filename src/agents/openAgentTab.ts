import { herdrCall } from "../lib/ipc";
import { paneKey, type PaneRef } from "../lib/types";
import { writeDraft } from "../chat/drafts";
import { newAgentOnTerminal } from "../settings/lens";
import { useApp } from "../store/app";
import { launchAgent } from "./launchAgent";

export type Agent = "claude" | "pi" | "shell";
export const AGENTS: readonly Agent[] = ["claude", "pi", "shell"];

interface TabCreated {
  root_pane: { pane_id: string };
}

/**
 * Opens a new Tab in `workspaceId` at `cwd` (herdr's default when empty), selects its pane and starts `agent` there (a shell starts nothing), resolving once it runs.
 * With `fork`, the pane gets `fork.draft` as its Composer draft, the agent starts with `fork.args`, and the pane opens on Chat once the agent runs.
 * Resolves to the new pane.
 */
export async function openAgentTab(
  machineId: string,
  session: string,
  workspaceId: string,
  agent: Agent,
  cwd: string,
  fork?: { args?: string[]; draft: string },
): Promise<PaneRef> {
  const res = await herdrCall<TabCreated>(machineId, session, "tab.create", {
    workspace_id: workspaceId,
    ...(cwd ? { cwd } : {}),
    label: agent,
    focus: false,
  });
  const pane = { machine_id: machineId, session, pane_id: res.root_pane.pane_id };
  if (fork) writeDraft(paneKey(pane), fork.draft);
  // Held on the Terminal when new agents open there; otherwise it opens on Chat once herdr reports it.
  if (!fork && agent !== "shell" && newAgentOnTerminal()) useApp.getState().setLensOverride(paneKey(pane), "terminal");
  useApp.getState().select(pane);
  if (agent === "shell") return pane;
  await launchAgent((m, p) => herdrCall(machineId, session, m, p), pane, agent, fork?.args);
  // Only now: the Chat lens must never mount on a bare shell.
  if (fork) useApp.getState().setLensOverride(paneKey(pane), "chat");
  return pane;
}
