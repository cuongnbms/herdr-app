# Files overlay

Date: 2026-10-07
Status: draft

## Purpose

Let the user browse and read the files of a Workspace without leaving the app: open the
Workspace folder, see which files the Agents changed, jump to any file by name, and read it
with highlighting, rendered markdown or as an image. Reading is the whole job; the overlay
never writes.

Reference: remora (`/Users/cuongnb/Workspace/utils/remora`), a read-only project viewer for
local and ssh hosts. This design borrows its tree, Go to file, preview tabs, limits and
reload behaviour, and departs from it where herdr-app already has a piece (highlight.js,
the markdown pipeline, `Transport`, `git.rs`).

## Scope

In:

- A full-screen **Files overlay**, opened and closed like the Agent Dashboard.
- Root: the Workspace folder of one Workspace, else the selected Pane's cwd.
- Local and remote Machines, through the existing `Transport`.
- File tree, a **Changed** group from git status, Go to file (⌘P), preview tabs, find in
  file (⌘F).
- Views: highlighted text, rendered markdown (with a Source toggle), images.
- Reload by polling while the overlay is open.

Out (phase 2 or later):

- Git diff view, blame.
- A file watcher (inotify/FSEvents).
- Any write: edit, rename, delete, upload, download.
- Opening a file in an external editor.
- Persisting overlay state across app restarts.

## UX

### Opening and closing

- **⌘O** toggles the overlay (⌘K, ⌘E, ⌘T are taken). The key handler sits next to ⌘E in
  `src/App.tsx` and is ignored while the Agent Dashboard is open.
- The Workspace menu in the Agent list gets **Browse files**, which opens the overlay for
  that Workspace.
- **Esc** closes it when no input inside it has focus (an open find bar or Go to file list
  takes Esc first). The ✕ button closes it too.
- ⌘O with no Pane selected and no Workspace given shows a toast: "Select a workspace first".
- Closing keeps the state of each Workspace (open tabs, active tab, expanded folders,
  scroll positions) in memory for the life of the app.

### Root

Resolved when the overlay opens, for the Workspace of the selected Pane (or the one picked
from the menu):

1. The Workspace folder (`getFolder`), if set.
2. Otherwise the selected Pane's cwd (for the menu entry: `suggestFolder`). The header then
   shows **Set as workspace folder**, which calls `setFolder`.
3. Neither: an empty state with **Change folder…** (the existing Workspace menu dialog).

### Layout

```
┌─ Files · herdr-app  ~/Workspace/utils/herdr-app  (devtuf)        ⟳   ✕ ─┐
│ 🔍 Go to file…  ⌘P   │ [ipc.ts] [README.md ×] [App.tsx]                   │
│──────────────────────│ src › lib › ipc.ts   ⧉ copy path  [Source|Render]  │
│ ● CHANGED (3)        │────────────────────────────────────────────────────│
│   M src/lib/ipc.ts   │   1  import { invoke } from "@tauri-apps/api/core" │
│   A docs/plan.md     │   2  …                                             │
│   ? tmp/x.json       │                                                    │
│ ▾ src/               │                                                    │
│   ▸ agents/          │                                                    │
│ ▸ docs/              │                                                    │
└──────────────────────┴────────────────────────────────────────────────────┘
```

- **Header**: Workspace label, root path, Machine name when remote, reload (⟳), close (✕).
- **Left column** (280px default, draggable): Go to file input, Changed group, tree.
  - Changed lists git status entries with their status letter; hidden when the root is not
    in a git repo or nothing changed. Click opens the file.
  - The tree loads a folder's children when it is first expanded. Folders first, then
    files, each sorted by name. Names in the fixed exclude list (shared with
    `complete/files.rs`: `.git`, `node_modules`, `target`, `dist`, …) are not shown.
  - Keyboard: ↑↓ move, → expand / enter, ← collapse / go to parent, Enter open.
- **Right column**: tabs, breadcrumb with copy-path, Source/Render toggle for markdown,
  then the file view.
  - Preview tabs as in VS Code: a single click opens the file in the preview tab
    (italic title), replacing the previous preview; a double click on the tree entry or the
    tab pins it.
  - Empty: "Open a file from the tree, or press ⌘P".

### Keys inside the overlay

| Key | Action |
|---|---|
| ⌘P | Go to file |
| ⌘W | Close tab |
| ⌘⇧[ / ⌘⇧] | Previous / next tab |
| ⌘F | Find in file; Enter / ⇧Enter next / previous; Esc closes |
| ⌘R | Reload the open file and the Changed group |
| Esc | Close the overlay (when nothing inside takes it) |

### Go to file

A fuzzy list over `files_list_all` (top 50). Recently opened files of this Workspace rank
first when the query is empty. Enter opens the first match, pinned. The list is fetched
once per overlay open and on ⌘R. A home or `/` root is refused (same rule as
`complete/files.rs`): the input shows "Too many files at this root". When the list hits
its cap, the input shows "First 50,000 files".

## File views

`files_read` decides the kind; the frontend picks the view.

- **Text**: highlight.js (already used through `rehype-highlight`), colours from the
  existing `--hl-*` tokens, line numbers, JetBrains Mono on `--surface-code`. Language
  from the extension; unknown extensions are plain. Lines are virtualised with
  `@tanstack/react-virtual`. Above 300,000 characters, no highlighting.
- **Markdown** (`.md`, `.markdown`): Render by default with the Chat lens pipeline
  (react-markdown, remark-gfm, rehype-highlight, mermaid); Source shows it as text.
  Relative links open the target file in the overlay (anchors scroll); `http(s)` links
  open through the opener plugin.
- **Image** (png, jpg, jpeg, gif, webp, svg, avif, bmp; at most 5 MB): bytes come back as
  a `tauri::ipc::Response`, as `chat_image` does, and are shown through a `blob:` URL (the
  CSP in ADR 0004 already allows `blob:`). Fit to the view; click toggles actual size.
  SVG is shown through `<img>`, so its scripts never run.
- **Binary** (a NUL byte in the first 8 KB): "Binary file, not shown" and the size.
- **Truncated** text (over 2 MB): the first 2 MB with a banner "Showing the first 2 MB".

### Find in file

A small bar over the view. Matching runs on the text, not the DOM (the lines are
virtualised): case-insensitive substring, matches highlighted in visible lines, the
current match scrolled into view, "3 / 17" count. Not available for images; in rendered
markdown it switches to Source first.

### Reload

While the overlay is open, every 2 s:

- `files_stat` on the active tab's file; if `mtime` or `size` changed, `files_read` it
  again and keep the scroll position.
- The Changed group is refreshed.

Responses older than the latest request for the same file are dropped. Polling stops when
the overlay closes, and pauses while the Machine is disconnected.

## Backend

New module `src-tauri/src/files/`, commands registered in `lib.rs`. Each takes
`machine_id`, `root` and, where relevant, a root-relative `rel`, and runs a `sh -c` script
through the Machine's `Transport`, so local and ssh share one path.

`rel` is validated in Rust before anything runs: not absolute, no `..` segment, no NUL.
`root` must be absolute (after `~` expansion as in `complete/dirs.rs`). Arguments reach the
script as quoted positional parameters, never spliced into the script text.

| Command | Returns |
|---|---|
| `files_list_dir(machine_id, root, rel)` | `Vec<Entry { name, kind: file \| dir \| symlink }>` for one folder, exclude list applied (no size: portable `stat` per entry costs a fork each). |
| `files_list_all(machine_id, root)` | `{ paths: Vec<String>, capped: bool, refused: bool }`. `git ls-files -z -co --exclude-standard` inside a git repo, else `find` skipping the exclude list. Capped at 50,000. Shares the exclude list and the home/`/` refusal with `complete/files.rs` (extracted, not copied). |
| `files_read(machine_id, root, rel)` | `FileContent { kind: text \| binary \| image, text?, truncated, size, mtime }`. One script: stat, NUL check over the first 8 KB, `head -c` 2 MB. Images are read by `files_image`. |
| `files_image(machine_id, root, rel)` | Raw bytes as `tauri::ipc::Response`; refused above 5 MB. |
| `files_stat(machine_id, root, rels)` | `Vec<Option<{ size, mtime }>>`, `None` for a missing file. |
| `files_changed(machine_id, root)` | `Changed { repo, total, changes: Vec<GitChange> }`, at most 200 changes. Uses `git.rs`'s parser with a limit parameter (the Chat lens keeps 15); paths are rewritten relative to the root (git reports them relative to the repository) and changes outside the root are dropped. |

## Frontend

New folder `src/files/`:

- `FilesOverlay.tsx`: shell, header, columns, keys, polling.
- `FileTree.tsx`, `ChangedList.tsx`, `GoToFile.tsx`.
- `FileTabs.tsx`, `FileView.tsx` (dispatch), `TextView.tsx`, `MarkdownView.tsx`
  (wraps the Chat markdown renderer), `ImageView.tsx`, `FindBar.tsx`.
- `store.ts`: zustand store keyed by Workspace (`machine/session/workspace_id`): tabs,
  preview tab, active tab, expanded folders, scroll positions, recent files. Plus
  `filesOverlay: { open, key } | null` in `src/store/app.ts`, next to `dashboardOpen`.
- `fuzzy.ts`: a small scorer (consecutive and word-boundary bonuses, file-name matches
  first).
- IPC wrappers in `src/lib/ipc.ts`, types in `src/lib/types.ts`, styles in
  `src/styles.css` with the existing tokens.

## Errors

| Case | Behaviour |
|---|---|
| Machine disconnected | Banner "Machine offline"; the last loaded content stays; polling pauses. |
| Root missing | Empty state with **Change folder…**. |
| Read or permission error | Message inside the file view, not a toast. |
| File removed while open | Last content stays, banner "File removed". |
| Folder fails to list | Inline error row under that folder with retry. |

## Testing

- Rust: `rel`/`root` validation (absolute, `..`, NUL, `~`); parsing of each script's
  output; binary and truncated detection; `files_list_all` git and find paths and the cap;
  run against a temp folder through the local `Transport`.
- Vitest: tab logic (preview, pin, close, next/prev), fuzzy ranking, stale-response
  dropping and reload decision, markdown relative-link resolution, root resolution.
- UI: a headless WKWebView probe rather than launching the app, where a layout question
  needs a real render.

## Glossary

`CONTEXT.md` gains **Files overlay**: a full-screen view over the app for reading the files
of one Workspace, rooted at its Workspace folder. _Avoid_: file lens, file browser.
