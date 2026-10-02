import { sessionStart } from "../lib/ipc";
import { paneKey } from "../lib/types";
import type { MachineView, PaneView, SessionView, WorkspaceView } from "../lib/types";
import { useApp } from "../store/app";
import { StatusDot } from "./StatusDot";

function Chevron({ open }: { open: boolean }) {
  return <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>;
}

function PaneRow({ machineId, session, pane }: { machineId: string; session: string; pane: PaneView }) {
  const select = useApp((s) => s.select);
  const selected = useApp((s) => s.selected);
  const ref = { machine_id: machineId, session, pane_id: pane.pane_id };
  const active = selected !== null && paneKey(selected) === paneKey(ref);
  return (
    <li>
      <button className={"row pane" + (active ? " active" : "")} onClick={() => select(ref)}>
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
  return (
    <li>
      <button className="row workspace" aria-expanded={open} onClick={() => toggle(key, open)}>
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
  return (
    <li>
      <button className="row tab" aria-expanded={open} onClick={() => toggle(key, open)}>
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
  if (!session.running) {
    return (
      <li className="session stopped">
        <div className="row">
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
      <button className="row" aria-expanded={open} onClick={() => toggle(key, open)}>
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

function MachineNode({ machine }: { machine: MachineView }) {
  const key = machine.id;
  const open = useApp((s) => s.expanded[key] ?? true);
  const toggle = useApp((s) => s.toggle);
  const ok = machine.state === "connected";
  return (
    <li className={"machine" + (ok ? "" : " offline")}>
      <button className="row" aria-expanded={open} onClick={() => toggle(key, open)}>
        <Chevron open={open} />
        <StatusDot status={machine.status} />
        <span className="label">{machine.label}</span>
      </button>
      {!ok && <p className="error">{machine.error?.message ?? machine.state}</p>}
      {open && ok && (
        <ul className="children">
          {machine.sessions.map((s) => (
            <SessionNode key={s.name} machineId={machine.id} session={s} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Sidebar() {
  const machines = useApp((s) => s.machines);
  const order = useApp((s) => s.order);
  return (
    <ul className="tree">
      {order.map((id) => machines[id] && <MachineNode key={id} machine={machines[id]} />)}
    </ul>
  );
}
