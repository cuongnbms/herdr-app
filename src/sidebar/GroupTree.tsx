import { useMemo } from "react";
import type { MouseEvent } from "react";
import { useApp } from "../store/app";
import { useActions } from "./actions";
import { addGroup, deleteGroup, renameGroup, resolve, useLayout } from "./groups";
import type { RGroup, RNode } from "./groups";
import { Chevron, SessionRow } from "./Sidebar";
import { useDragState } from "./dnd";
import { indicatorClass, useTreeEndDnd, useTreeRowDnd } from "./useRowDnd";
import { FolderIcon, PlusIcon } from "../ui/icons";

function GroupRow({ group }: { group: RGroup }) {
  const key = `group:${group.id}`;
  const open = useApp((s) => s.expanded[key] ?? true);
  const toggle = useApp((s) => s.toggle);
  const a = useActions();
  const drag = useDragState();
  const id = `group:${group.id}`;
  const dnd = useTreeRowDnd({ kind: "group", id: group.id }, id, { open, hasChildren: group.children.length > 0 });
  const onMenu = (e: MouseEvent) =>
    a?.menu(e, [
      {
        label: "New subgroup",
        onSelect: () =>
          a.rename(
            "New subgroup",
            "",
            async (label) => {
              useLayout.getState().update((l) => addGroup(l, group.id, label).layout);
              if (!(useApp.getState().expanded[key] ?? true)) toggle(key, false);
            },
            "Create",
          ),
      },
      { label: "Rename…", onSelect: () => a.rename("Rename group", group.label, async (label) => useLayout.getState().update((l) => renameGroup(l, group.id, label))) },
      { label: "Delete group", onSelect: () => a.guard(async () => useLayout.getState().update((l) => deleteGroup(l, group.id))) },
    ]);
  return (
    <li className="group">
      <button
        {...dnd}
        className={"row" + indicatorClass(drag, id)}
        aria-expanded={open}
        onClick={() => toggle(key, open)}
        onContextMenu={onMenu}
      >
        <Chevron open={open} />
        <FolderIcon className="icon group-icon" />
        <span className="label">{group.label}</span>
      </button>
      {open && group.children.length > 0 && <Nodes nodes={group.children} />}
    </li>
  );
}

function Nodes({ nodes }: { nodes: RNode[] }) {
  return (
    <ul className="children">
      {nodes.map((n) => (n.kind === "group" ? <GroupRow key={n.id} group={n} /> : <SessionRow key={n.key} node={n} />))}
    </ul>
  );
}

export function GroupTree() {
  const machines = useApp((s) => s.machines);
  const order = useApp((s) => s.order);
  const layout = useLayout((s) => s.layout);
  const tree = useMemo(() => resolve(layout, machines, order).tree, [layout, machines, order]);
  const a = useActions();
  const endDnd = useTreeEndDnd();
  const drag = useDragState();
  return (
    <>
      <ul className="tree">
        {tree.map((n) => (n.kind === "group" ? <GroupRow key={n.id} group={n} /> : <SessionRow key={n.key} node={n} />))}
      </ul>
      <div className={"tree-end" + indicatorClass(drag, "tree-end")} {...endDnd} />
      <button
        className="add-group"
        onClick={() => a?.rename("New group", "", async (label) => useLayout.getState().update((l) => addGroup(l, null, label).layout), "Create")}
      >
        <PlusIcon />
        New group
      </button>
    </>
  );
}
