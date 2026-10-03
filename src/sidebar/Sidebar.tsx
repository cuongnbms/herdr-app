import { useMemo, useState } from "react";
import type { MouseEvent } from "react";
import {
  machineDisconnect,
  machineRemove,
  machineUpdate,
  sessionDelete,
  sessionsRefresh,
  sessionStart,
  sessionStop,
} from "../lib/ipc";
import type { MachineView } from "../lib/types";
import { useApp } from "../store/app";
import { StatusDot } from "./StatusDot";
import type { MenuItem } from "./ContextMenu";
import { ActionsProvider, useActions } from "./actions";
import { forgetSessionFolders } from "../workspaces/folder";
import { DashboardEntry } from "../dashboard/AgentDashboard";
import { ChevronIcon, LaptopIcon, PlusIcon, ServerIcon, StarIcon } from "../ui/icons";
import { forgetSessions, resolve, setBookmarked, useLayout } from "./groups";
import type { RSession } from "./groups";
import { GroupTree } from "./GroupTree";

const hl = (status: string) => (status === "blocked" ? " blocked" : "");

export function Chevron({ open }: { open: boolean }) {
  return <ChevronIcon className={"icon chev" + (open ? " open" : "")} />;
}

export function SessionRow({ node, bookmark }: { node: RSession; bookmark?: boolean }) {
  const { machine, session, key } = node;
  const machineId = machine.id;
  const viewed = useApp((s) => s.viewed?.machine_id === machineId && s.viewed.session === session.name);
  const view = useApp((s) => s.view);
  const bookmarked = useLayout((s) => s.layout.bookmarks.includes(key));
  const a = useActions();
  const online = machine.state === "connected";
  const bookmarkItem = {
    label: bookmarked ? "Unbookmark" : "Bookmark",
    onSelect: () => useLayout.getState().update((l) => setBookmarked(l, key, !bookmarked)),
  };
  const onMenu = (e: MouseEvent) =>
    a?.menu(
      e,
      !online
        ? [bookmarkItem]
        : session.running
        ? [
            { label: "New workspace…", onSelect: () => a.newWorkspace(machineId, session.name) },
            { label: "Stop session", onSelect: () => a.confirm("Stop session", `Stop session "${session.name}"? Running agents will end.`, "Stop", () => sessionStop(machineId, session.name)) },
            bookmarkItem,
          ]
        : [
            { label: "Start session", onSelect: () => a.guard(() => sessionStart(machineId, session.name)) },
            bookmarkItem,
            {
              label: "Delete session…",
              onSelect: () =>
                a.confirm("Delete session", `Delete session "${session.name}"? This can't be undone.`, "Delete", () =>
                  sessionDelete(machineId, session.name).then(() => {
                    forgetSessionFolders(machineId, session.name);
                    useLayout.getState().update((l) => forgetSessions(l, [key]));
                  }),
                ),
            },
          ],
    );
  const open = () => view({ machine_id: machineId, session: session.name });
  const onClick = !online
    ? undefined
    : session.running
      ? open
      : () => a?.guard(() => sessionStart(machineId, session.name).then(open));
  return (
    <li className={"session" + (session.running ? "" : " stopped") + (online ? "" : " offline")}>
      <button
        className={"row" + (viewed ? " active" : "") + hl(session.status)}
        aria-label={session.running ? undefined : `Start ${session.name}`}
        aria-disabled={online ? undefined : true}
        onClick={onClick}
        onContextMenu={onMenu}
      >
        {bookmark && <StarIcon className="icon star-icon" />}
        <span className="label">{session.name}</span>
        <span className="badge">
          {session.running && <StatusDot status={session.status} />}
          <span className="badge-label">{machine.label}</span>
        </span>
      </button>
      {session.error && <p className="error">{session.error.message}</p>}
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
      <button className="btn btn-xs" onClick={save}>Set</button>
    </div>
  );
}

function MachineNode({ machine }: { machine: MachineView }) {
  const a = useActions();
  const ssh = machine.kind === "ssh";
  const ok = machine.state === "connected";
  // Any error can be retried (e.g. after installing herdr); ssh goes batch first, then the dialog.
  const needsConnect = (ssh && machine.state === "disconnected") || machine.state === "error";
  const notFound = ssh && machine.error?.code === "herdr_not_found";
  let message = machine.error?.message ?? machine.state;
  if (machine.state === "incompatible") message = incompatibleText(machine);
  else if (notFound) message = "herdr not found — set its path";
  const items: MenuItem[] = a
    ? [
        ...(ok ? [{ label: "Refresh sessions", onSelect: () => a.guard(() => sessionsRefresh(machine.id)) }] : []),
        ...(ssh
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
          : []),
      ]
    : [];
  return (
    <li className={"machine" + (ok ? "" : " offline")}>
      <button
        className={"row" + hl(machine.status)}
        onContextMenu={(e) => items.length > 0 && a?.menu(e, items)}
      >
        {ssh ? <ServerIcon className="icon machine-icon" /> : <LaptopIcon className="icon machine-icon" />}
        <span className="label">{machine.label}</span>
        <StatusDot status={machine.status} />
      </button>
      {!ok && <p className="error">{message}</p>}
      {notFound && <HerdrPathEdit machineId={machine.id} />}
      {needsConnect && (
        <div className="machine-actions">
          <button className="btn btn-xs" onClick={() => a?.connect(machine)}>{ssh ? "Connect…" : "Retry"}</button>
        </div>
      )}
    </li>
  );
}

function AddMachine() {
  const a = useActions();
  return (
    <button className="add-machine" onClick={() => a?.addMachine()}>
      <PlusIcon />
      Add machine
    </button>
  );
}

function SectionHeader({ id, label }: { id: string; label: string }) {
  const open = useApp((s) => s.expanded[id] ?? true);
  const toggle = useApp((s) => s.toggle);
  return (
    <button className="section-toggle" aria-expanded={open} onClick={() => toggle(id, open)}>
      <Chevron open={open} />
      {label}
    </button>
  );
}

export function Sidebar() {
  const machines = useApp((s) => s.machines);
  const order = useApp((s) => s.order);
  const layout = useLayout((s) => s.layout);
  const bookmarks = useMemo(() => resolve(layout, machines, order).bookmarks, [layout, machines, order]);
  const bookmarksOpen = useApp((s) => s.expanded["bookmarks"] ?? true);
  const machinesOpen = useApp((s) => s.expanded["machines"] ?? true);
  return (
    <ActionsProvider>
      <DashboardEntry />
      {bookmarks.length > 0 && (
        <section aria-label="Bookmarks">
          <SectionHeader id="bookmarks" label="Bookmarks" />
          {bookmarksOpen && (
            <ul className="tree">
              {bookmarks.map((n) => <SessionRow key={n.key} node={n} bookmark />)}
            </ul>
          )}
        </section>
      )}
      <section aria-label="Groups">
        <GroupTree />
      </section>
      <section aria-label="Machines">
        <SectionHeader id="machines" label="Machines" />
        {machinesOpen && (
          <>
            <ul className="tree">
              {order.map((id) => machines[id] && <MachineNode key={id} machine={machines[id]} />)}
            </ul>
            <AddMachine />
          </>
        )}
      </section>
    </ActionsProvider>
  );
}
