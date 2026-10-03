// Pure layout model for sidebar Groups and Bookmarks.
// Must not import from src/store/ (the store imports this file).

export type SessionKey = string;

export const sessionKey = (machineId: string, session: string): SessionKey =>
  `${encodeURIComponent(machineId)}/${encodeURIComponent(session)}`;

export type GroupNode = { kind: "group"; id: string; label: string; children: LayoutNode[] };
export type SessionNode = { kind: "session"; key: SessionKey };
export type LayoutNode = GroupNode | SessionNode;

export interface Layout {
  tree: LayoutNode[];
  bookmarks: SessionKey[];
}

export const EMPTY_LAYOUT: Layout = { tree: [], bookmarks: [] };

export type NodeRef = { kind: "group"; id: string } | { kind: "session"; key: SessionKey };
export type Target =
  | { kind: "before" | "after"; ref: NodeRef }
  | { kind: "into"; groupId: string | null; first?: boolean };

const matches = (n: LayoutNode, ref: NodeRef): boolean =>
  sameRef(n.kind === "group" ? { kind: "group", id: n.id } : { kind: "session", key: n.key }, ref);

const sameRef = (a: NodeRef, b: NodeRef): boolean =>
  a.kind === "group" ? b.kind === "group" && a.id === b.id : b.kind === "session" && a.key === b.key;

function find(nodes: LayoutNode[], ref: NodeRef): LayoutNode | null {
  for (const n of nodes) {
    if (matches(n, ref)) return n;
    if (n.kind === "group") {
      const f = find(n.children, ref);
      if (f) return f;
    }
  }
  return null;
}

function findGroup(nodes: LayoutNode[], id: string): GroupNode | null {
  const n = find(nodes, { kind: "group", id });
  return n && n.kind === "group" ? n : null;
}

/** Remove the node everywhere it appears; returns a new array (unchanged branches are shared). */
function detach(nodes: LayoutNode[], ref: NodeRef): LayoutNode[] {
  let changed = false;
  const out: LayoutNode[] = [];
  for (const n of nodes) {
    if (matches(n, ref)) {
      changed = true;
      continue;
    }
    if (n.kind === "group") {
      const children = detach(n.children, ref);
      if (children !== n.children) {
        changed = true;
        out.push({ ...n, children });
        continue;
      }
    }
    out.push(n);
  }
  return changed ? out : nodes;
}

/** Insert next to `ref` (offset 0 = before, 1 = after). Returns null when `ref` is absent. */
function insertBeside(nodes: LayoutNode[], ref: NodeRef, offset: 0 | 1, node: LayoutNode): LayoutNode[] | null {
  const i = nodes.findIndex((n) => matches(n, ref));
  if (i >= 0) return [...nodes.slice(0, i + offset), node, ...nodes.slice(i + offset)];
  for (let j = 0; j < nodes.length; j++) {
    const n = nodes[j];
    if (n.kind !== "group") continue;
    const children = insertBeside(n.children, ref, offset, node);
    if (children) return [...nodes.slice(0, j), { ...n, children }, ...nodes.slice(j + 1)];
  }
  return null;
}

function insertInto(nodes: LayoutNode[], groupId: string, first: boolean, node: LayoutNode): LayoutNode[] | null {
  for (let j = 0; j < nodes.length; j++) {
    const n = nodes[j];
    if (n.kind !== "group") continue;
    let children: LayoutNode[] | null;
    if (n.id === groupId) children = first ? [node, ...n.children] : [...n.children, node];
    else children = insertInto(n.children, groupId, first, node);
    if (children) return [...nodes.slice(0, j), { ...n, children }, ...nodes.slice(j + 1)];
  }
  return null;
}

const refOfTarget = (t: Target): NodeRef | null =>
  t.kind === "into" ? (t.groupId === null ? null : { kind: "group", id: t.groupId }) : t.ref;

export function canMove(layout: Layout, node: NodeRef, target: Target): boolean {
  if (node.kind !== "group") return true;
  const self = findGroup(layout.tree, node.id);
  if (!self) return true;
  const ref = refOfTarget(target);
  if (!ref) return true;
  if (matches(self, ref)) return false;
  return find(self.children, ref) === null;
}

export function moveNode(layout: Layout, node: NodeRef, target: Target, unplaced: SessionKey[] = []): Layout {
  if (!canMove(layout, node, target)) return layout;
  const ref = refOfTarget(target);
  if (ref && sameRef(node, ref)) return layout;

  const known = new Set<SessionKey>();
  const collect = (nodes: LayoutNode[]) =>
    nodes.forEach((n) => (n.kind === "session" ? known.add(n.key) : collect(n.children)));
  collect(layout.tree);
  const extra: SessionNode[] = [];
  for (const key of unplaced) {
    if (known.has(key)) continue;
    known.add(key);
    extra.push({ kind: "session", key });
  }
  const base = extra.length ? [...layout.tree, ...extra] : layout.tree;

  const moving = find(base, node);
  if (!moving) return layout;
  const rest = detach(base, node);

  let tree: LayoutNode[] | null;
  if (target.kind === "into") {
    tree =
      target.groupId === null
        ? target.first ? [moving, ...rest] : [...rest, moving]
        : insertInto(rest, target.groupId, !!target.first, moving);
  } else {
    tree = insertBeside(rest, target.ref, target.kind === "before" ? 0 : 1, moving);
  }
  return tree ? { ...layout, tree } : layout;
}

export function addGroup(layout: Layout, parentId: string | null, label: string): { layout: Layout; id: string | null } {
  const text = label.trim();
  if (!text) return { layout, id: null };
  const id = crypto.randomUUID();
  const group: GroupNode = { kind: "group", id, label: text, children: [] };
  const tree = parentId === null ? [...layout.tree, group] : insertInto(layout.tree, parentId, false, group);
  if (!tree) return { layout, id: null };
  return { layout: { ...layout, tree }, id };
}

function mapGroup(nodes: LayoutNode[], id: string, fn: (g: GroupNode) => LayoutNode[]): LayoutNode[] {
  let changed = false;
  const out: LayoutNode[] = [];
  for (const n of nodes) {
    if (n.kind !== "group") {
      out.push(n);
      continue;
    }
    if (n.id === id) {
      changed = true;
      out.push(...fn(n));
      continue;
    }
    const children = mapGroup(n.children, id, fn);
    if (children !== n.children) {
      changed = true;
      out.push({ ...n, children });
    } else out.push(n);
  }
  return changed ? out : nodes;
}

export function renameGroup(layout: Layout, id: string, label: string): Layout {
  const text = label.trim();
  if (!text) return layout;
  const tree = mapGroup(layout.tree, id, (g) => [g.label === text ? g : { ...g, label: text }]);
  return tree === layout.tree ? layout : { ...layout, tree };
}

/** Delete a group; its children take its place. */
export function deleteGroup(layout: Layout, id: string): Layout {
  const tree = mapGroup(layout.tree, id, (g) => g.children);
  return tree === layout.tree ? layout : { ...layout, tree };
}

export function setBookmarked(layout: Layout, key: SessionKey, on: boolean): Layout {
  const has = layout.bookmarks.includes(key);
  if (on === has) return layout;
  return { ...layout, bookmarks: on ? [...layout.bookmarks, key] : layout.bookmarks.filter((k) => k !== key) };
}

/** Move a bookmark before `beforeKey`, or to the end when null. */
export function moveBookmark(layout: Layout, key: SessionKey, beforeKey: SessionKey | null): Layout {
  if (!layout.bookmarks.includes(key) || key === beforeKey) return layout;
  const rest = layout.bookmarks.filter((k) => k !== key);
  let at = rest.length;
  if (beforeKey !== null) {
    at = rest.indexOf(beforeKey);
    if (at < 0) return layout;
  }
  const bookmarks = [...rest.slice(0, at), key, ...rest.slice(at)];
  return bookmarks.every((k, i) => k === layout.bookmarks[i]) ? layout : { ...layout, bookmarks };
}

function forgetWhere(layout: Layout, drop: (key: SessionKey) => boolean): Layout {
  const prune = (nodes: LayoutNode[]): LayoutNode[] => {
    let changed = false;
    const out: LayoutNode[] = [];
    for (const n of nodes) {
      if (n.kind === "session") {
        if (drop(n.key)) changed = true;
        else out.push(n);
      } else {
        const children = prune(n.children);
        if (children !== n.children) {
          changed = true;
          out.push({ ...n, children });
        } else out.push(n);
      }
    }
    return changed ? out : nodes;
  };
  const tree = prune(layout.tree);
  const kept = layout.bookmarks.filter((k) => !drop(k));
  const bookmarks = kept.length === layout.bookmarks.length ? layout.bookmarks : kept;
  return tree === layout.tree && bookmarks === layout.bookmarks ? layout : { tree, bookmarks };
}

export function forgetSessions(layout: Layout, keys: SessionKey[]): Layout {
  if (!keys.length) return layout;
  const set = new Set(keys);
  return forgetWhere(layout, (k) => set.has(k));
}

export function forgetMachine(layout: Layout, machineId: string): Layout {
  const prefix = `${encodeURIComponent(machineId)}/`;
  return forgetWhere(layout, (k) => k.startsWith(prefix));
}

export function groupPaths(layout: Layout): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  const walk = (nodes: LayoutNode[], prefix: string[]) => {
    for (const n of nodes) {
      if (n.kind !== "group") continue;
      const path = [...prefix, n.label];
      out.push({ id: n.id, path: path.join(" › ") });
      walk(n.children, path);
    }
  };
  walk(layout.tree, []);
  return out;
}
