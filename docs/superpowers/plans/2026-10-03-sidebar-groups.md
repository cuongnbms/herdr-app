# Sidebar Groups and Bookmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Machine › Session sidebar with user-arranged, nestable Groups of Sessions (any Machine), a Bookmarks section, a Machine badge per Session row, and drag and drop for Sessions and Groups.

**Architecture:** A pure layout model (`src/sidebar/groups.ts`) holds Groups, placed Sessions and Bookmarks and is persisted in `localStorage` through a small zustand store. `resolve()` joins it with the live Machine views at render time; Sessions never placed render at the end of the root. The Sidebar renders Bookmarks, the Group tree and a Machines section; native HTML5 drag and drop calls the pure `moveNode`.

**Tech Stack:** React 19, zustand 5, TypeScript, Vitest + Testing Library (jsdom), Tauri 2.

**Spec:** `docs/superpowers/specs/2026-10-03-sidebar-groups-design.md`

## Global Constraints

- No new npm dependencies; no Rust or IPC changes (only `src-tauri/tauri.conf.json` gets `"dragDropEnabled": false`).
- Session identity everywhere is `sessionKey(machine_id, session)` from `src/sidebar/groups.ts` = `` `${encodeURIComponent(machine_id)}/${encodeURIComponent(session)}` ``. No other file builds keys by hand.
- Layout storage key is exactly `herdr-app:sidebar-layout`; every `localStorage` access is in `try/catch`; missing/corrupt reads as `EMPTY_LAYOUT` (`{ tree: [], bookmarks: [] }`).
- All layout functions are pure and never mutate their input; they return the same object when nothing changes.
- Layout changes go only through `useLayout.getState().update(fn)` (which saves); components never call `saveLayout` directly.
- `expanded` keys: `group:<id>` for Groups, `bookmarks` for the Bookmarks section, `machines` for the Machines section; all default to open (`?? true`), toggled with the existing `useApp().toggle(key, open)`.
- Group labels are trimmed; an empty label is rejected (no Group created, rename keeps the old label).
- Copy (exact): section labels `Bookmarks`, `Machines`; buttons `New group`, `Add machine`; menu items `Bookmark`, `Unbookmark`, `Move to group…`, `New subgroup`, `Rename…`, `Delete group`; dialog titles `New group`, `New subgroup`, `Rename group`, `Move to group`; root choice in Move dialog `(root)`; Group path separator ` › `.
- Drag payload type: `application/x-herdr-node`. The node being dragged is kept in React state/ref (dragover cannot read data); `setData` is still called so WebKit starts the drag.
- The first drag of anything materializes all currently unplaced Sessions at the end of the root (via `moveNode`'s `unplaced` argument) so before/after targets on unplaced rows exist; visible order does not change.

## Review Focus

- A Session that appears in Bookmarks and in a Group is the same Session: both rows share `active`/`blocked` state and context menu, and unbookmarking leaves the Group row. (Task 5 test)
- Machine still loading at startup (not in `machines` yet): its placed Sessions must stay in storage, not be pruned or lost. (Task 2 `resolve` test + Task 3 test)
- A disconnected/errored Machine whose snapshot lists fewer Sessions must not prune. (Task 3 test)
- Dropping a Group into its own descendant must do nothing and leave no stale indicator. (Task 1 + Task 7 tests)
- Long Session labels must not push the Machine badge out of the row (CSS `min-width: 0` on label, `flex-shrink: 0` on badge). (Task 5 CSS; manual check in Task 8)

---

### Task 1: Layout model (pure functions)

**Files:**
- Create: `src/sidebar/groups.ts`
- Test: `src/sidebar/groups.test.ts`

**Interfaces:**
- Produces (all exported from `src/sidebar/groups.ts`):
  - `type SessionKey = string`
  - `sessionKey(machineId: string, session: string): SessionKey`
  - `type GroupNode = { kind: "group"; id: string; label: string; children: LayoutNode[] }`
  - `type SessionNode = { kind: "session"; key: SessionKey }`
  - `type LayoutNode = GroupNode | SessionNode`
  - `interface Layout { tree: LayoutNode[]; bookmarks: SessionKey[] }`
  - `const EMPTY_LAYOUT: Layout`
  - `type NodeRef = { kind: "group"; id: string } | { kind: "session"; key: SessionKey }`
  - `type Target = { kind: "before" | "after"; ref: NodeRef } | { kind: "into"; groupId: string | null; first?: boolean }` (`groupId: null` = root; `first` inserts as first child instead of appending)
  - `moveNode(layout: Layout, node: NodeRef, target: Target, unplaced?: SessionKey[]): Layout`
  - `canMove(layout: Layout, node: NodeRef, target: Target): boolean`
  - `addGroup(layout: Layout, parentId: string | null, label: string): { layout: Layout; id: string | null }`
  - `renameGroup(layout: Layout, id: string, label: string): Layout`
  - `deleteGroup(layout: Layout, id: string): Layout`
  - `setBookmarked(layout: Layout, key: SessionKey, on: boolean): Layout`
  - `moveBookmark(layout: Layout, key: SessionKey, beforeKey: SessionKey | null): Layout`
  - `forgetSessions(layout: Layout, keys: SessionKey[]): Layout`
  - `forgetMachine(layout: Layout, machineId: string): Layout`
  - `groupPaths(layout: Layout): { id: string; path: string }[]` (depth-first, path labels joined with ` › `)

- [ ] **Step 1: Write the failing test** — `src/sidebar/groups.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  EMPTY_LAYOUT, addGroup, canMove, deleteGroup, forgetMachine, forgetSessions, groupPaths, moveBookmark, moveNode,
  renameGroup, sessionKey, setBookmarked,
} from "./groups";
import type { GroupNode, Layout, LayoutNode, SessionNode } from "./groups";

const s = (key: string): SessionNode => ({ kind: "session", key });
const g = (id: string, ...children: LayoutNode[]): GroupNode => ({ kind: "group", id, label: id.toUpperCase(), children });
const L = (...tree: LayoutNode[]): Layout => ({ tree, bookmarks: [] });
const shape = (nodes: LayoutNode[]): unknown[] => nodes.map((n) => (n.kind === "group" ? { [n.id]: shape(n.children) } : n.key));
const S = (key: string) => ({ kind: "session" as const, key });
const G = (id: string) => ({ kind: "group" as const, id });

describe("sessionKey", () => {
  it("encodes both parts", () => {
    expect(sessionKey("local", "default")).toBe("local/default");
    expect(sessionKey("a/b", "x y")).toBe("a%2Fb/x%20y");
  });
});

describe("moveNode", () => {
  it("appends into a group and into the root", () => {
    const l = L(g("a", s("x")), s("y"));
    expect(shape(moveNode(l, S("y"), { kind: "into", groupId: "a" }).tree)).toEqual([{ a: ["x", "y"] }]);
    expect(shape(moveNode(l, S("x"), { kind: "into", groupId: null }).tree)).toEqual([{ a: [] }, "y", "x"]);
  });
  it("inserts as first child with first", () => {
    const l = L(g("a", s("x")), s("y"));
    expect(shape(moveNode(l, S("y"), { kind: "into", groupId: "a", first: true }).tree)).toEqual([{ a: ["y", "x"] }]);
  });
  it("moves before and after a row in another parent", () => {
    const l = L(g("a", s("x")), s("y"));
    expect(shape(moveNode(l, S("y"), { kind: "before", ref: S("x") }).tree)).toEqual([{ a: ["y", "x"] }]);
    expect(shape(moveNode(l, S("y"), { kind: "after", ref: S("x") }).tree)).toEqual([{ a: ["x", "y"] }]);
  });
  it("accounts for the index shift inside the same parent", () => {
    const l = L(s("x"), s("y"), s("z"));
    expect(shape(moveNode(l, S("x"), { kind: "after", ref: S("y") }).tree)).toEqual(["y", "x", "z"]);
    expect(shape(moveNode(l, S("z"), { kind: "before", ref: S("x") }).tree)).toEqual(["z", "x", "y"]);
    expect(shape(moveNode(l, S("x"), { kind: "after", ref: S("z") }).tree)).toEqual(["y", "z", "x"]);
  });
  it("moves a group with its children", () => {
    const l = L(g("a", s("x")), g("b"));
    expect(shape(moveNode(l, G("a"), { kind: "into", groupId: "b" }).tree)).toEqual([{ b: [{ a: ["x"] }] }]);
  });
  it("refuses a group into itself or its descendant, and a node onto itself", () => {
    const l = L(g("a", g("b", s("x"))));
    expect(moveNode(l, G("a"), { kind: "into", groupId: "b" })).toBe(l);
    expect(moveNode(l, G("a"), { kind: "before", ref: S("x") })).toBe(l);
    expect(moveNode(l, G("a"), { kind: "into", groupId: "a" })).toBe(l);
    expect(moveNode(l, S("x"), { kind: "before", ref: S("x") })).toBe(l);
    expect(canMove(l, G("a"), { kind: "into", groupId: "b" })).toBe(false);
    expect(canMove(l, S("x"), { kind: "into", groupId: null })).toBe(true);
  });
  it("is a no-op for an unknown target", () => {
    const l = L(s("x"));
    expect(moveNode(l, S("x"), { kind: "into", groupId: "nope" })).toBe(l);
  });
  it("places unplaced sessions at the end of the root first", () => {
    expect(shape(moveNode(L(g("a")), S("n"), { kind: "into", groupId: "a" }, ["m", "n"]).tree)).toEqual([{ a: ["n"] }, "m"]);
    expect(shape(moveNode(EMPTY_LAYOUT, S("n"), { kind: "before", ref: S("m") }, ["m", "n"]).tree)).toEqual(["n", "m"]);
  });
  it("does not mutate its input", () => {
    const l = L(g("a", s("x")), s("y"));
    const copy = structuredClone(l);
    moveNode(l, S("y"), { kind: "into", groupId: "a" });
    expect(l).toEqual(copy);
  });
});

describe("groups", () => {
  it("adds trimmed groups at the root and nested, and rejects empty labels", () => {
    const r = addGroup(L(g("a")), null, "  Work ");
    expect(r.id).toEqual(expect.any(String));
    expect(r.layout.tree[1]).toEqual({ kind: "group", id: r.id, label: "Work", children: [] });
    const n = addGroup(L(g("a")), "a", "Sub");
    expect((n.layout.tree[0] as GroupNode).children[0]).toMatchObject({ kind: "group", label: "Sub" });
    const l = L(g("a"));
    expect(addGroup(l, null, "   ")).toEqual({ layout: l, id: null });
  });
  it("renames, keeping the old label for an empty one", () => {
    expect((renameGroup(L(g("a")), "a", " New ").tree[0] as GroupNode).label).toBe("New");
    const l = L(g("a"));
    expect(renameGroup(l, "a", " ")).toBe(l);
  });
  it("deletes a group, promoting its children in place", () => {
    const l = L(s("p"), g("a", s("x"), g("b", s("y"))), s("q"));
    expect(shape(deleteGroup(l, "a").tree)).toEqual(["p", "x", { b: ["y"] }, "q"]);
  });
  it("lists group paths depth-first", () => {
    expect(groupPaths(L(g("a", g("b")), g("c")))).toEqual([
      { id: "a", path: "A" }, { id: "b", path: "A › B" }, { id: "c", path: "C" },
    ]);
  });
});

describe("bookmarks and forgetting", () => {
  it("bookmarks once, unbookmarks, and reorders", () => {
    let l = setBookmarked(EMPTY_LAYOUT, "x", true);
    l = setBookmarked(l, "x", true);
    l = setBookmarked(l, "y", true);
    expect(l.bookmarks).toEqual(["x", "y"]);
    expect(moveBookmark(l, "y", "x").bookmarks).toEqual(["y", "x"]);
    expect(moveBookmark(l, "x", null).bookmarks).toEqual(["y", "x"]);
    expect(setBookmarked(l, "x", false).bookmarks).toEqual(["y"]);
  });
  it("forgets sessions in the tree and in bookmarks", () => {
    const l = { tree: [g("a", s("x"), s("y"))], bookmarks: ["x", "z"] };
    const r = forgetSessions(l, ["x", "z"]);
    expect(shape(r.tree)).toEqual([{ a: ["y"] }]);
    expect(r.bookmarks).toEqual([]);
  });
  it("forgets every session of a machine", () => {
    const k1 = sessionKey("box", "a"), k2 = sessionKey("boxy", "b");
    const r = forgetMachine({ tree: [s(k1), s(k2)], bookmarks: [k1] }, "box");
    expect(shape(r.tree)).toEqual([k2]);
    expect(r.bookmarks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sidebar/groups.test.ts`
Expected: FAIL, cannot resolve `./groups`.

- [ ] **Step 3: Implement the functions listed under Interfaces in `src/sidebar/groups.ts`**

`moveNode`: return the original `layout` (identity, no materialization) when `canMove` is false, when node equals the target ref, or when the node/target cannot be found in the tree plus `unplaced`. Otherwise append the `unplaced` keys not already in the tree as root Session nodes, detach the node, locate the target in the detached tree (so the same-parent index shift is handled by searching after removal) and insert. `canMove` rejects a Group target/ref that is the node itself or inside the node's subtree. Group ids from `crypto.randomUUID()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sidebar/groups.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/groups.ts src/sidebar/groups.test.ts
git commit -m "feat(sidebar): add the Group and Bookmark layout model"
```

---

### Task 2: Storage, store and resolve

**Files:**
- Modify: `src/sidebar/groups.ts`
- Test: `src/sidebar/groups.store.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `sessionKey`.
- Produces (exported from `src/sidebar/groups.ts`):
  - `LAYOUT_KEY = "herdr-app:sidebar-layout"`
  - `loadLayout(): Layout`, `saveLayout(l: Layout): void`
  - `useLayout` — zustand store `{ layout: Layout; update: (fn: (l: Layout) => Layout) => void }`; initial state `loadLayout()`; `update` sets and saves only when `fn` returns a different object.
  - `type RSession = { kind: "session"; key: SessionKey; machine: MachineView; session: SessionView }`
  - `type RGroup = { kind: "group"; id: string; label: string; children: RNode[] }`
  - `type RNode = RGroup | RSession`
  - `resolve(layout: Layout, machines: Record<string, MachineView>, order: string[]): { tree: RNode[]; bookmarks: RSession[]; unplaced: SessionKey[] }` — placed Sessions whose Machine is missing or whose name isn't in that Machine's `sessions` are hidden (kept in storage); unplaced Sessions are appended to the root in `order`, then herdr order; `unplaced` lists their keys.

- [ ] **Step 1: Write the failing test** — `src/sidebar/groups.store.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_LAYOUT, LAYOUT_KEY, loadLayout, resolve, saveLayout, sessionKey, useLayout } from "./groups";
import type { RNode } from "./groups";
import type { MachineView, SessionView } from "../lib/types";

const sess = (name: string): SessionView => ({ name, running: true, status: "idle", error: null, workspaces: [] });
const mach = (id: string, ...names: string[]): MachineView => ({
  id, label: id, kind: "ssh", state: "connected", error: null, version: "0.9.3", status: "idle", sessions: names.map(sess),
});
const names = (nodes: RNode[]): unknown[] => nodes.map((n) => (n.kind === "group" ? { [n.label]: names(n.children) } : `${n.machine.id}:${n.session.name}`));

describe("layout storage", () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  it("round-trips", () => {
    const l = { tree: [{ kind: "session" as const, key: "local/x" }], bookmarks: ["local/x"] };
    saveLayout(l);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual(l);
    expect(loadLayout()).toEqual(l);
  });
  it("reads missing, corrupt or misshapen values as empty", () => {
    expect(loadLayout()).toEqual(EMPTY_LAYOUT);
    localStorage.setItem(LAYOUT_KEY, "{nope");
    expect(loadLayout()).toEqual(EMPTY_LAYOUT);
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ tree: 3 }));
    expect(loadLayout()).toEqual(EMPTY_LAYOUT);
  });
  it("reads as empty when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(loadLayout()).toEqual(EMPTY_LAYOUT);
  });
  it("update saves the new layout", () => {
    useLayout.setState({ layout: EMPTY_LAYOUT });
    useLayout.getState().update((l) => ({ ...l, bookmarks: ["local/x"] }));
    expect(useLayout.getState().layout.bookmarks).toEqual(["local/x"]);
    expect(loadLayout().bookmarks).toEqual(["local/x"]);
  });
});

describe("resolve", () => {
  const machines = { local: mach("local", "a", "b"), box: mach("box", "c") };
  it("joins placed sessions, hides missing ones and appends unplaced ones in machine order", () => {
    const layout = {
      tree: [
        { kind: "group" as const, id: "g1", label: "Work", children: [{ kind: "session" as const, key: sessionKey("local", "b") }] },
        { kind: "session" as const, key: sessionKey("ghost", "zz") },
        { kind: "session" as const, key: sessionKey("local", "gone") },
      ],
      bookmarks: [sessionKey("local", "a"), sessionKey("ghost", "zz")],
    };
    const r = resolve(layout, machines, ["local", "box"]);
    expect(names(r.tree)).toEqual([{ Work: ["local:b"] }, "local:a", "box:c"]);
    expect(r.bookmarks.map((b) => b.session.name)).toEqual(["a"]);
    expect(r.unplaced).toEqual([sessionKey("local", "a"), sessionKey("box", "c")]);
  });
  it("shows every session at the root for an empty layout", () => {
    expect(names(resolve(EMPTY_LAYOUT, machines, ["box", "local"]).tree)).toEqual(["box:c", "local:a", "local:b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sidebar/groups.store.test.ts`
Expected: FAIL, missing exports.

- [ ] **Step 3: Implement `LAYOUT_KEY`, `loadLayout`, `saveLayout`, `useLayout`, `resolve` in `src/sidebar/groups.ts`**

`loadLayout` accepts a value only when `tree` and `bookmarks` are arrays. `resolve` never decodes keys: it builds a map `sessionKey(m.id, s.name) → {machine, session}` over `order` and looks placed keys up in it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sidebar/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/groups.ts src/sidebar/groups.store.test.ts
git commit -m "feat(sidebar): persist the layout and resolve it against machines"
```

---

### Task 3: Prune the layout from machine snapshots

**Files:**
- Modify: `src/store/app.ts` (`upsertMachine`, `removeMachine`)
- Test: `src/store/app.test.ts`

**Interfaces:**
- Consumes: `useLayout`, `forgetSessions`, `forgetMachine`, `sessionKey` from `src/sidebar/groups.ts`.
- Produces: no new exports; behaviour only.

- [ ] **Step 1: Write the failing test** — append to `src/store/app.test.ts` (add imports at top: `import { EMPTY_LAYOUT, sessionKey, useLayout } from "../sidebar/groups";`)

```ts
describe("layout pruning", () => {
  const sess = (name: string) => ({ name, running: false, status: "unknown" as const, error: null, workspaces: [] });
  const box = (state: MachineView["state"], ...names: string[]): MachineView => ({
    id: "box", label: "box", kind: "ssh", state, error: null, version: "0.9.3", status: "unknown", sessions: names.map(sess),
  });
  const placed = (...keys: string[]) => ({ tree: keys.map((key) => ({ kind: "session" as const, key })), bookmarks: [...keys] });
  const kept = () => useLayout.getState().layout.bookmarks;
  beforeEach(() => {
    useApp.setState({ machines: {}, order: [], selected: null });
    useLayout.setState({ layout: EMPTY_LAYOUT });
  });

  it("forgets sessions that left a connected machine since its previous view", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a"), sessionKey("box", "b")) });
    useApp.getState().upsertMachine(box("connected", "a", "b"));
    useApp.getState().upsertMachine(box("connected", "a"));
    expect(kept()).toEqual([sessionKey("box", "a")]);
    expect(useLayout.getState().layout.tree).toEqual([{ kind: "session", key: sessionKey("box", "a") }]);
  });
  it("keeps everything on a first snapshot, even an empty one", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a")) });
    useApp.getState().upsertMachine(box("connected"));
    expect(kept()).toEqual([sessionKey("box", "a")]);
  });
  it("does not prune for a machine that is not connected", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a")) });
    useApp.getState().upsertMachine(box("connected", "a"));
    useApp.getState().upsertMachine(box("disconnected"));
    useApp.getState().upsertMachine(box("error"));
    expect(kept()).toEqual([sessionKey("box", "a")]);
  });
  it("forgets every session of a removed machine", () => {
    useLayout.setState({ layout: placed(sessionKey("box", "a"), sessionKey("local", "x")) });
    useApp.getState().upsertMachine(box("connected", "a"));
    useApp.getState().removeMachine("box");
    expect(kept()).toEqual([sessionKey("local", "x")]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/app.test.ts`
Expected: FAIL on the pruning cases.

- [ ] **Step 3: Implement in `src/store/app.ts`**

In `upsertMachine`, when `v.state === "connected"` and a previous view exists, compute `sessionKey(v.id, name)` for previous names absent from `v.sessions` and, if any, call `useLayout.getState().update((l) => forgetSessions(l, keys))`. In `removeMachine`, call `useLayout.getState().update((l) => forgetMachine(l, id))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/app.ts src/store/app.test.ts
git commit -m "feat(sidebar): prune deleted sessions from the layout"
```

---

### Task 4: Drop zones

**Files:**
- Create: `src/sidebar/dnd.ts`
- Test: `src/sidebar/dnd.test.ts`

**Interfaces:**
- Produces: `type Zone = "before" | "after" | "into"`; `dropZone(rect: { top: number; height: number }, clientY: number, row: "session" | "group"): Zone`.
  - Session row: `clientY < top + height/2` → `before`, else `after`.
  - Group row: `< top + height/4` → `before`; `>= top + 3*height/4` → `after`; else `into`.
  - `height <= 0` (jsdom): Session → `after`, Group → `into`.

- [ ] **Step 1: Write the failing test** — `src/sidebar/dnd.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { dropZone } from "./dnd";

const rect = { top: 100, height: 40 };
describe("dropZone", () => {
  it("splits a session row in halves", () => {
    expect(dropZone(rect, 100, "session")).toBe("before");
    expect(dropZone(rect, 119, "session")).toBe("before");
    expect(dropZone(rect, 120, "session")).toBe("after");
    expect(dropZone(rect, 139, "session")).toBe("after");
  });
  it("splits a group row in quarters with into in the middle", () => {
    expect(dropZone(rect, 109, "group")).toBe("before");
    expect(dropZone(rect, 110, "group")).toBe("into");
    expect(dropZone(rect, 129, "group")).toBe("into");
    expect(dropZone(rect, 130, "group")).toBe("after");
  });
  it("falls back when the row has no height", () => {
    expect(dropZone({ top: 0, height: 0 }, 0, "session")).toBe("after");
    expect(dropZone({ top: 0, height: 0 }, 0, "group")).toBe("into");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sidebar/dnd.test.ts`
Expected: FAIL, cannot resolve `./dnd`.

- [ ] **Step 3: Implement `dropZone` in `src/sidebar/dnd.ts`**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sidebar/dnd.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/dnd.ts src/sidebar/dnd.test.ts
git commit -m "feat(sidebar): compute drop zones for rows"
```

---

### Task 5: New sidebar layout (Bookmarks, Group tree, Machines) and menus

**Files:**
- Modify: `src/sidebar/Sidebar.tsx` (split `SessionNode` → `SessionRow`; `MachineNode` loses its children)
- Create: `src/sidebar/GroupTree.tsx`
- Modify: `src/sidebar/actions.tsx` (`rename` gains optional 4th param `submitLabel = "Rename"`)
- Modify: `src/ui/icons.tsx` (add `StarIcon`, `FolderIcon`, Lucide paths)
- Modify: `src/styles.css`
- Test: rewrite `src/sidebar/Sidebar.test.tsx`; update `src/sidebar/Sidebar.actions.test.tsx`

**Interfaces:**
- Consumes: `useLayout`, `resolve`, `RNode`, `RSession`, `sessionKey`, `setBookmarked`, `addGroup`, `renameGroup`, `deleteGroup`, `forgetSessions` (Tasks 1–2).
- Produces:
  - `SessionRow({ node, bookmark }: { node: RSession; bookmark?: boolean })` exported from `src/sidebar/Sidebar.tsx`: `<li className="session ...">` with `<button className="row ...">` containing (Bookmark rows) `StarIcon`, `<span className="label">`, `<span className="badge">` = `StatusDot` (only when `session.running`) + `<span className="badge-label">{machine.label}</span>`. Machine not `connected` → `li` gets `offline`, button `aria-disabled="true"` and clicks do nothing. Running/stopped click and context menu as today (the stopped row keeps `aria-label="Start <name>"`), plus `Bookmark`/`Unbookmark`. `Delete session…` also calls `useLayout.getState().update((l) => forgetSessions(l, [key]))`.
  - `GroupTree()` in `src/sidebar/GroupTree.tsx`: renders `resolve(...).tree` as `<ul className="tree">`; each Group is `<li className="group">` with a `row` button (chevron, `FolderIcon`, label) toggling `group:<id>` and a `<ul className="children">` when open; Group menu `New subgroup` (prompt `New subgroup`, submit `Create`, then opens parent), `Rename…` (prompt `Rename group`), `Delete group` (no confirm). Below the list: `<button className="add-group">` with `PlusIcon` + `New group` (prompt `New group`, submit `Create`).
  - `Sidebar` renders, in order: `DashboardEntry`; `<section aria-label="Bookmarks">` only when resolved bookmarks is non-empty (collapsible header `Bookmarks`, key `bookmarks`); `<section aria-label="Groups"><GroupTree/></section>`; `<section aria-label="Machines">` (collapsible header `Machines`, key `machines`) with `MachineNode`s and `AddMachine`.

- [ ] **Step 1: Write the failing tests**

Replace `src/sidebar/Sidebar.test.tsx` with:

```tsx
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ sessionStart: vi.fn().mockResolvedValue(undefined) }));
import { sessionStart } from "../lib/ipc";
import { useApp } from "../store/app";
import { EMPTY_LAYOUT, sessionKey, useLayout } from "./groups";
import { Sidebar } from "./Sidebar";
import type { MachineView } from "../lib/types";

const m: MachineView = {
  id: "box", label: "devtuf", kind: "ssh", state: "connected", error: null, version: "0.9.3", status: "working",
  sessions: [
    { name: "default", running: true, status: "working", error: null, workspaces: [
      { workspace_id: "w1", label: "herdr-app", number: 1, status: "working", tabs: [
        { tab_id: "w1:t1", label: "1", number: 1, status: "working", panes: [
          { pane_id: "w1:p1", terminal_id: "t", title: "Rewrite", cwd: "/x", agent: "claude", status: "working" } ] } ] } ] },
    { name: "ai-radar", running: false, status: "unknown", error: null, workspaces: [] },
  ],
};
const row = (name: string) => screen.getAllByText(name)[0].closest("button")!;
const work = { kind: "group" as const, id: "g1", label: "Work", children: [{ kind: "session" as const, key: sessionKey("box", "default") }] };

describe("Sidebar", () => {
  beforeEach(() => {
    useApp.setState({ machines: { box: m }, order: ["box"], selected: null, viewed: null, expanded: {} });
    useLayout.setState({ layout: EMPTY_LAYOUT });
  });
  it("shows sessions with a machine badge and machines without sessions", () => {
    render(<Sidebar />);
    expect(row("default").querySelector(".badge-label")?.textContent).toBe("devtuf");
    expect(row("default").querySelector(".badge [aria-label='status working']")).toBeTruthy();
    expect(row("ai-radar").querySelector(".badge .dot")).toBeNull();
    const machines = screen.getByRole("region", { name: "Machines" });
    expect(within(machines).getByText("devtuf")).toBeTruthy();
    expect(within(machines).queryByText("default")).toBeNull();
    expect(screen.queryByText("herdr-app")).toBeNull();
    expect(screen.queryByRole("region", { name: "Bookmarks" })).toBeNull();
  });
  it("renders sessions inside their group and collapses it", () => {
    useLayout.setState({ layout: { tree: [work], bookmarks: [] } });
    render(<Sidebar />);
    expect(row("default").closest("li.group")?.textContent).toContain("Work");
    fireEvent.click(screen.getByText("Work"));
    expect(useApp.getState().expanded["group:g1"]).toBe(false);
    expect(screen.queryByText("default")).toBeNull();
    expect(screen.getByText("ai-radar")).toBeTruthy();
  });
  it("shows a bookmarked session in Bookmarks and in its place", () => {
    useLayout.setState({ layout: { tree: [work], bookmarks: [sessionKey("box", "default")] } });
    render(<Sidebar />);
    const bm = screen.getByRole("region", { name: "Bookmarks" });
    expect(within(bm).getByText("default")).toBeTruthy();
    expect(screen.getAllByText("default")).toHaveLength(2);
  });
  it("views a running session on click", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText("default"));
    expect(useApp.getState().viewed).toEqual({ machine_id: "box", session: "default" });
    expect(row("default").className).toContain("active");
  });
  it("selecting a pane views its session", () => {
    useApp.getState().select({ machine_id: "box", session: "default", pane_id: "w1:p1" });
    expect(useApp.getState().viewed).toEqual({ machine_id: "box", session: "default" });
  });
  it("starts and views a stopped session on click", async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText("ai-radar"));
    expect(sessionStart).toHaveBeenCalledWith("box", "ai-radar");
    await waitFor(() => expect(useApp.getState().viewed).toEqual({ machine_id: "box", session: "ai-radar" }));
  });
  it("ignores clicks on sessions of a machine that is not connected", () => {
    useApp.setState({ machines: { box: { ...m, state: "disconnected" } } });
    render(<Sidebar />);
    fireEvent.click(screen.getByText("default"));
    expect(useApp.getState().viewed).toBeNull();
    expect(row("default").getAttribute("aria-disabled")).toBe("true");
  });
});
```

In `src/sidebar/Sidebar.actions.test.tsx`:
- add imports `within` (from `@testing-library/react`) and `import { EMPTY_LAYOUT, sessionKey, useLayout } from "./groups";`
- in the `set` helper also call `useLayout.setState({ layout: EMPTY_LAYOUT });`
- in "refreshes sessions from the machine context menu, local included" replace `screen.getByText("local")` with `within(screen.getByRole("region", { name: "Machines" })).getByText("local")`
- in "deletes a stopped session…" before render add `useLayout.setState({ layout: { tree: [], bookmarks: [sessionKey("local", "x")] } });` and after the folder assertions add `expect(useLayout.getState().layout.bookmarks).toEqual([]);`
- append these tests inside the `describe`:

```tsx
  it("bookmarks and unbookmarks a session from its menu", () => {
    set([local]);
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText("x"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bookmark" }));
    expect(useLayout.getState().layout.bookmarks).toEqual([sessionKey("local", "x")]);
    fireEvent.contextMenu(screen.getAllByText("x")[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unbookmark" }));
    expect(useLayout.getState().layout.bookmarks).toEqual([]);
  });
  it("creates, renames, nests and deletes groups", async () => {
    set([local]);
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    fireEvent.change(screen.getByLabelText("New group"), { target: { value: " Work " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Work");
    fireEvent.contextMenu(screen.getByText("Work"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New subgroup" }));
    fireEvent.change(screen.getByLabelText("New subgroup"), { target: { value: "Sub" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByText("Sub")).closest("li.group")?.parentElement?.closest("li.group")?.textContent).toContain("Work");
    fireEvent.contextMenu(screen.getByText("Work"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    fireEvent.change(screen.getByLabelText("Rename group"), { target: { value: "Job" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await screen.findByText("Job");
    fireEvent.contextMenu(screen.getByText("Job"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    await waitFor(() => expect(screen.queryByText("Job")).toBeNull());
    expect(screen.getByText("Sub")).toBeTruthy();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/sidebar/Sidebar.test.tsx src/sidebar/Sidebar.actions.test.tsx`
Expected: FAIL (no badge, no regions, no group UI).

- [ ] **Step 3: Implement the components, icons and `rename` submit label listed under Interfaces**

`rename`'s guard currently awaits a Promise; wrap synchronous layout updates as `async () => useLayout.getState().update(...)`. Opening a parent after New subgroup: `useApp.setState` via `toggle` only if it is currently closed.

- [ ] **Step 4: Add CSS in `src/styles.css`**

`.badge` (inline-flex, gap 5px, `flex-shrink: 0`, `margin-left: auto`, pill: padding 1px 7px, radius 999px, `background: var(--hover)`, `color: var(--fg-3)`, font-size 11px); `.row .label` gets `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`; `.row.active .badge { background: var(--bg) }`; `.session.offline .row { color: var(--fg-3); opacity: .5 }`; `.group > .row .label { font-weight: 600 }`; `.add-group` styled like `.add-machine`. Remove the now-unused `.machine.offline > .children` and `.machine + .machine` margin only if no other selector uses them.

- [ ] **Step 5: Run the sidebar and full suites**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/sidebar src/ui/icons.tsx src/styles.css
git commit -m "feat(sidebar): group sessions with machine badges and bookmarks"
```

---

### Task 6: Move to group dialog

**Files:**
- Create: `src/sidebar/MoveToGroupDialog.tsx`
- Modify: `src/sidebar/actions.tsx` (new `Dialog` kind `{ kind: "move"; key: SessionKey }`, `Actions.moveToGroup(key: SessionKey): void`)
- Modify: `src/sidebar/Sidebar.tsx` (`Move to group…` menu item on `SessionRow`)
- Test: `src/sidebar/MoveToGroupDialog.test.tsx`

**Interfaces:**
- Consumes: `useLayout`, `groupPaths`, `moveNode`, `resolve` (for `unplaced`) from Tasks 1–2; `Modal` from `./ContextMenu`.
- Produces: `MoveToGroupDialog({ sessionKey, onClose }: { sessionKey: SessionKey; onClose: () => void })` — `Modal` titled `Move to group` with one `<button>` per choice: `(root)` then each `groupPaths` entry's `path`. Click → `update(l => moveNode(l, {kind:"session", key}, {kind:"into", groupId}, unplaced))` (`groupId` null for root) and close.

- [ ] **Step 1: Write the failing test** — `src/sidebar/MoveToGroupDialog.test.tsx`

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store/app";
import { sessionKey, useLayout } from "./groups";
import { MoveToGroupDialog } from "./MoveToGroupDialog";
import type { MachineView } from "../lib/types";

const local: MachineView = {
  id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle",
  sessions: [{ name: "x", running: true, status: "idle", error: null, workspaces: [] }, { name: "y", running: true, status: "idle", error: null, workspaces: [] }],
};
const kx = sessionKey("local", "x");

describe("MoveToGroupDialog", () => {
  beforeEach(() => {
    useApp.setState({ machines: { local }, order: ["local"] });
    useLayout.setState({ layout: { tree: [{ kind: "group", id: "a", label: "A", children: [{ kind: "group", id: "b", label: "B", children: [] }] }], bookmarks: [] } });
  });
  it("lists the root and group paths and moves the session", () => {
    const onClose = vi.fn();
    render(<MoveToGroupDialog sessionKey={kx} onClose={onClose} />);
    expect(screen.getByRole("button", { name: "(root)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "A" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "A › B" }));
    const a = useLayout.getState().layout.tree[0];
    expect(a.kind === "group" && a.children[0].kind === "group" && a.children[0].children).toEqual([{ kind: "session", key: kx }]);
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sidebar/MoveToGroupDialog.test.tsx`
Expected: FAIL, cannot resolve `./MoveToGroupDialog`.

- [ ] **Step 3: Implement the dialog and wire `Move to group…` through `Actions.moveToGroup`**

Check `Modal` is exported from `./ContextMenu`; export it if not.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/sidebar && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidebar
git commit -m "feat(sidebar): move a session to a group from its menu"
```

---

### Task 7: Drag and drop

**Files:**
- Modify: `src/sidebar/GroupTree.tsx`, `src/sidebar/Sidebar.tsx` (Bookmarks section)
- Modify: `src-tauri/tauri.conf.json` (window: `"dragDropEnabled": false`)
- Modify: `src/styles.css`
- Test: `src/sidebar/Sidebar.dnd.test.tsx`

**Interfaces:**
- Consumes: `dropZone` (Task 4), `moveNode`, `canMove`, `moveBookmark`, `setBookmarked`, `resolve().unplaced` (Tasks 1–2).
- Produces: behaviour only. Drag state lives in a React context created in `Sidebar`: `{ dragging: Drag | null; setDragging }` where `Drag = { kind: "node"; ref: NodeRef } | { kind: "bookmark"; key: SessionKey }`.

Rules (from the spec):
- Session and Group rows in the tree, and Bookmark rows, have `draggable`. `onDragStart`: `setData("application/x-herdr-node", JSON.stringify(drag))`, `effectAllowed = "move"`, set `dragging`. `onDragEnd`: clear `dragging` and indicator.
- Every drop handler re-checks `canMove` (jsdom fires `drop` even without `preventDefault`).
- Tree row `onDragOver` with a `node` drag: zone = `dropZone(rect, clientY, kind)`; map to `Target` (`into` on a Group → `{kind:"into", groupId}`; `after` on an open Group with children → `{kind:"into", groupId, first:true}`; otherwise `{kind: zone, ref}`). If `canMove` → `preventDefault()`, `dropEffect = "move"`, show indicator; else no indicator, `dropEffect = "none"`. `onDrop`: `update(l => moveNode(l, ref, target, unplaced))`.
- Indicator: row class `drop-before` / `drop-after` (2px `var(--accent)` line via `box-shadow inset`) or `drop-into` (accent-tinted background). One indicator at a time; cleared on `dragleave`, `drop`, `dragend`.
- Closed Group hovered with a `node` drag for 600 ms opens (`toggle("group:<id>", false)`); timer cleared when the pointer leaves the row or the drag ends.
- A `div.tree-end` (min-height 24px) after the tree accepts `{kind:"into", groupId:null}`.
- Bookmark rows accept only `bookmark` drags: `before` → `moveBookmark(l, key, rowKey)`; `after` → `moveBookmark(l, key, nextKey ?? null)`. The Bookmarks header and the tree-level `Bookmarks` drop accept a `node` drag of a Session → `setBookmarked(l, key, true)`. A `bookmark` drag over the tree shows nothing.
- Because the Bookmarks section is hidden when empty, render it during any Session `node` drag even when empty (header only), so a first bookmark can be dropped.

- [ ] **Step 1: Write the failing test** — `src/sidebar/Sidebar.dnd.test.tsx`

```tsx
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ sessionStart: vi.fn().mockResolvedValue(undefined) }));
import { useApp } from "../store/app";
import { sessionKey, useLayout } from "./groups";
import type { GroupNode } from "./groups";
import { Sidebar } from "./Sidebar";
import type { MachineView } from "../lib/types";

const sess = (name: string) => ({ name, running: true, status: "idle" as const, error: null, workspaces: [] });
const local: MachineView = { id: "local", label: "local", kind: "local", state: "connected", error: null, version: "0.9.3", status: "idle", sessions: [sess("x"), sess("y")] };
const kx = sessionKey("local", "x"), ky = sessionKey("local", "y");
const dt = () => {
  const data: Record<string, string> = {};
  return { data, types: [] as string[], effectAllowed: "", dropEffect: "",
    setData(t: string, v: string) { data[t] = v; this.types.push(t); }, getData: (t: string) => data[t] ?? "", setDragImage() {} };
};
const rowOf = (text: string) => screen.getAllByText(text)[0].closest("button")!;
const drag = (from: HTMLElement, to: HTMLElement) => {
  const dataTransfer = dt();
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragEnter(to, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
  fireEvent.dragEnd(from, { dataTransfer });
};

describe("Sidebar drag and drop", () => {
  beforeEach(() => {
    useApp.setState({ machines: { local }, order: ["local"], selected: null, viewed: null, expanded: {} });
    useLayout.setState({ layout: { tree: [{ kind: "group", id: "a", label: "A", children: [] }], bookmarks: [] } });
  });
  afterEach(() => vi.useRealTimers());

  it("drops an unplaced session into a group", () => {
    render(<Sidebar />);
    drag(rowOf("y"), rowOf("A"));
    const tree = useLayout.getState().layout.tree;
    expect((tree[0] as GroupNode).children).toEqual([{ kind: "session", key: ky }]);
    expect(tree[1]).toEqual({ kind: "session", key: kx });
    expect(document.querySelector(".drop-into, .drop-before, .drop-after")).toBeNull();
  });
  it("refuses to drop a group into its own child", () => {
    useLayout.setState({ layout: { tree: [{ kind: "group", id: "a", label: "A", children: [{ kind: "group", id: "b", label: "B", children: [] }] }], bookmarks: [] } });
    const before = useLayout.getState().layout;
    render(<Sidebar />);
    drag(rowOf("A"), rowOf("B"));
    expect(useLayout.getState().layout).toBe(before);
  });
  it("bookmarks a session dropped on the Bookmarks header and reorders bookmarks", () => {
    render(<Sidebar />);
    const dataTransfer = dt();
    fireEvent.dragStart(rowOf("x"), { dataTransfer });
    const header = within(screen.getByRole("region", { name: "Bookmarks" })).getByText("Bookmarks");
    fireEvent.dragOver(header, { dataTransfer });
    fireEvent.drop(header, { dataTransfer });
    fireEvent.dragEnd(rowOf("x"), { dataTransfer });
    expect(useLayout.getState().layout.bookmarks).toEqual([kx]);
    act(() => useLayout.getState().update((l) => ({ ...l, bookmarks: [...l.bookmarks, ky] })));
    const bm = screen.getByRole("region", { name: "Bookmarks" });
    // jsdom rows have no height, so a session row resolves to "after": x moves after y.
    drag(within(bm).getByText("x").closest("button")!, within(bm).getByText("y").closest("button")!);
    expect(useLayout.getState().layout.bookmarks).toEqual([ky, kx]);
    // A bookmark drag over the tree changes nothing.
    const before = useLayout.getState().layout;
    drag(within(bm).getByText("x").closest("button")!, rowOf("A"));
    expect(useLayout.getState().layout).toBe(before);
  });
  it("opens a closed group after hovering 600 ms during a drag", () => {
    vi.useFakeTimers();
    useApp.setState({ expanded: { "group:a": false } });
    render(<Sidebar />);
    const dataTransfer = dt();
    fireEvent.dragStart(rowOf("x"), { dataTransfer });
    fireEvent.dragEnter(rowOf("A"), { dataTransfer });
    fireEvent.dragOver(rowOf("A"), { dataTransfer });
    act(() => vi.advanceTimersByTime(599));
    expect(useApp.getState().expanded["group:a"]).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(useApp.getState().expanded["group:a"]).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sidebar/Sidebar.dnd.test.tsx`
Expected: FAIL (rows not draggable / layout unchanged).

- [ ] **Step 3: Implement drag and drop per the rules above; set `"dragDropEnabled": false` on the window in `src-tauri/tauri.conf.json`; add `.drop-before`, `.drop-after`, `.drop-into`, `.tree-end` CSS**

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar src/styles.css src-tauri/tauri.conf.json
git commit -m "feat(sidebar): drag sessions and groups to arrange them"
```

---

### Task 8: Verify in the running app

**Files:** none unless a fix is needed.

- [ ] **Step 1: Full checks**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all pass, build succeeds.

- [ ] **Step 2: Manual check with the user** (agents cannot drag in the Tauri window)

Ask the user to run `npm run tauri dev` from the worktree and confirm: dragging a Session into a Group and between rows works in WKWebView; a Group drags into another Group; Bookmarks reorder; a long Session label truncates and the badge stays visible; disconnecting `devtuf` greys its rows without pruning them. Fix and commit anything they report, as `fix(sidebar): …`.
