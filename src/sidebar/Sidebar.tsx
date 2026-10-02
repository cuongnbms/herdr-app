import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { herdrCall, machineConnect, machineDisconnect, machineRemove, machineUpdate, sessionStart, sessionStop } from "../lib/ipc";
import { paneKey } from "../lib/types";
import type { MachineView, PaneView, SessionView, WorkspaceView } from "../lib/types";
import { useApp } from "../store/app";
import { StatusDot } from "./StatusDot";
import { ConfirmDialog, ContextMenu, TextDialog } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import { AddMachineDialog } from "../machines/AddMachineDialog";
const ConnectDialog = lazy(() => import("../machines/ConnectDialog").then((m) => ({ default: m.ConnectDialog })));

type Dialog =
  | { kind: "rename"; title: string; initial: string; run: (label: string) => Promise<unknown> }
  | { kind: "confirm"; title: string; message: string; confirmLabel: string; run: () => Promise<unknown> }
  | { kind: "workspace"; machineId: string; session: string; defaultCwd: string }
  | { kind: "add-machine" }
  | { kind: "connect"; machine: MachineView };

interface Actions {
  menu: (e: MouseEvent, items: MenuItem[]) => void;
  rename: (title: string, initial: string, run: (label: string) => Promise<unknown>) => void;
  confirm: (title: string, message: string, confirmLabel: string, run: () => Promise<unknown>) => void;
  newWorkspace: (machineId: string, session: string) => void;
  connect: (machine: MachineView) => void;
  guard: (run: () => Promise<unknown>) => void;
}

const ActionsCtx = createContext<Actions | null>(null);
const useActions = () => useContext(ActionsCtx);

/** A cwd to pre-fill for a new workspace: the selected pane's, else any pane's in the session. */
function defaultCwdFor(machineId: string, sessionName: string): string {
  const { machines, selected } = useApp.getState();
  const session = machines[machineId]?.sessions.find((s) => s.name === sessionName);
  const panes = session?.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes)) ?? [];
  if (selected && selected.machine_id === machineId && selected.session === sessionName) {
    const cwd = panes.find((p) => p.pane_id === selected.pane_id)?.cwd;
    if (cwd) return cwd;
  }
  return panes.find((p) => p.cwd)?.cwd ?? "";
}

const hl = (status: string) => (status === "blocked" ? " blocked" : "");

function Chevron({ open }: { open: boolean }) {
  return <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>;
}

function PaneRow({ machineId, session, pane }: { machineId: string; session: string; pane: PaneView }) {
  const select = useApp((s) => s.select);
  const selected = useApp((s) => s.selected);
  const ref = { machine_id: machineId, session, pane_id: pane.pane_id };
  const active = selected !== null && paneKey(selected) === paneKey(ref);
  const a = useActions();
  const call = (method: string, params: unknown) => () => herdrCall(machineId, session, method, params);
  const items: MenuItem[] = a
    ? [
        { label: "Rename…", onSelect: () => a.rename("Rename pane", pane.title, (label) => call("pane.rename", { pane_id: pane.pane_id, label })()) },
        { label: "Split right", onSelect: () => a.guard(call("pane.split", { target_pane_id: pane.pane_id, direction: "right" })) },
        { label: "Split down", onSelect: () => a.guard(call("pane.split", { target_pane_id: pane.pane_id, direction: "down" })) },
        { label: "Close pane", onSelect: () => a.confirm("Close pane", `Close "${pane.title}"?`, "Close", call("pane.close", { pane_id: pane.pane_id })) },
      ]
    : [];
  return (
    <li>
      <button
        className={"row pane" + (active ? " active" : "") + hl(pane.status)}
        onClick={() => select(ref)}
        onContextMenu={(e) => a?.menu(e, items)}
      >
        <StatusDot status={pane.status} />
        <span className="title mono">{pane.title}</span>
        {pane.agent && <span className="agent">{pane.agent}</span>}
      </button>
    </li>
  );
}

function WorkspaceNode({ machineId, session, ws }: { machineId: string; session: string; ws: WorkspaceView }) {
  const key = `${machineId}/${session}/${ws.workspace_id}`;
  const open = useApp((s) => s.expanded[key] ?? true);
  const toggle = useApp((s) => s.toggle);
  const single = ws.tabs.length === 1;
  const a = useActions();
  const call = (method: string, params: unknown) => () => herdrCall(machineId, session, method, params);
  const items: MenuItem[] = a
    ? [
        { label: "New tab", onSelect: () => a.guard(call("tab.create", { workspace_id: ws.workspace_id })) },
        { label: "Rename…", onSelect: () => a.rename("Rename workspace", ws.label, (label) => call("workspace.rename", { workspace_id: ws.workspace_id, label })()) },
        { label: "Close workspace", onSelect: () => a.confirm("Close workspace", `Close workspace "${ws.label}" and all its panes?`, "Close", call("workspace.close", { workspace_id: ws.workspace_id })) },
      ]
    : [];
  return (
    <li>
      <button
        className={"row workspace" + hl(ws.status)}
        aria-expanded={open}
        onClick={() => toggle(key, open)}
        onContextMenu={(e) => a?.menu(e, items)}
      >
        <Chevron open={open} />
        <StatusDot status={ws.status} />
        <span className="label">{ws.label}</span>
      </button>
      {open && (
        <ul className="children">
          {single
            ? ws.tabs[0].panes.map((p) => <PaneRow key={p.pane_id} machineId={machineId} session={session} pane={p} />)
            : ws.tabs.map((t) => (
                <TabNode key={t.tab_id} machineId={machineId} session={session} wsKey={key} tab={t} />
              ))}
        </ul>
      )}
    </li>
  );
}

function TabNode({
  machineId,
  session,
  wsKey,
  tab,
}: {
  machineId: string;
  session: string;
  wsKey: string;
  tab: WorkspaceView["tabs"][number];
}) {
  const key = `${wsKey}/${tab.tab_id}`;
  const open = useApp((s) => s.expanded[key] ?? true);
  const toggle = useApp((s) => s.toggle);
  const a = useActions();
  const call = (method: string, params: unknown) => () => herdrCall(machineId, session, method, params);
  const items: MenuItem[] = a
    ? [
        { label: "Rename…", onSelect: () => a.rename("Rename tab", tab.label, (label) => call("tab.rename", { tab_id: tab.tab_id, label })()) },
        { label: "Close tab", onSelect: () => a.confirm("Close tab", `Close tab "${tab.label}" and all its panes?`, "Close", call("tab.close", { tab_id: tab.tab_id })) },
      ]
    : [];
  return (
    <li>
      <button
        className={"row tab" + hl(tab.status)}
        aria-expanded={open}
        onClick={() => toggle(key, open)}
        onContextMenu={(e) => a?.menu(e, items)}
      >
        <Chevron open={open} />
        <StatusDot status={tab.status} />
        <span className="label">{tab.label}</span>
      </button>
      {open && (
        <ul className="children">
          {tab.panes.map((p) => (
            <PaneRow key={p.pane_id} machineId={machineId} session={session} pane={p} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SessionNode({ machineId, session }: { machineId: string; session: SessionView }) {
  const key = `${machineId}/${session.name}`;
  const open = useApp((s) => s.expanded[key] ?? session.running);
  const toggle = useApp((s) => s.toggle);
  const a = useActions();
  const onMenu = (e: MouseEvent) =>
    a?.menu(
      e,
      session.running
        ? [
            { label: "New workspace…", onSelect: () => a.newWorkspace(machineId, session.name) },
            { label: "Stop session", onSelect: () => a.confirm("Stop session", `Stop session "${session.name}"? Running agents will end.`, "Stop", () => sessionStop(machineId, session.name)) },
          ]
        : [{ label: "Start session", onSelect: () => a.guard(() => sessionStart(machineId, session.name)) }],
    );
  if (!session.running) {
    return (
      <li className="session stopped">
        <div className="row" onContextMenu={onMenu}>
          <StatusDot status={session.status} />
          <span className="label">{session.name}</span>
          <button
            className="start"
            aria-label={`Start ${session.name}`}
            onClick={() => void sessionStart(machineId, session.name)}
          >
            Start
          </button>
        </div>
        {session.error && <p className="error">{session.error.message}</p>}
      </li>
    );
  }
  return (
    <li className="session">
      <button
        className={"row" + hl(session.status)}
        aria-expanded={open}
        onClick={() => toggle(key, open)}
        onContextMenu={onMenu}
      >
        <Chevron open={open} />
        <StatusDot status={session.status} />
        <span className="label">{session.name}</span>
      </button>
      {session.error && <p className="error">{session.error.message}</p>}
      {open && (
        <ul className="children">
          {session.workspaces.map((w) => (
            <WorkspaceNode key={w.workspace_id} machineId={machineId} session={session.name} ws={w} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** "herdr 0.8.1 — needs protocol 22", with the version taken from the probe error. */
function incompatibleText(m: MachineView): string {
  const version = m.version ?? /^herdr (\S+?),/.exec(m.error?.message ?? "")?.[1] ?? "?";
  return `herdr ${version} — needs protocol 22`;
}

function HerdrPathEdit({ machineId }: { machineId: string }) {
  const [path, setPath] = useState("");
  const a = useActions();
  const save = () => a?.guard(() => machineUpdate(machineId, path.trim() || null));
  return (
    <div className="machine-actions">
      <input
        aria-label="herdr path"
        value={path}
        placeholder="/path/to/herdr"
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      <button onClick={save}>Set</button>
    </div>
  );
}

function MachineNode({ machine }: { machine: MachineView }) {
  const key = machine.id;
  const open = useApp((s) => s.expanded[key] ?? true);
  const toggle = useApp((s) => s.toggle);
  const a = useActions();
  const ssh = machine.kind === "ssh";
  const ok = machine.state === "connected";
  // A dropped ssh Machine stays visible (greyed, controls disabled) with its last snapshot.
  const showSessions = ok || machine.sessions.length > 0;
  const needsConnect = ssh && (machine.state === "disconnected" || (machine.state === "error" && machine.error?.code === "ssh_auth"));
  const notFound = ssh && machine.error?.code === "herdr_not_found";
  let message = machine.error?.message ?? machine.state;
  if (machine.state === "incompatible") message = incompatibleText(machine);
  else if (notFound) message = "herdr not found — set its path";
  const items: MenuItem[] =
    a && ssh
      ? [
          ...(machine.state !== "disconnected" ? [{ label: "Disconnect", onSelect: () => a.guard(() => machineDisconnect(machine.id)) }] : []),
          {
            label: "Remove machine…",
            onSelect: () =>
              a.confirm("Remove machine", `Remove "${machine.label}"? Its sessions keep running on the machine.`, "Remove", () =>
                machineRemove(machine.id).then(() => useApp.getState().removeMachine(machine.id)),
              ),
          },
        ]
      : [];
  return (
    <li className={"machine" + (ok ? "" : " offline")}>
      <button
        className={"row" + hl(machine.status)}
        aria-expanded={open}
        onClick={() => toggle(key, open)}
        onContextMenu={(e) => items.length > 0 && a?.menu(e, items)}
      >
        <Chevron open={open} />
        <StatusDot status={machine.status} />
        <span className="label">{machine.label}</span>
      </button>
      {!ok && <p className="error">{message}</p>}
      {notFound && <HerdrPathEdit machineId={machine.id} />}
      {needsConnect && (
        <div className="machine-actions">
          <button onClick={() => a?.connect(machine)}>Connect…</button>
        </div>
      )}
      {open && showSessions && (
        <ul className="children">
          {machine.sessions.map((s) => (
            <SessionNode key={s.name} machineId={machine.id} session={s} />
          ))}
        </ul>
      )}
    </li>
  );
}

function errorMessage(e: unknown): string {
  return (e as { message?: string } | null)?.message ?? String(e);
}

export function Sidebar() {
  const machines = useApp((s) => s.machines);
  const order = useApp((s) => s.order);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guard = useCallback((run: () => Promise<unknown>) => {
    setError(null);
    run().catch((e) => setError(errorMessage(e)));
  }, []);
  const actions = useMemo<Actions>(
    () => ({
      guard,
      menu: (e, items) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items });
      },
      rename: (title, initial, run) => setDialog({ kind: "rename", title, initial, run }),
      confirm: (title, message, confirmLabel, run) => setDialog({ kind: "confirm", title, message, confirmLabel, run }),
      // Batch first (key or agent); the dialog opens only when that needs the user.
      connect: (machine) => {
        if (machine.state === "error" && machine.error?.code === "ssh_auth") {
          setDialog({ kind: "connect", machine });
          return;
        }
        setError(null);
        machineConnect(machine.id).catch((e) => {
          if ((e as { code?: string } | null)?.code === "ssh_auth") setDialog({ kind: "connect", machine });
          else setError(errorMessage(e));
        });
      },
      newWorkspace: (machineId, session) =>
        setDialog({ kind: "workspace", machineId, session, defaultCwd: defaultCwdFor(machineId, session) }),
    }),
    [guard],
  );
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  let modal: ReactNode = null;
  if (dialog?.kind === "rename") {
    modal = (
      <TextDialog title={dialog.title} initial={dialog.initial} submitLabel="Rename" onClose={closeDialog}
        onSubmit={(v) => v.trim() && guard(() => dialog.run(v.trim()))} />
    );
  } else if (dialog?.kind === "confirm") {
    modal = (
      <ConfirmDialog title={dialog.title} message={dialog.message} confirmLabel={dialog.confirmLabel}
        onClose={closeDialog} onConfirm={() => guard(dialog.run)} />
    );
  } else if (dialog?.kind === "workspace") {
    modal = (
      <NewWorkspaceDialog machineId={dialog.machineId} session={dialog.session} defaultCwd={dialog.defaultCwd}
        onClose={closeDialog} onError={setError} />
    );
  } else if (dialog?.kind === "add-machine") {
    modal = (
      <AddMachineDialog
        onClose={closeDialog}
        onNeedAuth={(m) => setDialog({ kind: "connect", machine: useApp.getState().machines[m.id] ?? m })}
      />
    );
  } else if (dialog?.kind === "connect") {
    modal = (
      <Suspense fallback={null}>
        <ConnectDialog machine={dialog.machine} onClose={closeDialog} />
      </Suspense>
    );
  }

  return (
    <ActionsCtx.Provider value={actions}>
      <ul className="tree">
        {order.map((id) => machines[id] && <MachineNode key={id} machine={machines[id]} />)}
      </ul>
      <button className="add-machine" onClick={() => setDialog({ kind: "add-machine" })}>
        + Add machine
      </button>
      {error && (
        <p className="error action-error" role="alert" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
      {modal}
    </ActionsCtx.Provider>
  );
}
