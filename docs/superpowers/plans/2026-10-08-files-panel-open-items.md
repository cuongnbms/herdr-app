# Files panel and Open items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Files overlay with an always-present Files panel under the agent list, and show opened files as tabs next to opened agents, read in the main area.

**Architecture:** One list of Open items (agent or file) in `useApp`, managed by pure functions in `src/store/openItems.ts`. The overlay splits into `FilesPanel` (tree, Go to file, watch; in the agents column) and `FileViewer` (one file; in the main area), which talk through a small change bus store. `OpenStrip` replaces `AgentTabs` and `FileTabs`.

**Tech Stack:** React 19, TypeScript, zustand, vitest + Testing Library, Tauri IPC (mocked in tests).

**Spec:** `docs/superpowers/specs/2026-10-08-files-panel-open-items-design.md`

## Global Constraints

- Work on `main` (the user chose it). Commit after each task; messages follow the repo's Conventional Commits style (`feat(files): …`, `refactor(files): …`).
- Run commands from the repo root. Tests: `npx vitest run <path>`; full suite `npm test`; types `npm run typecheck`. If `pnpm`/`npx` is missing from PATH, see memory note on mise (`export PATH="$HOME/.local/share/mise/shims:$PATH"`).
- `CloseScope` (`"others" | "right" | "all"`) moves to `src/store/openItems.ts`; every importer imports it from there.
- Item keys: `itemKey({kind:"agent",ref}) = "agent:" + paneKey(ref)`; `itemKey({kind:"file",ws,root,rel}) = "file:" + filesKey(ws, root) + "|" + rel`. No other code builds these strings by hand.
- Nothing new is persisted to `localStorage` (splitter height, collapsed state and Open items live for the running app only).
- UI copy, exactly: panel header `FILES`; empty panel `Select an agent to browse its files`; keep the overlay's existing strings (`Machine offline`, `Auto-refresh stopped: …`, `This workspace has no folder.`, `This folder no longer exists.`, `Change folder…`, `Set as workspace folder`, `File removed`, `Could not reload: …`). The overlay's `Open a file from the tree, or press ⌘P` goes away.
- Comment density and naming follow the surrounding code (short JSDoc on exported functions, no narration comments).

## Review Focus

- Closing the active file item while the selected Pane is an agent with no item: the main area must fall back to that Pane's lens, not stay blank. (Task 2 test.)
- A file item from workspace A active while the selected Pane is in workspace B: the panel must show A's tree and B's Pane stays selected. (Task 4 test.)
- A machine going offline then reconnecting with the file's Workspace still present must keep its file items; only a connected snapshot without the Workspace drops them. (Task 1 test.)
- ⌘F / ⌘G / ⌘R must do nothing while an agent item is active (the Chat lens has its own ⌘F handling). (Task 3 test.)
- Chat file link to a file outside the workspace folder still toasts and opens nothing. (Task 5 test.)

---

### Task 1: Open items reducer

**Files:**
- Create: `src/store/openItems.ts`
- Create: `src/store/openItems.test.ts`
- Delete (in Task 2, not here): `src/agents/openAgents.ts`, `src/agents/openAgents.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CloseScope = "others" | "right" | "all";
  export type OpenItem = { kind: "agent"; ref: PaneRef } | { kind: "file"; ws: WorkspaceRef; root: string; rel: string };
  export interface OpenItems { items: OpenItem[]; preview: string | null; active: string | null }
  export const NO_ITEMS: OpenItems;
  export function itemKey(item: OpenItem): string;
  export function findItem(s: OpenItems, key: string): OpenItem | undefined;
  /** Opens `item` (pinned or as the preview) and makes it active. */
  export function openItem(s: OpenItems, item: OpenItem, opts: { pin: boolean }): OpenItems;
  export function pinItem(s: OpenItems, key: string): OpenItems;       // clears preview if it is `key`; else returns s
  export function setActive(s: OpenItems, key: string | null): OpenItems; // unknown key → s
  /** Closes relative to `key`; a closed active item hands over to `key` if it survives, else the item now at its index, else the one before, else null. Unknown key → s. */
  export function closeItems(s: OpenItems, scope: "one" | CloseScope, key: string): OpenItems;
  /** Moves `active` by `delta`, wrapping; no active → first item. Empty → s. */
  export function cycleItem(s: OpenItems, delta: 1 | -1): OpenItems;
  /** For machine `v`: drops agent items whose Pane is gone and file items whose Workspace is gone. Call only with a connected snapshot. */
  export function pruneItems(s: OpenItems, v: MachineView): OpenItems;
  /** Drops the items `gone` matches; returns s when none match. A dropped active becomes null. */
  export function dropItems(s: OpenItems, gone: (i: OpenItem) => boolean): OpenItems;
  ```
  `WorkspaceRef` is from `src/workspaces/folder`; `filesKey` from `src/files/store`.

- [ ] **Step 1: Write the failing test** `src/store/openItems.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { MachineView, PaneRef } from "../lib/types";
import { closeItems, cycleItem, dropItems, itemKey, NO_ITEMS, openItem, pinItem, pruneItems, setActive, type OpenItem, type OpenItems } from "./openItems";

const ws = (workspace_id = "w1", session = "s", machine_id = "local") => ({ machine_id, session, workspace_id });
const a = (pane_id: string, session = "s", machine_id = "local"): OpenItem => ({ kind: "agent", ref: { machine_id, session, pane_id } as PaneRef });
const f = (rel: string, w = ws(), root = "/r"): OpenItem => ({ kind: "file", ws: w, root, rel });
const k = itemKey;
const pin = { pin: true };
const peek = { pin: false };
const of = (items: OpenItem[], preview: OpenItem | null = null, active: OpenItem | null = null): OpenItems => ({
  items, preview: preview && k(preview), active: active && k(active),
});

describe("open items", () => {
  it("keys agents by pane and files by workspace, root and path", () => {
    expect(k(a("p1"))).toBe("agent:local/s/p1");
    expect(k(f("src/a.ts"))).toBe("file:local/s/w1|/r|src/a.ts");
  });

  it("an unpinned open of either kind replaces the preview in place and becomes active", () => {
    let s = openItem(of([a("p1")]), f("x.md"), peek);
    expect(s).toEqual(of([a("p1"), f("x.md")], f("x.md"), f("x.md")));
    s = openItem(s, a("p2"), peek);
    expect(s).toEqual(of([a("p1"), a("p2")], a("p2"), a("p2")));
  });

  it("a pinned open promotes the preview; opening an open item only activates it", () => {
    const s = openItem(of([a("p1")]), f("x.md"), peek);
    expect(openItem(s, a("p2"), pin)).toEqual(of([a("p1"), f("x.md"), a("p2")], null, a("p2")));
    expect(openItem(s, a("p1"), peek)).toEqual(of([a("p1"), f("x.md")], f("x.md"), a("p1")));
    expect(openItem(s, f("x.md"), pin)).toEqual(of([a("p1"), f("x.md")], null, f("x.md")));
    expect(pinItem(s, k(f("x.md")))).toEqual(of([a("p1"), f("x.md")], null, f("x.md")));
    expect(pinItem(s, k(a("p1")))).toBe(s);
  });

  it("closes one, others, to the right, or all, handing the active item over", () => {
    const s = of([a("p1"), f("b"), a("p3"), f("d")], f("d"), f("b"));
    expect(closeItems(s, "one", k(f("b")))).toEqual(of([a("p1"), a("p3"), f("d")], f("d"), a("p3")));
    expect(closeItems(of([a("p1"), f("b")], null, f("b")), "one", k(f("b")))).toEqual(of([a("p1")], null, a("p1")));
    expect(closeItems(s, "others", k(a("p3")))).toEqual(of([a("p3")], null, a("p3")));
    expect(closeItems(s, "right", k(f("b")))).toEqual(of([a("p1"), f("b")], null, f("b")));
    expect(closeItems(s, "all", k(f("b")))).toEqual(NO_ITEMS);
    expect(closeItems(s, "one", k(a("nope")))).toBe(s);
  });

  it("cycles the active item with wrap-around", () => {
    const s = of([a("p1"), f("b"), a("p3")], null, a("p3"));
    expect(cycleItem(s, 1).active).toBe(k(a("p1")));
    expect(cycleItem(s, -1).active).toBe(k(f("b")));
    expect(cycleItem(of([a("p1"), f("b")]), 1).active).toBe(k(a("p1")));
    expect(cycleItem(NO_ITEMS, 1)).toBe(NO_ITEMS);
  });

  it("setActive ignores unknown keys", () => {
    const s = of([a("p1")]);
    expect(setActive(s, k(a("p1"))).active).toBe(k(a("p1")));
    expect(setActive(s, "agent:nope")).toBe(s);
    expect(setActive(s, null).active).toBeNull();
  });

  it("prunes gone panes and gone workspaces of that machine only", () => {
    const v = { id: "local", sessions: [{ name: "s", workspaces: [{ workspace_id: "w1", tabs: [{ panes: [{ pane_id: "p1" }] }] }] }] } as unknown as MachineView;
    const s = of([a("p1"), a("p2"), f("x", ws("w1")), f("y", ws("w2")), a("p9", "s", "devtuf"), f("z", ws("w2", "s", "devtuf"))], null, f("y", ws("w2")));
    expect(pruneItems(s, v)).toEqual(of([a("p1"), f("x", ws("w1")), a("p9", "s", "devtuf"), f("z", ws("w2", "s", "devtuf"))]));
  });

  it("dropItems keeps the same object when nothing matches", () => {
    const s = of([a("p1"), f("x")]);
    expect(dropItems(s, () => false)).toBe(s);
    expect(dropItems(s, (i) => i.kind === "file")).toEqual(of([a("p1")]));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/store/openItems.test.ts`
Expected: FAIL, cannot resolve `./openItems`.

- [ ] **Step 3: Implement `src/store/openItems.ts`** with the Interfaces above. Port the logic of `src/agents/openAgents.ts` (`openTab`, `closeTabs`, `pruneTabs`, `dropTabs`, `keepPreview`) to `OpenItem`, keyed by `itemKey`; add `active` handling and `cycleItem` (from `files/store.ts` `cycle`).

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/store/openItems.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/openItems.ts src/store/openItems.test.ts
git commit -m "feat(tabs): one list of open agents and files"
```

---

### Task 2: App store uses Open items; Open strip replaces agent tabs

**Files:**
- Modify: `src/store/app.ts` (replace `agentTabs`, `pinAgentTab`, `closeAgentTabs`, `tabsAfterSnapshot`)
- Modify: `src/store/app.test.ts` (agent-tab cases → open-item cases)
- Create: `src/main/OpenStrip.tsx` (from `src/agents/AgentTabs.tsx`)
- Create: `src/main/OpenStrip.test.tsx` (from `src/agents/AgentTabs.test.tsx`)
- Delete: `src/agents/AgentTabs.tsx`, `src/agents/AgentTabs.test.tsx`, `src/agents/openAgents.ts`, `src/agents/openAgents.test.ts`
- Modify: `src/App.tsx` (render `OpenStrip` instead of `AgentTabs`), `src/files/store.ts` and `src/files/FileTabs.tsx` (import `CloseScope` from `../store/openItems`), any test that sets `agentTabs` (`src/agents/AgentList.test.tsx`, `src/chat/ChatLens.test.tsx`, `src/chat/ChatItemView.test.tsx`, `src/App.test.tsx`) → `openItems: NO_ITEMS`.

**Interfaces:**
- Consumes: everything from Task 1.
- Produces, on `AppState`:
  ```ts
  openItems: OpenItems;
  /** Opens a file item (pinned or as the preview) and makes it active; `selected` is unchanged. Records it in useFiles recent. */
  openFile: (ws: WorkspaceRef, root: string, rel: string, opts: { pin: boolean }) => void;
  /** Activates an item: an agent item selects its Pane; a file item only becomes active. */
  activateItem: (key: string) => void;
  pinItem: (key: string) => void;
  /** Closes relative to `key`; if the new active item is an agent, selects its Pane. */
  closeItems: (key: string, scope: "one" | CloseScope) => void;
  cycleItems: (delta: 1 | -1) => void;
  ```
  and the selector `export function activeItem(s: Pick<AppState, "openItems">): OpenItem | null`.
- Rules: `select(ref)` opens the agent's item unpinned and makes it active when the Pane has an agent; for a Pane without an agent it sets `openItems.active = null`. `upsertMachine` runs `pruneItems` on a connected snapshot, then (as today) opens the selected Pane's item if an agent just started there. `removeMachine` drops both kinds for that machine. `openFile` calls `useFiles.getState().addRecent(filesKey(ws, root), rel)` (add `addRecent(key, rel)` to `files/store.ts` by extracting the `recent` update from `open`).

- [ ] **Step 1: Write the failing tests.** In `src/store/app.test.ts`, replace the agent-tab `describe` with the following (reuse that file's existing machine fixture; `ref("p2")` etc. as already defined there):

```ts
describe("open items", () => {
  const fileItem = { kind: "file" as const, ws: { machine_id: "local", session: "default", workspace_id: "w2" }, root: "/r", rel: "a.md" };

  it("selecting an agent opens its item as the active preview", () => {
    useApp.getState().select(ref("p2"));
    const s = useApp.getState().openItems;
    expect(s.items).toEqual([{ kind: "agent", ref: ref("p2") }]);
    expect(s.active).toBe(itemKey({ kind: "agent", ref: ref("p2") }));
  });

  it("opening a file keeps the selected pane and makes the file active", () => {
    useApp.getState().select(ref("p2"));
    useApp.getState().openFile(fileItem.ws, "/r", "a.md", { pin: true });
    expect(useApp.getState().selected).toEqual(ref("p2"));
    expect(activeItem(useApp.getState())).toEqual(fileItem);
  });

  it("activating an agent item selects its pane", () => {
    useApp.getState().select(ref("p2"));
    useApp.getState().pinItem(itemKey({ kind: "agent", ref: ref("p2") }));
    useApp.getState().openFile(fileItem.ws, "/r", "a.md", { pin: true });
    useApp.getState().activateItem(itemKey({ kind: "agent", ref: ref("p2") }));
    expect(activeItem(useApp.getState())).toEqual({ kind: "agent", ref: ref("p2") });
  });

  it("closing the active file hands over to the agent and keeps the selection", () => {
    useApp.getState().select(ref("p2"));
    useApp.getState().pinItem(itemKey({ kind: "agent", ref: ref("p2") }));
    useApp.getState().openFile(fileItem.ws, "/r", "a.md", { pin: false });
    useApp.getState().closeItems(itemKey(fileItem), "one");
    expect(activeItem(useApp.getState())).toEqual({ kind: "agent", ref: ref("p2") });
    expect(useApp.getState().selected).toEqual(ref("p2"));
  });

  it("closing the only file leaves no active item and the selected pane stays", () => {
    useApp.getState().select(ref("p2"));
    useApp.getState().closeItems(itemKey({ kind: "agent", ref: ref("p2") }), "one");
    useApp.getState().openFile(fileItem.ws, "/r", "a.md", { pin: false });
    useApp.getState().closeItems(itemKey(fileItem), "one");
    expect(useApp.getState().openItems.active).toBeNull();
    expect(useApp.getState().selected).toEqual(ref("p2"));
  });

  it("closing the active agent selects the next agent item", () => {
    useApp.getState().select(ref("p2"));
    useApp.getState().pinItem(itemKey({ kind: "agent", ref: ref("p2") }));
    useApp.getState().select(ref("p3"));
    useApp.getState().closeItems(itemKey({ kind: "agent", ref: ref("p3") }), "one");
    expect(useApp.getState().selected).toEqual(ref("p2"));
  });

  it("a connected snapshot without the workspace drops its files; removing the machine drops all", () => {
    useApp.getState().openFile(fileItem.ws, "/r", "a.md", { pin: true });
    useApp.getState().upsertMachine({ ...machine, state: "disconnected", sessions: [] });
    expect(useApp.getState().openItems.items).toHaveLength(1);
    useApp.getState().upsertMachine({ ...machine, sessions: machine.sessions.map((s) => ({ ...s, workspaces: s.workspaces.filter((w) => w.workspace_id !== "w2") })) });
    expect(useApp.getState().openItems.items).toEqual([]);
    useApp.getState().openFile({ ...fileItem.ws, workspace_id: "w1" }, "/r", "b.md", { pin: true });
    useApp.getState().removeMachine("local");
    expect(useApp.getState().openItems).toEqual(NO_ITEMS);
  });
});
```

(Adjust `machine`, `ref` and the pane ids to the fixture names already in `app.test.ts`; the fixture must contain an agent pane `p2` and `p3` in workspace `w2` of session `default`. Add them if missing.)

In `src/main/OpenStrip.test.tsx`: port every case of `AgentTabs.test.tsx` (rename `agentTabs` → `openItems`, `pinAgentTab(ref)` → `pinItem(itemKey({kind:"agent",ref}))`), and add:

```ts
it("shows a file item by basename with its place in the tooltip, and activates it on click", () => {
  openPinned("p1");
  useApp.getState().openFile({ machine_id: "local", session: "default", workspace_id: "w2" }, "/r", "src/main.ts", { pin: true });
  useApp.getState().select(ref("p1"));
  render(<OpenStrip />);
  const tab = screen.getByRole("tab", { name: "main.ts" });
  expect(tab.closest(".files-tab-item")?.getAttribute("title")).toBe("local/default · herdr-app · src/main.ts");
  fireEvent.click(tab);
  expect(useApp.getState().openItems.active).toBe("file:local/default/w2|/r|src/main.ts");
  expect(useApp.getState().selected).toEqual(ref("p1"));
});

it("marks the active item, not the selected pane, as selected", () => {
  openPinned("p1");
  useApp.getState().openFile({ machine_id: "local", session: "default", workspace_id: "w2" }, "/r", "a.md", { pin: true });
  render(<OpenStrip />);
  expect(screen.getByRole("tab", { name: "a.md" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tab", { name: "Mermaid diagram" }).getAttribute("aria-selected")).toBe("false");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/store/app.test.ts src/main/OpenStrip.test.tsx`
Expected: FAIL (`openFile` / `OpenStrip` not defined).

- [ ] **Step 3: Implement.** In `app.ts` swap `agentTabs` for `openItems` per the Interfaces. Build `OpenStrip` from `AgentTabs`: `tabs` derived from `openItems.items`, an agent item resolved as today (skip if its Pane is not found), a file item shown with `FileIcon` (`src/ui/icons`; add one if none fits, matching the existing icon style) and `basename(rel)`, tooltip `${machine.label}/${ws.session} · ${workspace.label} · ${rel}`; `aria-selected` from `openItems.active`; click → `activateItem`, double-click → `pinItem`, middle-click / close button / menu → `closeItems`. Delete the old files and update importers listed above.

- [ ] **Step 4: Run tests and types**

Run: `npx vitest run src/store src/main src/agents src/chat && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A src/store src/main src/agents src/chat src/files/store.ts src/files/FileTabs.tsx src/App.tsx src/App.test.tsx
git commit -m "feat(tabs): opened files and agents share one tab strip"
```

---

### Task 3: File viewer and the change bus

**Files:**
- Create: `src/files/bus.ts` — change bus store
- Create: `src/files/FileViewer.tsx` — the overlay's `files-main` for one file item
- Create: `src/files/FileViewer.test.tsx`
- Modify: `src/files/FilesOverlay.tsx` (use `FileViewer` for its main side and publish to the bus, so the overlay keeps working until Task 5 removes it)

**Interfaces:**
- Consumes: `OpenItem` (file variant), `useApp().closeItems` / `cycleItems` are NOT used here (Task 5 owns ⌘W and ⌘⇧[]).
- Produces:
  ```ts
  // src/files/bus.ts
  export interface ChangeBatch { seq: number; changes: FileChange[] }
  export const useFilesBus: UseBoundStore<StoreApi<{
    batches: Record<string, ChangeBatch>;   // by filesKey
    reloads: Record<string, number>;         // by filesKey, bumped by reload
    publish(key: string, changes: FileChange[]): void;  // seq = previous seq + 1
    reload(key: string): void;
  }>>;
  // src/files/FileViewer.tsx
  export function FileViewer(props: { item: Extract<OpenItem, { kind: "file" }>; online: boolean }): JSX.Element;
  ```
- `FileViewer` owns: reading (`latestOnly(filesRead)`), reload on `reloads[key]` change, reacting to `batches[key]` exactly as `FilesBrowser.onChanges` does for the active file today (own change → reload or "File removed"; folder above changed → reload), breadcrumbs + Copy path / Copy contents, Outline, Render/Source, find bar, `FileView`, banners, link fragment (`jump`), scroll via `useFiles.setScroll`. Links inside a file call `useApp.getState().openFile(item.ws, item.root, rel, { pin: false })`. Its keys (`⌘F`, `⌘G`, `⌘⇧G`, `⌘R` → `useFilesBus.reload(key)`) are bound on `window` only while it is mounted, and ignore events while `.overlay` exists (as today).

- [ ] **Step 1: Write the failing tests.** Move these cases from `FilesOverlay.test.tsx` into `FileViewer.test.tsx`, rendering `<FileViewer item={item} online />` with `const item = { kind: "file", ws: ref, root: "/r", rel: "<file>" }` instead of opening a tab, keeping the same `vi.mock` header: "opens a small markdown file rendered and one over the highlight limit as source", "a #L link to a markdown file opens it as source" (pass the hash via a link click from another file, as the original does), "⌘F finds…", "Match case…", "Copy contents…" (both), "Esc closes a zoomed diagram…" (assert only that the diagram closes), "shows a read error…", "keeps the file shown and adds a banner…", "reloads the open file when the watch reports it written", "shows File removed…" (both), "re-reads the open file when a folder above its parent changes". Watch events are delivered with `act(() => useFilesBus.getState().publish(filesKey(ref, "/r"), changes))` instead of channel messages. Add:

```ts
it("⌘R reloads the file through the bus", async () => {
  render(<FileViewer item={item} online />);
  await screen.findByText("x");
  vi.mocked(invoke).mockClear();
  fireEvent.keyDown(window, { key: "r", metaKey: true });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_read", expect.objectContaining({ rel: "a.txt" })));
  expect(useFilesBus.getState().reloads[filesKey(ref, "/r")]).toBe(1);
});

it("does not bind its keys once unmounted", () => {
  const { unmount } = render(<FileViewer item={item} online />);
  unmount();
  fireEvent.keyDown(window, { key: "r", metaKey: true });
  expect(useFilesBus.getState().reloads[filesKey(ref, "/r")]).toBeUndefined();
});
```

(with `const item = { kind: "file" as const, ws: ref, root: "/r", rel: "a.txt" }` and `useFilesBus.setState(useFilesBus.getInitialState(), true)` in `beforeEach`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/files/FileViewer.test.tsx`
Expected: FAIL, cannot resolve `./FileViewer`.

- [ ] **Step 3: Implement** `bus.ts` and `FileViewer.tsx` by moving code out of `FilesBrowser`; make `FilesBrowser` render `<FileViewer>` for its active tab and call `useFilesBus.publish` from its `useWatch.onChanges` and `reload` → `useFilesBus.reload`.

- [ ] **Step 4: Run tests and types**

Run: `npx vitest run src/files && npm run typecheck`
Expected: PASS (the remaining overlay tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/files
git commit -m "refactor(files): the file view stands on its own, fed by a change bus"
```

---

### Task 4: Files panel in the agents column

**Files:**
- Create: `src/files/panelStore.ts`
- Create: `src/files/FilesPanel.tsx`
- Create: `src/files/FilesPanel.test.tsx`
- Modify: `src/files/root.ts` (rename `overlayRoot` → `panelRoot`, add `panelWorkspace`; update `chat/fileLinks.ts` import)
- Modify: `src/App.tsx` (agents column: `AgentList`, splitter, `FilesPanel`), `src/styles.css`

**Interfaces:**
- Consumes: `activeItem` (Task 2), `useFilesBus` (Task 3), `useApp().openFile`.
- Produces:
  ```ts
  // src/files/root.ts
  /** The Workspace the Files panel shows: the active item's, else the selected Pane's. */
  export function panelWorkspace(s: Pick<AppState, "machines" | "selected" | "openItems">): WorkspaceRef | null;
  export function panelRoot(ref: WorkspaceRef, state: Pick<AppState, "machines" | "selected">): Root | null; // was overlayRoot
  // src/files/panelStore.ts (not persisted)
  export const useFilesPanel: UseBoundStore<StoreApi<{
    height: number | null;      // px of the panel; null = half the column
    collapsed: boolean;
    focusTick: number;          // bumped to focus the tree
    gotoTick: number;           // bumped to focus Go to file
    setHeight(px: number): void;
    setCollapsed(on: boolean): void;
    focusTree(): void;          // expands, bumps focusTick
    focusGoto(): void;          // expands, bumps gotoTick
  }>>;
  // src/files/FilesPanel.tsx
  export function FilesPanel(): JSX.Element;
  ```
- `FilesPanel` renders the header always; when not collapsed, a per-Workspace body keyed by `wsKey(ws)` that keeps the overlay's root rules (resolved once, again when the folder is set). Root used = the active file item's `root` when the active item is a file of this Workspace, else the resolved root. The body is keyed by `filesKey(ws, root)` for listing (`filesListAll`), `useWatch` (publishing to `useFilesBus`; root removed → missing state), `GoToFile` (recent from `useFiles`), and `FileTree` (`onOpen(rel, pin)` → `openFile(ws, root, rel, { pin })`). Reload button and `reloads[key]` both re-list. ⌘R while focus is inside `.files-panel` calls `useFilesBus.reload(key)` (the File viewer's own ⌘R handles the case where a file item is active; when both apply, reload once). Splitter: a `role="separator" aria-orientation="horizontal"` between list and panel; dragging sets `height`, clamped so both halves keep at least 120 px.

- [ ] **Step 1: Write the failing tests.** Port from `FilesOverlay.test.tsx` (rendering `<FilesPanel />` with `selected: { machine_id: "local", session: "default", pane_id: "p1" }` instead of `filesOverlay`): "shows the root from the pane and offers to save it…", "toggles heavy folders…", "shows Machine offline…", "offers Change folder… when the root does not exist", "does not call the root missing when the machine is disconnected", "clears the missing state on reload…", "keeps the root it opened with; setting a folder re-resolves it…", "shows the folder missing when the watch reports the root removed", all the resync cases, "shows and clears the auto-refresh error". Drop the Esc cases. Add:

```ts
it("shows nothing to browse with no selection and no open file", () => {
  useApp.setState({ selected: null, openItems: NO_ITEMS });
  render(<FilesPanel />);
  expect(screen.getByText("Select an agent to browse its files")).toBeTruthy();
});

it("follows the active file item's workspace and root, not the selected pane's", async () => {
  // machines fixture gains workspace w2 (label "other") with pane p2 at /o
  useApp.getState().openFile({ machine_id: "local", session: "default", workspace_id: "w2" }, "/o", "a.md", { pin: true });
  render(<FilesPanel />);
  expect(screen.getByText(/FILES/).textContent).toContain("other");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_list_all", expect.objectContaining({ root: "/o" })));
  expect(useApp.getState().selected?.pane_id).toBe("p1");
});

it("clicking a file opens it as the active preview item", async () => {
  vi.mocked(invoke).mockImplementation((async (cmd: string) =>
    cmd === "files_list_dir" ? [{ name: "a.md", isDir: false }] : cmd === "files_watch" ? 1 : { paths: [], capped: false, refused: false }) as never);
  render(<FilesPanel />);
  fireEvent.click(await screen.findByText("a.md"));
  expect(useApp.getState().openItems.active).toBe("file:local/default/w1|/r|a.md");
  expect(useApp.getState().openItems.preview).toBe("file:local/default/w1|/r|a.md");
});

it("collapse hides the tree; focusTree expands it and focuses the tree", async () => {
  render(<FilesPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Collapse files" }));
  expect(screen.queryByRole("tree")).toBeNull();
  act(() => useFilesPanel.getState().focusTree());
  await waitFor(() => expect(document.activeElement?.closest("[role=tree]")).toBeTruthy());
});
```

(Match `files_list_dir` and the entry shape to what `FileTree.test.tsx` mocks; match the tree's role to `FileTree`'s actual root role.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/files/FilesPanel.test.tsx`
Expected: FAIL, cannot resolve `./FilesPanel`.

- [ ] **Step 3: Implement** `panelStore.ts`, `panelWorkspace`/`panelRoot`, `FilesPanel.tsx` (moving `FilesShell`'s root logic and `FilesBrowser`'s side half), the agents-column layout in `App.tsx` and its CSS (`.agents` becomes a column: `.agents-list` flex part, `.files-split` separator, `.files-panel` with the stored height; collapsed → header only).

- [ ] **Step 4: Run tests and types**

Run: `npx vitest run src/files src/App.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/files src/App.tsx src/styles.css src/chat/fileLinks.ts
git commit -m "feat(files): the file tree lives under the agent list"
```

---

### Task 5: Main area shows files; keys and entry points; overlay removed

**Files:**
- Modify: `src/App.tsx` (main area, keys), `src/App.test.tsx`
- Modify: `src/chat/fileLinks.ts` (+ its test, or `ChatItemView.test.tsx` where links are tested)
- Modify: `src/agents/AgentList.tsx` ("Browse files"), `src/agents/AgentList.test.tsx`
- Modify: `src/sidebar/Sidebar.tsx` (remove `FilesEntry`)
- Modify: `src/store/app.ts` (remove `filesOverlay`, `setFilesOverlay` and their uses in `select`/`setDashboardOpen`)
- Modify: `src/files/store.ts` (remove `tabs`, `preview`, `active`, `open`, `pin`, `close`, `closeTabs`, `cycle`), `src/files/store.test.ts`
- Delete: `src/files/FilesOverlay.tsx`, `src/files/FilesOverlay.test.tsx` (by now empty of unique cases), `src/files/FilesEntry.tsx`, `src/files/FilesEntry.test.tsx`, `src/files/FileTabs.tsx`, `src/files/FileTabs.test.tsx`
- Modify: `src/styles.css` (drop `.files-overlay`, `.files-entry`, `.files-head` rules no longer used)
- Modify: `README.md` where it describes Workspace Files / ⌘E (one or two sentences; keep screenshots).

**Interfaces:**
- Consumes: `activeItem`, `openFile`, `closeItems`, `cycleItems` (Task 2); `FileViewer` (Task 3); `useFilesPanel` (Task 4).
- App main area: if `activeItem` is a file → `Header` (only when a Pane is selected) + `OpenStrip` + `<FileViewer key={itemKey(item)} item online={machine.state === "connected"} />`; otherwise today's branches with `OpenStrip` in place of `AgentTabs`, and `OpenStrip` also shown above the empty states when it has items.
- Keys in `App.tsx` (skip when `.overlay` exists, as the other handlers do): ⌘E → `useFilesPanel.focusTree()`; ⌘P → `focusGoto()` (only when no dialog/palette is open; the palette keeps ⌘K); ⌘W → `closeItems(active, "one")` when there is an active item; ⌘⇧[ / ⌘⇧] → `cycleItems(∓1/±1)`. ⌘T no longer touches files.
- `openInFiles(pane, path, hash?)` in `fileLinks.ts`: same checks; on success `useApp.getState().openFile(ref, root.path, rel, { pin: false })` and pass the fragment so `FileViewer` jumps to it (store the pending fragment in `useFilesBus` as `jump: { key: string; hash: string } | null` with `setJump`; `FileViewer` reads and clears it for its own key). Update the Task 3 `jump` handling to read the same field so in-file links and chat links share it.
- "Browse files": `useApp.getState().select(paneRef)` then `useFilesPanel.getState().focusTree()`.

- [ ] **Step 1: Write the failing tests** in `src/App.test.tsx`:

```ts
it("has no Workspace Files entry in the sidebar", () => {
  render(<App />);
  expect(screen.queryByText("Workspace Files")).toBeNull();
});

it("shows the active file item in the main area and the lens again when it closes", async () => {
  // fixture: selected agent pane p1 in workspace w1 (existing App.test fixture)
  render(<App />);
  act(() => useApp.getState().openFile({ machine_id: "local", session: "default", workspace_id: "w1" }, "/r", "a.txt", { pin: false }));
  expect(await screen.findByLabelText("Copy path")).toBeTruthy();
  fireEvent.keyDown(window, { key: "w", metaKey: true });
  await waitFor(() => expect(screen.queryByLabelText("Copy path")).toBeNull());
  expect(useApp.getState().selected?.pane_id).toBe("p1");
});

it("⌘E expands the Files panel and focuses it", () => {
  useFilesPanel.setState({ collapsed: true });
  render(<App />);
  fireEvent.keyDown(window, { key: "e", metaKey: true });
  expect(useFilesPanel.getState().collapsed).toBe(false);
  expect(useFilesPanel.getState().focusTick).toBe(1);
});

it("⌘⇧] moves to the next open item", () => {
  render(<App />);
  act(() => {
    useApp.getState().pinItem(itemKey({ kind: "agent", ref: useApp.getState().selected! }));
    useApp.getState().openFile({ machine_id: "local", session: "default", workspace_id: "w1" }, "/r", "a.txt", { pin: true });
  });
  fireEvent.keyDown(window, { key: "]", code: "BracketRight", metaKey: true, shiftKey: true });
  expect(activeItem(useApp.getState())?.kind).toBe("agent");
});
```

In the chat link test (where `openInFiles` is covered today), replace the overlay assertions with:

```ts
expect(useApp.getState().openItems.active).toBe("file:local/default/w1|/r|src/a.ts");
expect(useApp.getState().selected).toEqual(paneRef);
```

and keep the "outside the workspace folder" toast case asserting `openItems.items` is unchanged. In `AgentList.test.tsx`, "Browse files" asserts `useFilesPanel.getState().focusTick` increased and the pane is selected.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/App.test.tsx src/agents src/chat`
Expected: FAIL (Workspace Files still present; no file viewer in main).

- [ ] **Step 3: Implement** per the Interfaces; delete the listed files and dead CSS; slim `files/store.ts` and its test to `expanded`, `scroll`, `recent` (`addRecent`, `toggleDir`, `setScroll`).

- [ ] **Step 4: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass, no type errors, build succeeds. `grep -rn "filesOverlay\|FilesOverlay\|FilesEntry\|agentTabs\|AgentTabs\|FileTabs" src` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add -A src README.md
git commit -m "feat(files): files open as tabs in the main area; Workspace Files overlay removed"
```

---

### Task 6: Check it in the real app

**Files:** none (fixes found here go in their own commit).

- [ ] **Step 1:** Launch the app with the `run` skill and check by eye, on a local and an ssh machine: the tree shows under the agent list for the selected agent's workspace; the splitter drags and collapse works; clicking a file opens a preview tab next to agent tabs and the main area shows it; clicking an agent tab returns to Chat with the same scroll; a chat file link opens a tab; ⌘E, ⌘P, ⌘W, ⌘⇧[ / ⌘⇧], ⌘F, ⌘R behave per the spec's Keys table; editing a file on disk reloads it in the viewer.
- [ ] **Step 2:** Report what was checked and anything that did not behave; fix with a test first, commit as `fix(files): …`.
