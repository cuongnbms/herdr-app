# Workspace folder and "New agent" — design

> Date: 2026-10-02 · Status: approved design, pending spec review

Each **Workspace** gets a **Workspace folder**, and the user can start an **Agent** for a Workspace from the UI; the Agent runs in a new **Tab** whose cwd is that folder. Vocabulary is defined in [CONTEXT.md](../../../CONTEXT.md).

## Goals

- Remember one folder per Workspace.
- Group the Agents column by Workspace; each group header shows the folder and a `+` button that starts an Agent in a new Tab in that folder.
- The first time a Workspace without a remembered folder gets an Agent, ask for the folder, prefilled with the cwd of its first Pane.

## Non-goals

- herdr worktree workspaces (`worktree.create`, `WorkspaceInfo.worktree`).
- Sharing folders between app installs or with the herdr TUI; the folder lives only in this app.
- Native folder picker. The path may be on a remote Machine, so it is a text field everywhere.
- Moving existing Panes when the folder changes; a change only affects Agents started afterwards.

## herdr facts this relies on (protocol 22)

- herdr has no per-Workspace folder. `workspace.create { cwd }` only starts the first Pane there.
- `tab.create { workspace_id, cwd, label, focus }` returns `{ type: "tab_created", tab, root_pane }`; `root_pane.pane_id` is the new Pane.
- `agent.start { name, kind, pane_id }` needs a Pane at its shell prompt and waits up to 30 s for the Agent to be ready. It takes no cwd.

## Storage

Frontend `localStorage`, following the per-Pane Transcript choice in `src/chat/TranscriptPicker.tsx`. No Rust or IPC changes.

- Key: `herdr-app:ws-folder:<machine_id>/<session>/<workspace_id>`, value: the path string.
- Every access is wrapped in `try/catch`; a failing store reads as "no folder".

New module `src/workspaces/folder.ts`:

```ts
interface WorkspaceRef { machine_id: string; session: string; workspace_id: string }
getFolder(ref: WorkspaceRef): string | null
setFolder(ref: WorkspaceRef, path: string): void          // trims; empty string removes
suggestFolder(ws: WorkspaceView): string                  // cwd of the first Pane (Tab order) that has one, else ""
pruneFolders(machineId: string, session: SessionView): void
```

**Pruning.** herdr Workspace ids (`w1`, `w2`, …) can be reused after a Workspace closes, which would hand a stale folder to a new Workspace. When a *running* Session's view arrives, every stored key for that `machine_id/session` whose `workspace_id` is not in `session.workspaces` is removed. Stopped Sessions, Sessions with an error, and running Sessions with an empty `workspaces` list (a running Session always has at least one Workspace, so empty means "no snapshot yet") are skipped, so a missing snapshot never wipes folders. The call sits in the store action that applies a machine view (`src/store/app.ts`, the `machines: { ...s.machines, [v.id]: v }` update), once per Session of that Machine.

## UI

### Agents column grouped by Workspace

`AgentList` renders one group per Workspace, in Workspace order:

```
herdr-dev                       3
▾ herdr-app   herdr-app     [+]
    ● Rewrite          WORKING
    ● Fix tests        INPUT
▾ api         (no folder)   [+]
    ● Refactor         READY
```

- Header: Workspace label, the folder's basename (full path as tooltip; `no folder` when none is stored), and a `+` button labelled `New agent in <label>`.
- Header context menu: `New agent…`, `Change folder…`, `Rename workspace…`, `Close workspace`. The Workspace entries move from the Pane card menu to the header; the card keeps the Pane and Tab entries.
- A Workspace with no Panes still shows its header.
- Card sub-text becomes the Tab label when the Workspace has more than one Tab, and is omitted otherwise (the Workspace is now in the header).
- Groups are not collapsible in this change.

### New agent dialog

`src/agents/NewAgentDialog.tsx`, opened from `+` or `New agent…`:

- **Agent**: `claude` (default) or `pi`.
- **Folder**: shown only when no folder is stored; prefilled with `suggestFolder(ws)`; required.
- Submit `Start`, cancel `Cancel`/Escape, same `overlay`/`dialog` markup as `NewWorkspaceDialog`.

`Change folder…` opens a one-field dialog (the existing `actions.rename` prompt is reused if it fits, with the stored folder or the suggestion as the initial value).

## Flow

On `Start`:

1. If the folder field was shown, `setFolder(ref, folder)`.
2. `tab.create { workspace_id, cwd: folder, label: agent, focus: false }`.
3. `agent.start { name: agent, kind: agent, pane_id: root_pane.pane_id }`.
4. `select({ machine_id, session, pane_id: root_pane.pane_id })` so the new Pane opens in its lens.

The dialog closes on submit, as `NewWorkspaceDialog` does. `select` happens right after step 2, so the user sees the shell while the Agent starts.

`NewWorkspaceDialog` also calls `setFolder` with the trimmed Directory after `workspace.create` succeeds, when Directory is not empty.

## Errors

- `tab.create` fails (for example the folder does not exist on the Machine): toast with herdr's message; nothing else happens. The stored folder is kept; the user fixes it with `Change folder…`.
- `agent.start` fails or times out: toast; the new Tab stays open as a shell so the user can see why.
- Session stops between opening the dialog and submit: the `herdrCall` error goes to the toast like any other.

## Testing (Vitest + Testing Library, as existing tests)

- `folder.test.ts`: set/get round trip; empty string removes; `suggestFolder` picks the first Pane cwd in Tab order, skipping Panes without one, and returns `""` when there is none; `pruneFolders` removes absent ids, keeps present ones, ignores other Sessions, and does nothing for a stopped Session.
- `AgentList.test.tsx`: groups cards under Workspace headers in order; empty Workspace shows a header; header shows folder basename or `no folder`.
- `NewAgentDialog.test.tsx` with `herdrCall` mocked: no stored folder → field shown, prefilled, saved on submit; stored folder → field hidden; calls `tab.create` with that cwd, then `agent.start` with the returned `root_pane.pane_id`; selects the new Pane; `agent.start` rejection shows the error.
- `NewWorkspaceDialog`: stores the Directory as the folder of the created Workspace.

## Files

- New: `src/workspaces/folder.ts`, `src/workspaces/folder.test.ts`, `src/agents/NewAgentDialog.tsx`, `src/agents/NewAgentDialog.test.tsx`.
- Changed: `src/agents/AgentList.tsx` (+ test), `src/sidebar/NewWorkspaceDialog.tsx`, `src/sidebar/actions.tsx` (dialog wiring), `src/store/app.ts` (pruning hook), `src/styles.css` (group header), `CONTEXT.md`.
