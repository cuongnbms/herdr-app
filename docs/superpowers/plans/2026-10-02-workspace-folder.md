# Workspace folder and "New agent" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remember a folder per herdr Workspace and let the user start an Agent for a Workspace from the Agents column, in a new Tab in that folder.

**Architecture:** Frontend only. A small `localStorage`-backed module (`src/workspaces/folder.ts`) with a subscribe hook holds the folders; the store prunes stale entries when machine views arrive. `AgentList` groups Pane cards under Workspace headers with a `+` button that opens a `NewAgentDialog` (wired through `ActionsProvider`), which calls herdr `tab.create { cwd }` then `agent.start`.

**Tech Stack:** React 18 + TypeScript, zustand, Vitest + Testing Library (jsdom), Tauri IPC via `herdrCall`.

**Spec:** `docs/superpowers/specs/2026-10-02-workspace-folder-design.md`

## Global Constraints

- No Rust, IPC command or `src/lib/types.ts` changes.
- Storage key: `"herdr-app:ws-folder:" + [machine_id, session, workspace_id].map(encodeURIComponent).join("/")`; value is the trimmed path string. Built only by `folderKey` in `src/workspaces/folder.ts`.
- Every `localStorage` access is inside `try/catch`; a failure reads as "no folder" and writes are silently dropped (same as `src/store/app.ts`).
- Errors from herdr calls in dialogs go to the `onError(message)` prop, which `ActionsProvider` shows as its `action-error` line (the spec's "toast"); message is `(e as { message?: string }).message ?? String(e)`, as in `NewWorkspaceDialog`.
- Agent kinds offered: `claude` (default), `pi`. `agent.start` params are `{ name: agent, kind: agent, pane_id }`.
- UI copy (exact): header `+` button `aria-label` = `New agent in <label>`; no-folder text `no folder`; dialog title `New agent in <label>`, `aria-label` `New agent`, fields `Agent`, `Folder`, buttons `Cancel` / `Start`; change-folder dialog title `Workspace folder`, submit `Save`; header menu items `New agent…`, `Change folder…`, `Rename workspace…`, `Close workspace`.
- Verify each task with `npm test` and `npm run typecheck`, both clean.

## Review Focus

- Folder typed with trailing slash or as `~` → header shows a sensible basename (`folderName("/a/b/")` = `"b"`, `folderName("~")` = `"~"`). Test in Task 1.
- Whitespace-only folder in the dialog → nothing is called and nothing is saved. Test in Task 4.
- `localStorage.getItem` throwing → `getFolder` returns `null`, no crash. Test in Task 1.
- Running Session whose snapshot has not arrived (`workspaces: []`) → folders are kept. Test in Task 2.
- First Pane without a cwd → suggestion uses the first Pane (in Tab order) that has one. Test in Task 1.

---

### Task 1: Folder storage module

**Files:**
- Create: `src/workspaces/folder.ts`
- Test: `src/workspaces/folder.test.ts`

**Interfaces:**
- Produces:
  - `interface WorkspaceRef { machine_id: string; session: string; workspace_id: string }`
  - `folderKey(ref: WorkspaceRef): string`
  - `getFolder(ref: WorkspaceRef): string | null`
  - `setFolder(ref: WorkspaceRef, path: string): void` — trims; empty after trim removes the key; notifies subscribers.
  - `suggestFolder(ws: WorkspaceView): string` — cwd of the first Pane (Tab order, then Pane order) with a non-empty cwd, else `""`.
  - `pruneFolders(machineId: string, session: SessionView): void` — no-op unless `session.running && !session.error && session.workspaces.length > 0`; otherwise removes every key with prefix `folderKey`-prefix for that machine/session whose workspace id is not in `session.workspaces`; notifies subscribers if anything was removed.
  - `useFolder(ref: WorkspaceRef): string | null` — `useSyncExternalStore` over a module-level listener set.
  - `folderName(path: string): string` — last non-empty `/` segment, else the path itself.

- [ ] **Step 1: Write the failing test**

```ts
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { folderKey, folderName, getFolder, pruneFolders, setFolder, suggestFolder, useFolder } from "./folder";
import type { PaneView, SessionView, WorkspaceView } from "../lib/types";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };
const pane = (id: string, cwd: string | null): PaneView => ({ pane_id: id, terminal_id: "t" + id, title: id, cwd, agent: null, status: "idle" });
const ws = (id: string, ...cwds: (string | null)[][]): WorkspaceView => ({
  workspace_id: id, label: id, number: 1, status: "idle",
  tabs: cwds.map((cs, i) => ({ tab_id: `${id}:t${i}`, label: String(i), number: i + 1, status: "idle", panes: cs.map((c, j) => pane(`${id}:p${i}${j}`, c)) })),
});
const session = (over: Partial<SessionView>): SessionView => ({ name: "default", running: true, status: "idle", error: null, workspaces: [ws("w1", ["/a"])], ...over });

describe("workspace folder", () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("round-trips, trims, and removes on empty", () => {
    expect(getFolder(ref)).toBeNull();
    setFolder(ref, "  /Users/me/app  ");
    expect(getFolder(ref)).toBe("/Users/me/app");
    expect(localStorage.getItem("herdr-app:ws-folder:local/default/w1")).toBe("/Users/me/app");
    setFolder(ref, "   ");
    expect(getFolder(ref)).toBeNull();
  });

  it("encodes key parts", () => {
    expect(folderKey({ machine_id: "a/b", session: "s", workspace_id: "w1" })).toBe("herdr-app:ws-folder:a%2Fb/s/w1");
  });

  it("reads as no folder when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(getFolder(ref)).toBeNull();
  });

  it("suggests the first pane cwd in tab order, skipping panes without one", () => {
    expect(suggestFolder(ws("w1", [null, "/b"], ["/c"]))).toBe("/b");
    expect(suggestFolder(ws("w1", [null]))).toBe("");
    expect(suggestFolder(ws("w1"))).toBe("");
  });

  it("names a folder by its last segment", () => {
    expect(folderName("/Users/me/herdr-app")).toBe("herdr-app");
    expect(folderName("/a/b/")).toBe("b");
    expect(folderName("~")).toBe("~");
    expect(folderName("/")).toBe("/");
  });

  it("prunes folders of workspaces gone from a running session only", () => {
    setFolder(ref, "/a");
    setFolder({ ...ref, workspace_id: "w2" }, "/b");
    setFolder({ ...ref, session: "other", workspace_id: "w2" }, "/c");
    pruneFolders("local", session({ running: false, workspaces: [] }));
    pruneFolders("local", session({ error: { code: "io", message: "x" }, workspaces: [ws("w1", ["/a"])] }));
    pruneFolders("local", session({ workspaces: [] }));
    expect(getFolder({ ...ref, workspace_id: "w2" })).toBe("/b");
    pruneFolders("local", session({}));
    expect(getFolder(ref)).toBe("/a");
    expect(getFolder({ ...ref, workspace_id: "w2" })).toBeNull();
    expect(getFolder({ ...ref, session: "other", workspace_id: "w2" })).toBe("/c");
  });

  it("re-renders subscribers on change", () => {
    const { result } = renderHook(() => useFolder(ref));
    expect(result.current).toBeNull();
    act(() => setFolder(ref, "/x"));
    expect(result.current).toBe("/x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workspaces/folder.test.ts`
Expected: FAIL, cannot resolve `./folder`.

- [ ] **Step 3: Implement `src/workspaces/folder.ts`** with the signatures in Interfaces. Pruning enumerates `localStorage.key(i)` for keys starting with `"herdr-app:ws-folder:" + encode(machineId) + "/" + encode(session.name) + "/"`, decodes the remainder as the workspace id, and collects removals before deleting.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/workspaces/folder.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/workspaces/folder.ts src/workspaces/folder.test.ts
git commit -m "feat(workspaces): remember a folder per workspace"
```

### Task 2: Prune folders when machine views arrive

**Files:**
- Modify: `src/store/app.ts` (`upsertMachine`)
- Test: `src/store/app.test.ts`

**Interfaces:**
- Consumes: `pruneFolders(machineId, session)`, `setFolder`, `getFolder` from Task 1.

- [ ] **Step 1: Write the failing test** (add to `describe("app store")` in `src/store/app.test.ts`, importing `getFolder, setFolder` from `"../workspaces/folder"`)

```ts
  it("drops folders of workspaces that left a running session", () => {
    setFolder({ machine_id: "local", session: "default", workspace_id: "w1" }, "/x");
    setFolder({ machine_id: "local", session: "default", workspace_id: "w7" }, "/gone");
    useApp.getState().upsertMachine(machine);
    expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w1" })).toBe("/x");
    expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w7" })).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/store/app.test.ts`
Expected: FAIL, `w7` folder still `"/gone"`.

- [ ] **Step 3: In `upsertMachine`, call `pruneFolders(v.id, s)` for each `s` of `v.sessions`** (outside the `set` updater, before or after it).

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/app.ts src/store/app.test.ts
git commit -m "feat(workspaces): prune folders of closed workspaces"
```

### Task 3: New workspace remembers its directory

**Files:**
- Modify: `src/sidebar/NewWorkspaceDialog.tsx`
- Test: `src/sidebar/NewWorkspaceDialog.test.tsx` (new)

**Interfaces:**
- Consumes: `setFolder`, `getFolder` from Task 1. `workspace.create` returns `{ workspace: { workspace_id }, root_pane: { pane_id } }`; extend the local `WorkspaceCreated` interface with `workspace: { workspace_id: string }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn() }));
import { herdrCall } from "../lib/ipc";
import { getFolder } from "../workspaces/folder";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";

describe("NewWorkspaceDialog", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it("stores the directory as the new workspace's folder", async () => {
    vi.mocked(herdrCall).mockResolvedValue({ type: "workspace_created", workspace: { workspace_id: "w5" }, root_pane: { pane_id: "w5:p1" } });
    render(<NewWorkspaceDialog machineId="local" session="default" defaultCwd="" onClose={() => {}} onError={() => {}} />);
    fireEvent.change(screen.getByLabelText("Directory"), { target: { value: " /srv/api " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w5" })).toBe("/srv/api"));
  });

  it("stores nothing when the directory is empty", async () => {
    vi.mocked(herdrCall).mockResolvedValue({ type: "workspace_created", workspace: { workspace_id: "w6" }, root_pane: { pane_id: "w6:p1" } });
    render(<NewWorkspaceDialog machineId="local" session="default" defaultCwd="" onClose={() => {}} onError={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalled());
    expect(getFolder({ machine_id: "local", session: "default", workspace_id: "w6" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/sidebar/NewWorkspaceDialog.test.tsx`
Expected: FAIL on the first test (folder `null`).

- [ ] **Step 3: After `workspace.create` resolves, call `setFolder({ machine_id: machineId, session, workspace_id: res.workspace.workspace_id }, cwd)` when `cwd.trim()` is non-empty**, before the optional `agent.start`.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar/NewWorkspaceDialog.tsx src/sidebar/NewWorkspaceDialog.test.tsx
git commit -m "feat(workspaces): new workspace remembers its directory"
```

### Task 4: New agent dialog and actions

**Files:**
- Create: `src/agents/NewAgentDialog.tsx`
- Modify: `src/sidebar/actions.tsx`
- Test: `src/agents/NewAgentDialog.test.tsx`

**Interfaces:**
- Consumes: `getFolder`, `setFolder`, `suggestFolder`, `WorkspaceRef` from Task 1; `useApp.getState().select(ref: PaneRef)`; `herdrCall`.
- Produces:
  - `NewAgentDialog({ machineId, session, workspace, onClose, onError }: { machineId: string; session: string; workspace: WorkspaceView; onClose: () => void; onError: (message: string) => void })`
  - `Actions.newAgent(machineId: string, session: string, workspace: WorkspaceView): void` — opens the dialog (new `Dialog` kind `"agent"`).
  - `Actions.changeFolder(ref: WorkspaceRef, initial: string): void` — opens `TextDialog` titled `Workspace folder`, submit `Save`; a non-empty trimmed value is passed to `setFolder` (empty submit does nothing).

Dialog behaviour: markup as `NewWorkspaceDialog` (`overlay` / `form.dialog role="dialog"`, Escape closes). `Folder` input is rendered only when `getFolder(ref)` is `null` at open, initial value `suggestFolder(workspace)`. On submit: if the folder to use (field value trimmed, or the stored folder) is empty, do nothing and keep the dialog open; otherwise close, `setFolder` if the field was shown, then `tab.create { workspace_id, cwd, label: agent, focus: false }` → `select({ machine_id, session, pane_id: root_pane.pane_id })` → `agent.start { name: agent, kind: agent, pane_id: root_pane.pane_id }`; any rejection → `onError`.

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn() }));
import { herdrCall } from "../lib/ipc";
import { useApp } from "../store/app";
import { getFolder, setFolder } from "../workspaces/folder";
import { NewAgentDialog } from "./NewAgentDialog";
import type { WorkspaceView } from "../lib/types";

const ws: WorkspaceView = { workspace_id: "w1", label: "api", number: 1, status: "idle", tabs: [
  { tab_id: "w1:t1", label: "1", number: 1, status: "idle", panes: [
    { pane_id: "w1:p1", terminal_id: "t1", title: "sh", cwd: "/srv/api", agent: null, status: "unknown" } ] } ] };
const ref = { machine_id: "local", session: "default", workspace_id: "w1" };

function respond(agentStart: () => Promise<unknown> = () => Promise.resolve(undefined)) {
  vi.mocked(herdrCall).mockImplementation((_m, _s, method) =>
    method === "tab.create"
      ? Promise.resolve({ type: "tab_created", tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p7" } })
      : agentStart());
}
const open = (onError = vi.fn()) => {
  const onClose = vi.fn();
  render(<NewAgentDialog machineId="local" session="default" workspace={ws} onClose={onClose} onError={onError} />);
  return { onClose, onError };
};

describe("NewAgentDialog", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); useApp.setState({ selected: null }); });

  it("asks for the folder the first time, prefilled from the first pane, and remembers it", async () => {
    respond();
    open();
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeTruthy();
    expect((screen.getByLabelText("Folder") as HTMLInputElement).value).toBe("/srv/api");
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "/srv/api2 " } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(getFolder(ref)).toBe("/srv/api2");
    expect(herdrCall).toHaveBeenNthCalledWith(1, "local", "default", "tab.create", { workspace_id: "w1", cwd: "/srv/api2", label: "claude", focus: false });
    expect(herdrCall).toHaveBeenNthCalledWith(2, "local", "default", "agent.start", { name: "claude", kind: "claude", pane_id: "w1:p7" });
    expect(useApp.getState().selected).toEqual({ machine_id: "local", session: "default", pane_id: "w1:p7" });
  });

  it("uses the remembered folder without asking", async () => {
    setFolder(ref, "/home/me/api");
    respond();
    open();
    expect(screen.queryByLabelText("Folder")).toBeNull();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "pi" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(herdrCall).toHaveBeenCalledTimes(2));
    expect(herdrCall).toHaveBeenNthCalledWith(1, "local", "default", "tab.create", { workspace_id: "w1", cwd: "/home/me/api", label: "pi", focus: false });
    expect(herdrCall).toHaveBeenNthCalledWith(2, "local", "default", "agent.start", { name: "pi", kind: "pi", pane_id: "w1:p7" });
  });

  it("does nothing for a blank folder", () => {
    respond();
    const { onClose } = open();
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(herdrCall).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(getFolder(ref)).toBeNull();
  });

  it("reports an agent.start failure and keeps the new pane selected", async () => {
    respond(() => Promise.reject({ code: "timeout", message: "agent did not become ready" }));
    const { onError } = open();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("agent did not become ready"));
    expect(useApp.getState().selected?.pane_id).toBe("w1:p7");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/agents/NewAgentDialog.test.tsx`
Expected: FAIL, cannot resolve `./NewAgentDialog`.

- [ ] **Step 3: Implement `src/agents/NewAgentDialog.tsx`** per the behaviour above.

- [ ] **Step 4: Wire `ActionsProvider`** in `src/sidebar/actions.tsx`: add `Dialog` kinds `{ kind: "agent"; machineId: string; session: string; workspace: WorkspaceView }` and `{ kind: "folder"; ref: WorkspaceRef; initial: string }`, the two `Actions` members from Interfaces, and their modals (`NewAgentDialog` with `onError={setError}`; `TextDialog` with `submitLabel="Save"`).

- [ ] **Step 5: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agents/NewAgentDialog.tsx src/agents/NewAgentDialog.test.tsx src/sidebar/actions.tsx
git commit -m "feat(agents): new agent dialog starting an agent in the workspace folder"
```

### Task 5: Agents column grouped by Workspace

**Files:**
- Modify: `src/agents/AgentList.tsx`, `src/styles.css` (after `.agent-cards`, ~line 231)
- Test: `src/agents/AgentList.test.tsx`

**Interfaces:**
- Consumes: `useFolder`, `folderName`, `WorkspaceRef` (Task 1); `Actions.newAgent`, `Actions.changeFolder`, `Actions.rename`, `Actions.confirm`, `Actions.menu` (Task 4); `suggestFolder` (Task 1) as the `changeFolder` initial value when no folder is stored.
- Produces: `workspaceGroups(session: SessionView): { workspace: WorkspaceView; entries: PaneEntry[] }[]` replacing `sessionPanes`; `PaneEntry.sub` is the Tab label when the Workspace has more than one Tab, else `""` (card hides the sub span when empty).

Layout: per group a `<section role="group" aria-label={ws.label} className="ws-group">` with a header row `.ws-head` (label `.ws-label`, folder `.ws-folder` with `title` = full path or `no folder`, button `.ws-add` with `PlusIcon` from `../ui/icons` and `aria-label="New agent in <label>"`), then the existing `<ul className="agent-cards">` of that group's cards (omitted when empty). The header's `onContextMenu` opens `New agent…`, `Change folder…`, `Rename workspace…`, `Close workspace` (rename/close calls unchanged from the current card menu). Card menu loses the two workspace entries. The header count stays the total Pane count. CSS: `.ws-head` flex row, label 600 weight, folder muted and ellipsized, `.ws-add` an icon button pushed right; reuse existing tokens in `styles.css`.

- [ ] **Step 1: Update the tests.** In `src/agents/AgentList.test.tsx`, add `localStorage.clear()` to `beforeEach`, import `setFolder` from `"../workspaces/folder"`, add an empty Workspace `{ workspace_id: "w3", label: "empty", number: 3, status: "unknown", tabs: [] }` to session `default`, replace the `sessionPanes` test, and change the context-menu test:

```tsx
describe("workspaceGroups", () => {
  it("groups panes by workspace, naming the tab only when a workspace has several", () => {
    const groups = workspaceGroups(m.sessions[0]);
    expect(groups.map((g) => [g.workspace.workspace_id, g.entries.map((e) => [e.pane.pane_id, e.sub])])).toEqual([
      ["w1", [["p1", ""]]],
      ["w2", [["p2", "ui"], ["p3", "release"], ["p4", "release"]]],
      ["w3", []],
    ]);
  });
});
```

```tsx
  it("shows a header per workspace with its folder, empty workspaces included", () => {
    setFolder({ machine_id: "local", session: "default", workspace_id: "w1" }, "/Users/me/checkout-api/");
    render(<AgentList />);
    const w1 = screen.getByRole("group", { name: "checkout-api" });
    expect(within(w1).getByText("checkout-api", { selector: ".ws-folder" })).toBeTruthy();
    expect(within(w1).getByText("Idempotent payments")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "web" })).getAllByRole("listitem")).toHaveLength(3);
    expect(within(screen.getByRole("group", { name: "empty" })).getByText("no folder")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New agent in empty" })).toBeTruthy();
  });

  it("opens the new agent dialog from the header button", () => {
    render(<AgentList />);
    fireEvent.click(screen.getByRole("button", { name: "New agent in web" }));
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeTruthy();
    expect(screen.getByText("New agent in web", { selector: "h3" })).toBeTruthy();
  });

  it("changes the folder from the header menu", () => {
    render(<AgentList />);
    fireEvent.contextMenu(screen.getByText("web", { selector: ".ws-label" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["New agent…", "Change folder…", "Rename workspace…", "Close workspace"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Change folder…" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/srv/web" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(within(screen.getByRole("group", { name: "web" })).getByText("web", { selector: ".ws-folder" })).toBeTruthy();
  });

  it("offers pane and tab actions in the card menu", () => {
    render(<AgentList />);
    fireEvent.contextMenu(screen.getByText("Tag v1.4.0"));
    const names = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(names).toEqual(["Rename…", "Split right", "Split down", "Close pane", "New tab", "Rename tab…", "Close tab"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Split right" }));
    expect(herdrCall).toHaveBeenCalledWith("local", "default", "pane.split", { target_pane_id: "p3", direction: "right" });
  });
```

Keep the existing "lists every pane", "monogram", "selects a pane" and "Select a session" tests unchanged (four listitems total still holds).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/agents/AgentList.test.tsx`
Expected: FAIL (`workspaceGroups` not exported; no groups).

- [ ] **Step 3: Implement the grouping, headers, menus and CSS** per the layout above.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/AgentList.tsx src/agents/AgentList.test.tsx src/styles.css
git commit -m "feat(agents): group the agents column by workspace with a New agent button"
```
