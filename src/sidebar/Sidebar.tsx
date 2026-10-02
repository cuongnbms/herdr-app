import { useState } from "react";
import type { MouseEvent } from "react";
import {
  machineDisconnect,
  machineRemove,
  machineUpdate,
  sessionsRefresh,
  sessionStart,
  sessionStop,
} from "../lib/ipc";
import type { MachineView, SessionView } from "../lib/types";
import { useApp } from "../store/app";
import { StatusDot } from "./StatusDot";
import type { MenuItem } from "./ContextMenu";
import { ActionsProvider, useActions } from "./actions";

const hl = (status: string) => (status === "blocked" ? " blocked" : "");

function Chevron({ open }: { open: boolean }) {
  return <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>;
}

function SessionNode({ machineId, session }: { machineId: string; session: SessionView }) {
  const viewed = useApp((s) => s.viewed?.machine_id === machineId && s.viewed.session === session.name);
  const view = useApp((s) => s.view);
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
            onClick={() => a?.guard(() => sessionStart(machineId, session.name))}
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
        className={"row" + (viewed ? " active" : "") + hl(session.status)}
        onClick={() => view({ machine_id: machineId, session: session.name })}
        onContextMenu={onMenu}
      >
        <StatusDot status={session.status} />
        <span className="label">{session.name}</span>
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
          <button onClick={() => a?.connect(machine)}>{ssh ? "Connect…" : "Retry"}</button>
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

function AddMachine() {
  const a = useActions();
  return (
    <button className="add-machine" onClick={() => a?.addMachine()}>
      + Add machine
    </button>
  );
}

export function Sidebar() {
  const machines = useApp((s) => s.machines);
  const order = useApp((s) => s.order);
  return (
    <ActionsProvider>
      <ul className="tree">
        {order.map((id) => machines[id] && <MachineNode key={id} machine={machines[id]} />)}
      </ul>
      <AddMachine />
    </ActionsProvider>
  );
}
