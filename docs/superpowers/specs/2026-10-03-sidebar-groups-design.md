# Sidebar Groups and Bookmarks — design

> Date: 2026-10-03 · Status: approved design, pending spec review

The sidebar stops nesting Sessions under their Machine. Instead the user arranges Sessions into **Groups** they name and nest themselves, and pins favourites into **Bookmarks**. Every Session row ends with a badge naming its Machine. Sessions and Groups are moved by drag and drop. Vocabulary is defined in [CONTEXT.md](../../../CONTEXT.md).

## Goals

- User-defined Groups, nested to any depth, holding Sessions from any Machine.
- Drag and drop for Sessions and Groups: into a Group, out to the root, and reorder.
- A Session that is in no Group sits at the root of the tree.
- A Bookmarks section at the top; a Session can be bookmarked and in a Group at the same time.
- A Machine badge at the end of each Session row; the Session's agent-status dot sits inside the badge.
- A compact Machines section that keeps all Machine management (connect, errors, herdr path, refresh, disconnect, remove, add).

## Non-goals

- Syncing Groups between app installs or with the herdr TUI.
- Grouping Workspaces or Panes; only Sessions are grouped.
- Multi-select drag.
- Keyboard drag and drop. "Move to group…" in the context menu is the non-drag path.

## Layout

```
Dashboard
▾ Bookmarks
    ☆ bmx-core-service      [● devtuf]
▸ MyProjects
▾ LinkbeeKr
  ▾ Bluematrix
      bmx-core-service      [● devtuf]
      bmx-worker            [● devtuf]
  ▸ Fuler
  tsp-iac                   [  local ]      ← Session at the root
+ New group
▾ Machines
    🖥 devtuf               ●
    💻 local                ●
+ Add machine
```

- **Bookmarks**: a fixed, collapsible section, hidden when empty. Rows show a star icon. Bookmarks can be reordered by dragging inside the section. Dropping a Session from the tree onto the Bookmarks header bookmarks it.
- **Tree**: Groups (chevron + label) and Session rows, in the stored order. Sessions that have never been placed render after the stored nodes, in Machine order and then in herdr's Session order. A "New group" button under the tree asks for a name (the rename prompt) and then creates a root Group with it.
- **Machines**: the current `MachineNode` without its Session children. Each row keeps its icon, label, status dot, error line, herdr-path field, Connect/Retry button and context menu. "Add machine" stays below it. The section is collapsible.

### Session row

- Layout: label, then the badge `[dot machine-label]`. The dot is the Session's agent status (`StatusDot`), and is hidden when the Session is stopped. Long labels are truncated with an ellipsis; the badge never shrinks.
- The row keeps today's behaviour. Clicking a running Session views it, and clicking a stopped one starts it and then views it. The `blocked` highlight and the `active` state are unchanged.
- A Session whose Machine is not connected renders greyed out (today's `offline` look), and its click does nothing.
- A placed Session whose Machine is unknown (not loaded yet, or removed) or that is no longer in its connected Machine's list is not rendered. It stays in storage until pruned (see Storage).
- Context menu: today's running/stopped items, plus `Bookmark` / `Unbookmark` and `Move to group…`. `Move to group…` opens a dialog listing Groups by path (`LinkbeeKr › Bluematrix`) plus `(root)`.

### Group row

- Chevron, folder icon, label. Clicking toggles it open or closed; the open state is persisted with the existing `expanded` map under the key `group:<id>`.
- Context menu: `New subgroup`, `Rename…`, `Delete group`.
- Delete needs no confirmation. The Group's children take its place in its parent, in order.
- Rename and New subgroup use the existing rename prompt from `actions.tsx`; New subgroup creates the Group only after a non-empty name is entered, and opens the parent.

## Model

New module `src/sidebar/groups.ts`, pure functions plus a small zustand slice.

```ts
type SessionKey = string;                               // `${machine_id}/${session}`
type Node =
  | { kind: "group"; id: string; label: string; children: Node[] }
  | { kind: "session"; key: SessionKey };
interface Layout { tree: Node[]; bookmarks: SessionKey[] }

type Target =
  | { kind: "before" | "after"; ref: NodeRef }          // a sibling row
  | { kind: "into"; groupId: string | null };            // a Group (appends) or null = root (appends)
type NodeRef = { kind: "group"; id: string } | { kind: "session"; key: SessionKey };

moveNode(layout, node: NodeRef, target: Target): Layout   // node may be an unplaced Session
addGroup(layout, parentId: string | null, label: string): { layout: Layout; id: string }
renameGroup(layout, id, label): Layout
deleteGroup(layout, id): Layout                            // children replace it in place
setBookmarked(layout, key, on: boolean): Layout            // on appends to the end
moveBookmark(layout, key, beforeKey: SessionKey | null): Layout
forgetSessions(layout, keys: SessionKey[]): Layout          // removes from tree and bookmarks
resolve(layout, machines, order): RenderedTree             // placed + unplaced Sessions, hides missing ones
```

Rules:

- `moveNode` is a no-op when it would put a Group inside itself or one of its descendants, or when the target is the node itself.
- Moving within the same parent accounts for the index shift, so "after the next sibling" lands where the indicator showed.
- A Session appears at most once in `tree`. `moveNode` of an unplaced Session inserts it.
- Group ids come from `crypto.randomUUID()`. Empty or whitespace labels are rejected, and the rename keeps the old label.
- All functions return new objects and never mutate their input.

## Storage

`localStorage` key `herdr-app:sidebar-layout`, value `JSON.stringify(Layout)`. This follows the existing `herdr-app:ui` and Workspace-folder pattern; no Rust or IPC changes. Reads and writes are wrapped in `try/catch`, and a missing or corrupt value reads as `{ tree: [], bookmarks: [] }`, so every Session shows at the root.

Pruning keeps storage from growing. It mirrors `pruneFolders`, and the call sits in `upsertMachine` in `src/store/app.ts`:

- When a Machine's view arrives with `state === "connected"`, Sessions that were in the previous view of that Machine and are missing from the new one are forgotten. herdr lists stopped Sessions too, so a missing name means the Session was deleted. Diffing against the previous view means a first snapshot with an empty list cannot wipe the layout.
- `Delete session…` forgets the Session, alongside `forgetSessionFolders`.
- `Remove machine…` forgets every Session of that Machine.

## Drag and drop

Native HTML5 drag and drop with no new dependency. `src-tauri/tauri.conf.json` gets `"dragDropEnabled": false` on the window. The app has no file drop, and Tauri's own file-drop handling otherwise swallows HTML5 drag events in the webview. The first implementation task is a spike that checks a `draggable` row fires `dragover` and `drop` in the running app (WKWebView), before the tree is built on it.

- Session and Group rows are `draggable`. `dataTransfer` carries a custom type `application/x-herdr-node` with the JSON `NodeRef` (or the Bookmark key for Bookmark rows).
- Where a row splits its height for the drop position:
  - On a Session row, the top half means `before` and the bottom half means `after`.
  - On a Group row, the top quarter means `before`, the bottom quarter means `after`, and the middle means `into`.
  - On an open Group with children, the bottom quarter inserts the node as the Group's first child instead of after the whole Group.
- Empty space under the tree means `into` root.
- Indicator: a 2px line for `before` and `after`, and a highlighted row for `into`. The indicator is cleared on `dragleave`, `drop` and `dragend`.
- Hovering a closed Group for 600 ms during a drag opens it.
- A drop that `moveNode` rejects (a Group into its descendant) shows no indicator, and `dropEffect` is `none`.
- Bookmark rows only reorder within Bookmarks. Dragging a Bookmark row into the tree does nothing.

## Components

- `src/sidebar/Sidebar.tsx`: composes `BookmarksSection`, `GroupTree`, `MachinesSection`. `MachineNode` loses its children list; `SessionNode` becomes `SessionRow` with the badge.
- `src/sidebar/GroupTree.tsx` (new): renders the resolved tree, Group rows and the drop logic.
- `src/sidebar/dnd.ts` (new): `dropTarget(rect, clientY, row)` returns the `Target` for a pointer position. It is pure, so it can be unit-tested.
- `src/sidebar/groups.ts` (new): model, storage, store slice (`useLayout`).
- `src/sidebar/MoveToGroupDialog.tsx` (new).
- `src/store/app.ts`: pruning hook in `upsertMachine` and `removeMachine`.
- `src/styles.css`: badge, Group row, drop indicators.
- `src-tauri/tauri.conf.json`: `dragDropEnabled: false`.
- `CONTEXT.md`: Group, Bookmark.

## Testing (Vitest + Testing Library)

- `groups.test.ts`:
  - `moveNode` covers before/after/into, same-parent index shift, root moves, placing an unplaced Session, and rejecting a Group into its own descendant or into itself.
  - `deleteGroup` promotes children in place.
  - Bookmark add, remove and reorder.
  - `forgetSessions` removes from both the tree and Bookmarks.
  - `resolve` appends unplaced Sessions in Machine/herdr order and hides missing ones.
  - Storage round trip, and a corrupt value falls back to empty.
- `dnd.test.ts`: zone boundaries for Session and Group rows.
- `store/app` test: pruning on a connected snapshot drops only Sessions removed since the previous view, and does nothing for a non-connected Machine.
- `Sidebar.test.tsx` / `Sidebar.actions.test.tsx`, rewritten for the new layout:
  - Rows show the Machine badge, and a stopped Session shows no dot.
  - The Machines section has no Sessions.
  - Clicking a stopped Session starts it.
  - Group context-menu actions work.
  - A `drop` event with a mocked `dataTransfer` moves a Session into a Group, which checks the wiring.
- Manual check in the running app: drag Sessions and Groups, and reorder Bookmarks.
