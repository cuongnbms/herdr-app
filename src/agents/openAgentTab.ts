import { herdrCall } from "../lib/ipc";
import { paneKey } from "../lib/types";
import { newAgentOnTerminal } from "../settings/lens";
import { useApp } from "../store/app";
import { launchAgent } from "./launchAgent";

export type Agent = "claude" | "pi" | "shell";
export const AGENTS: readonly Agent[] = ["claude", "pi", "shell"];

interface TabCreated {
  root_pane: { pane_id: string };
}

/** Opens a new Tab in `workspaceId` at `cwd` (herdr's default when empty), selects its pane and starts `agent` there (a shell starts nothing), resolving once it runs. */
export async function openAgentTab(machineId: string, session: string, workspaceId: string, agent: Agent, cwd: string): Promise<void> {
  const res = await herdrCall<TabCreated>(machineId, session, "tab.create", {
    workspace_id: workspaceId,
    ...(cwd ? { cwd } : {}),
    label: agent,
    focus: false,
  });
  const pane = { machine_id: machineId, session, pane_id: res.root_pane.pane_id };
  // Held on the Terminal when new agents open there; otherwise it opens on Chat once herdr reports it.
  if (agent !== "shell" && newAgentOnTerminal()) useApp.getState().setLensOverride(paneKey(pane), "terminal");
  useApp.getState().select(pane);
  if (agent === "shell") return;
  await launchAgent((m, p) => herdrCall(machineId, session, m, p), pane, agent);
}
