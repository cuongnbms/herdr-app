import { memo } from "react";
import { herdrCall } from "../lib/ipc";
import { paneKey } from "../lib/types";
import type { AgentStatus, PaneView, SessionView, TabView, WorkspaceView } from "../lib/types";
import { useApp } from "../store/app";
import type { MenuItem } from "../sidebar/ContextMenu";
import { ActionsProvider, useActions } from "../sidebar/actions";
import { BotIcon, CloseIcon, FolderOpenIcon, PencilIcon, PlusIcon, SplitDownIcon, SplitRightIcon, TabPlusIcon } from "../ui/icons";
import { folderName, suggestFolder, useFolder } from "../workspaces/folder";
import { AgentIcon } from "./AgentIcon";
import { useTabReorder } from "./tabDnd";

export interface PaneEntry {
  pane: PaneView;
  workspace: WorkspaceView;
  tab: TabView;
  /** The tab label when the workspace has several tabs, else "". */
  sub: string;
}

/** A session's workspaces in order, each with its panes (empty workspaces included). */
export function workspaceGroups(session: SessionView): { workspace: WorkspaceView; entries: PaneEntry[] }[] {
  return session.workspaces.map((workspace) => ({
    workspace,
    entries: workspace.tabs.flatMap((tab) =>
      tab.panes.map((pane) => ({ pane, workspace, tab, sub: workspace.tabs.length > 1 ? tab.label : "" })),
    ),
  }));
}

/** Splits a workspace's entries into consecutive runs sharing a tab. */
function tabRuns(entries: PaneEntry[]): PaneEntry[][] {
  const runs: PaneEntry[][] = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    if (last && last[0].tab.tab_id === e.tab.tab_id) last.push(e);
    else runs.push([e]);
  }
  return runs;
}

const BADGE:Record<AgentStatus, string> = {
  blocked: "INPUT",
  working: "WORKING",
  done: "DONE",
  idle: "IDLE",
  unknown: "—",
};

type Reorder = ReturnType<typeof useTabReorder>;

/** `tabRow` when this card is its Tab's whole row (a single-pane Tab), so it is also the drop target. */
function AgentCard({ machineId, session, entry, reorder, tabRow }: { machineId: string; session: string; entry: PaneEntry; reorder: Reorder; tabRow?: boolean }) {
  const { pane, workspace: ws, tab } = entry;
  const ref = { machine_id: machineId, session, pane_id: pane.pane_id };
  const active = useApp((s) => s.selected !== null && paneKey(s.selected) === paneKey(ref));
  const select = useApp((s) => s.select);
  const a = useActions();
  const call = (method: string, params: unknown) => () => herdrCall(machineId, session, method, params);
  const close = call("pane.close", { pane_id: pane.pane_id });
  const items: MenuItem[] = a
    ? [
        { label: "Rename…", icon: PencilIcon, onSelect: () => a.rename("Rename pane", pane.title, (label) => call("pane.rename", { pane_id: pane.pane_id, label })()) },
        { label: "Split right", icon: SplitRightIcon, onSelect: () => a.guard(call("pane.split", { target_pane_id: pane.pane_id, direction: "right" })) },
        { label: "Split down", icon: SplitDownIcon, onSelect: () => a.guard(call("pane.split", { target_pane_id: pane.pane_id, direction: "down" })) },
        { label: "Close pane", icon: CloseIcon, onSelect: () => a.guard(close) },
        { label: "New tab", icon: TabPlusIcon, onSelect: () => a.guard(call("tab.create", { workspace_id: ws.workspace_id })) },
        { label: "Rename tab…", icon: PencilIcon, onSelect: () => a.rename("Rename tab", tab.label, (label) => call("tab.rename", { tab_id: tab.tab_id, label })()) },
        { label: "Close tab", icon: CloseIcon, onSelect: () => a.confirm("Close tab", `Close tab "${tab.label}" and all its panes?`, "Close", call("tab.close", { tab_id: tab.tab_id })) },
      ]
    : [];
  return (
    <li
      className={"agent-card-item" + (tabRow ? reorder.indicatorClass(tab.tab_id) : "")}
      {...(tabRow ? reorder.target(tab.tab_id) : {})}
    >
      <button
        {...reorder.source(tab.tab_id)}
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
            {entry.sub && <span className="agent-card-sub">{entry.sub}</span>}
          </span>
        </span>
      </button>
      <button className="agent-card-close" aria-label={`Close ${pane.title}`} title="Close pane" onClick={() => a?.guard(close)}>
        <CloseIcon />
      </button>
    </li>
  );
}

function WorkspaceGroup({ machineId, session, workspace: ws, entries }: { machineId: string; session: string; workspace: WorkspaceView; entries: PaneEntry[] }) {
  const a = useActions();
  const ref = { machine_id: machineId, session, workspace_id: ws.workspace_id };
  const folder = useFolder(ref);
  const call = (method: string, params: unknown) => () => herdrCall(machineId, session, method, params);
  const reorder = useTabReorder(
    ws.tabs.map((t) => t.tab_id),
    (tab_id, insert_index) => a?.guard(call("tab.move", { tab_id, insert_index })),
  );
  const items: MenuItem[] = a
    ? [
        { label: "New agent…", icon: BotIcon, onSelect: () => a.newAgent(machineId, session, ws) },
        { label: "Change folder…", icon: FolderOpenIcon, onSelect: () => a.changeFolder(ref, folder ?? suggestFolder(ws)) },
        { label: "Rename workspace…", icon: PencilIcon, onSelect: () => a.rename("Rename workspace", ws.label, (label) => call("workspace.rename", { workspace_id: ws.workspace_id, label })()) },
        { label: "Close workspace", icon: CloseIcon, onSelect: () => a.confirm("Close workspace", `Close workspace "${ws.label}" and all its panes?`, "Close", call("workspace.close", { workspace_id: ws.workspace_id })) },
      ]
    : [];
  return (
    <section role="group" aria-label={ws.label} className="ws-group">
      <div className="ws-head" onContextMenu={(e) => a?.menu(e, items)}>
        <span className="ws-label">{ws.label}</span>
        <span className="ws-folder" title={folder ?? "no folder"}>{folder ? folderName(folder) : "no folder"}</span>
        <button className="ws-add" aria-label={`New agent in ${ws.label}`} onClick={() => a?.newAgent(machineId, session, ws)}>
          <PlusIcon />
        </button>
      </div>
      {entries.length > 0 && (
        <ul className="agent-cards">
          {tabRuns(entries).map((run) =>
            run.length > 1 ? (
              <li
                key={run[0].tab.tab_id}
                role="group"
                aria-label={`Tab ${run[0].tab.label}`}
                className={"tab-group" + reorder.indicatorClass(run[0].tab.tab_id)}
                {...reorder.target(run[0].tab.tab_id)}
              >
                <ul className="agent-cards">
                  {run.map((e) => (
                    <AgentCard key={e.pane.pane_id} machineId={machineId} session={session} entry={e} reorder={reorder} />
                  ))}
                </ul>
              </li>
            ) : (
              <AgentCard key={run[0].pane.pane_id} machineId={machineId} session={session} entry={run[0]} reorder={reorder} tabRow />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

// Takes no props: memo keeps it out of App's re-renders; it reads the store itself.
export const AgentList = memo(function AgentList() {
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
  const groups = workspaceGroups(session);
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  return (
    <ActionsProvider>
      <div className="agents-head" data-tauri-drag-region>
        <span className="agents-title">{session.name}</span>
        <span className="count">{total}</span>
      </div>
      {groups.length === 0 ? (
        <p className="agents-empty">{session.running ? "No panes" : "Session stopped"}</p>
      ) : (
        groups.map((g) => (
          <WorkspaceGroup key={g.workspace.workspace_id} machineId={viewed.machine_id} session={session.name} workspace={g.workspace} entries={g.entries} />
        ))
      )}
    </ActionsProvider>
  );
});
