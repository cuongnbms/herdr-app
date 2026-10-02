import { herdrCall } from "../lib/ipc";
import { paneKey } from "../lib/types";
import type { AgentStatus, PaneView, SessionView, TabView, WorkspaceView } from "../lib/types";
import { useApp } from "../store/app";
import type { MenuItem } from "../sidebar/ContextMenu";
import { ActionsProvider, useActions } from "../sidebar/actions";
import { AgentIcon } from "./AgentIcon";

export interface PaneEntry {
  pane: PaneView;
  workspace: WorkspaceView;
  tab: TabView;
  /** "workspace · tab", or just the workspace when it has a single tab. */
  sub: string;
}

/** Every pane of a session in workspace/tab order, without the tab grouping. */
export function sessionPanes(session: SessionView): PaneEntry[] {
  return session.workspaces.flatMap((workspace) =>
    workspace.tabs.flatMap((tab) =>
      tab.panes.map((pane) => ({
        pane,
        workspace,
        tab,
        sub: workspace.tabs.length > 1 ? `${workspace.label} · ${tab.label}` : workspace.label,
      })),
    ),
  );
}

const BADGE: Record<AgentStatus, string> = {
  blocked: "INPUT",
  working: "WORKING",
  done: "DONE",
  idle: "READY",
  unknown: "—",
};

function AgentCard({ machineId, session, entry }: { machineId: string; session: string; entry: PaneEntry }) {
  const { pane, workspace: ws, tab } = entry;
  const ref = { machine_id: machineId, session, pane_id: pane.pane_id };
  const active = useApp((s) => s.selected !== null && paneKey(s.selected) === paneKey(ref));
  const select = useApp((s) => s.select);
  const a = useActions();
  const call = (method: string, params: unknown) => () => herdrCall(machineId, session, method, params);
  const items: MenuItem[] = a
    ? [
        { label: "Rename…", onSelect: () => a.rename("Rename pane", pane.title, (label) => call("pane.rename", { pane_id: pane.pane_id, label })()) },
        { label: "Split right", onSelect: () => a.guard(call("pane.split", { target_pane_id: pane.pane_id, direction: "right" })) },
        { label: "Split down", onSelect: () => a.guard(call("pane.split", { target_pane_id: pane.pane_id, direction: "down" })) },
        { label: "Close pane", onSelect: () => a.confirm("Close pane", `Close "${pane.title}"?`, "Close", call("pane.close", { pane_id: pane.pane_id })) },
        { label: "New tab", onSelect: () => a.guard(call("tab.create", { workspace_id: ws.workspace_id })) },
        { label: "Rename tab…", onSelect: () => a.rename("Rename tab", tab.label, (label) => call("tab.rename", { tab_id: tab.tab_id, label })()) },
        { label: "Close tab", onSelect: () => a.confirm("Close tab", `Close tab "${tab.label}" and all its panes?`, "Close", call("tab.close", { tab_id: tab.tab_id })) },
        { label: "Rename workspace…", onSelect: () => a.rename("Rename workspace", ws.label, (label) => call("workspace.rename", { workspace_id: ws.workspace_id, label })()) },
        { label: "Close workspace", onSelect: () => a.confirm("Close workspace", `Close workspace "${ws.label}" and all its panes?`, "Close", call("workspace.close", { workspace_id: ws.workspace_id })) },
      ]
    : [];
  return (
    <li>
      <button
        className={"agent-card" + (active ? " active" : "") + (pane.status === "blocked" ? " blocked" : "")}
        onClick={() => select(ref)}
        onContextMenu={(e) => a?.menu(e, items)}
        title={pane.cwd ?? undefined}
      >
        <AgentIcon agent={pane.agent} />
        <span className="agent-card-body">
          <span className="agent-card-title">{pane.title}</span>
          <span className="agent-card-meta">
            <span className={`badge badge-${pane.status}`}>{BADGE[pane.status]}</span>
            <span className="agent-card-sub">{entry.sub}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

export function AgentList() {
  const viewed = useApp((s) => s.viewed);
  const session = useApp((s) =>
    s.viewed ? s.machines[s.viewed.machine_id]?.sessions.find((x) => x.name === s.viewed!.session) : undefined,
  );
  if (!viewed || !session)
    return (
      <>
        <div className="agents-head" data-tauri-drag-region />
        <p className="agents-empty">Select a session</p>
      </>
    );
  const entries = sessionPanes(session);
  return (
    <ActionsProvider>
      <div className="agents-head" data-tauri-drag-region>
        <span className="agents-title">{session.name}</span>
        <span className="count">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <p className="agents-empty">{session.running ? "No panes" : "Session stopped"}</p>
      ) : (
        <ul className="agent-cards">
          {entries.map((e) => (
            <AgentCard key={e.pane.pane_id} machineId={viewed.machine_id} session={session.name} entry={e} />
          ))}
        </ul>
      )}
    </ActionsProvider>
  );
}
