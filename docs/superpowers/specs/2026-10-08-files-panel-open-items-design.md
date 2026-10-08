# Files panel and Open items

Date: 2026-10-08
Status: draft

## Purpose

Files are always one glance away instead of behind a full-screen overlay. The file tree
lives under the agent list, and an opened file appears as a tab next to the opened agents,
in the same place the Chat and Terminal lenses show. This replaces the Files overlay and
the "Workspace Files" sidebar entry.

## Scope

In:

- Remove the "Workspace Files" sidebar entry (`FilesEntry`), the Files overlay
  (`FilesOverlay`) and `filesOverlay` in the app store.
- A **Files panel** under the agent list in the agents column, separated by a draggable
  splitter, always present (collapsible).
- One **Open strip** of tabs above the main area that holds both opened agents and opened
  files: **Open items**.
- A **File viewer** in the main area, shown when the active Open item is a file.

Out:

- Persisting Open items, the splitter position or the collapsed state across app restarts.
  The splitter position and the collapsed state are kept for the running app only.
- Any change to what files can do (still read, Upload, Download; ADR-0005).
- Several file trees at once.

## Model

`useApp.agentTabs` becomes `openItems`:

```ts
type OpenItem =
  | { kind: "agent"; ref: PaneRef }
  | { kind: "file"; ws: WorkspaceRef; root: string; rel: string };

interface OpenItems {
  items: OpenItem[];          // in the order opened
  preview: string | null;     // itemKey of the one item the next unpinned open replaces
  active: string | null;      // itemKey of the item the main area shows
}
```

- `itemKey`: `agent:<paneKey>` or `file:<filesKey(ws, root)>|<rel>`.
- One preview slot for both kinds. Opening an agent unpinned replaces a file preview and the
  other way round. Pinning, closing (one, others, to the right, all) and the preview rules
  are those of `src/agents/openAgents.ts` today, generalised to `OpenItem` in a new
  `src/store/openItems.ts` (pure functions, unit tested). `openAgents.ts` is removed.
- Selecting a Pane (`select`) keeps its current rules for opening the agent's item and makes
  that item active. Activating a file item does **not** change `selected`: the Header, the
  remembered lens and the selected Pane stay, so switching back to an agent item is instant.
- Pruning: a machine snapshot drops the agent items whose Pane is gone (as today). File items
  are dropped when their Workspace is gone from its machine's snapshot. A machine removed drops
  both kinds of its items.
- When the active item closes, the next item to its right becomes active, else to its left;
  with none left, the main area shows the selected Pane's lens (or the empty state).
- `useFiles` keeps per-root state (`expanded`, `scroll`, `recent`) and loses `tabs`,
  `preview`, `active`, `open`, `pin`, `close`, `closeTabs`, `cycle`. `recent` is still updated
  when a file item opens.

## UI

### Files panel (`src/files/FilesPanel.tsx`)

Lives in `<aside className="agents">` below `AgentList`, split by a horizontal splitter
(drag to resize, min heights for both halves).

- **Which Workspace**: that of the active Open item (an agent item's Pane, or a file item's
  `ws`); with no active item, the Workspace of the selected Pane; with neither, an empty
  panel ("Select an agent to browse its files").
- **Root**: a file item's own `root` when a file item is active, else `overlayRoot(ws, state)`
  (renamed `panelRoot`), resolved again only when the Workspace changes or its folder is set,
  as the overlay did.
- Header: `FILES · <workspace label>`, the machine label for an ssh machine, buttons for
  show heavy folders, reload and collapse. The root path shows in the header's title
  tooltip; "Set as workspace folder" shows when the root came from a pane's cwd.
- Below the header: Go to file input (⌘P), then the tree (`FileTree`, unchanged).
- States moved from the overlay: "Machine offline" banner, "Auto-refresh stopped" banner,
  "This workspace has no folder." / "This folder no longer exists." with "Change folder…".
- Owns the **Files watch** for its root (`useWatch`), and the listing for Go to file.
- Clicking a file opens it unpinned, double-click pins: `openFile(ws, root, rel, { pin })`.
- Collapsed: only the header shows, the agent list takes the height.

### Open strip (`src/main/OpenStrip.tsx`, replaces `AgentTabs`)

Same look and gestures as today's agent tabs (click activates, double-click pins, middle
click closes, context menu Close / Close Others / Close to the Right / Close All).

- Agent item: status dot + pane title; tooltip `machine/session · workspace · title`.
- File item: file icon + basename; tooltip `machine/session · workspace · path`.
- The strip shows whenever it has items, also when no Pane is selected.

### Main area

- Active file item: `Header` (unchanged, still about the selected Pane when there is one),
  the Open strip, then the **File viewer**.
- Otherwise: as today (Header, Open strip, Chat or Terminal lens, or the empty states).

### File viewer (`src/files/FileViewer.tsx`)

The overlay's `files-main` moved out as its own component, for one file item: reads the file,
breadcrumbs with Copy path / Copy contents, Outline, Render / Source, find bar, `FileView`,
"File removed" and "Could not reload" banners. It reloads the file when the Files panel's
watch reports a change to it: the panel publishes change batches through a small store keyed
by `filesKey`, the viewer subscribes to the one for its item. The view mode, find state and
link fragment stay per file, as in the overlay.

### Entry points

- "Browse files" in an agent's context menu: activates that agent's item and expands the
  Files panel if collapsed.
- File links in the Chat lens (`chat/fileLinks.ts`): open the file as a file item (unpinned),
  with its `#L12` / `#heading` fragment.
- Upload and Download stay where they are in the tree's context menu.

## Keys

| Key | Action |
|-----|--------|
| ⌘E | Expand the Files panel if collapsed and focus the tree |
| ⌘P | Focus Go to file |
| ⌘W | Close the active Open item (an agent item only closes its tab, never the Pane) |
| ⌘⇧[ / ⌘⇧] | Previous / next Open item |
| ⌘F, ⌘G, ⌘⇧G | Find in the active file item (file items only) |
| ⌘R | Reload the Files panel and the active file item (only while a file item is active or the tree has focus) |
| ⌘T | Unchanged (new tab here); no longer closes an overlay |

The overlay's Esc-to-close goes away.

## Glossary changes (CONTEXT.md)

- Remove **Files overlay**.
- Add **Files panel**: the file tree of one Workspace under the agent list, following the
  active Open item. Reads files, Upload and Download; never overwrites, edits or deletes.
  _Avoid_: files overlay, file browser.
- Add **Open item**: an agent Pane or a file the user opened, shown as a tab in the
  **Open strip** above the main area, across all Machines and Sessions.
  _Avoid_: tab (a herdr Tab is a layout of Panes), editor.
- Add **File viewer**: the main area's view of the active file Open item.
  _Avoid_: file lens (a Lens views a Pane).
- **Files watch**: now owned by the Files panel.

## Testing

- `src/store/openItems.test.ts`: open / pin / preview replacement across kinds, close scopes,
  active hand-over on close, pruning agent and file items, machine removal. Built from
  `openAgents.test.ts` and the tab cases of `files/store.test.ts`.
- `src/store/app.test.ts`: `select` makes the agent item active; activating a file item keeps
  `selected`.
- `OpenStrip.test.tsx` from `AgentTabs.test.tsx`, plus file items.
- `FilesPanel.test.tsx` and `FileViewer.test.tsx` from `FilesOverlay.test.tsx` (root
  resolution, missing folder, offline, watch-driven reload, find, outline, modes).
- `fileLinks` test: a link opens a file item instead of the overlay.
- `App.test.tsx`: the "Workspace Files" entry is gone; ⌘E focuses the tree; a file item shows
  the File viewer in the main area.
- Run in the real app before calling it done.
