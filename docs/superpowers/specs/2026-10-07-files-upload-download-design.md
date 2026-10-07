# Files overlay: Upload and Download

Date: 2026-10-07
Status: draft

## Purpose

Move files between the Mac and a Workspace without leaving the app: put files or folders
from the Mac into a folder of the Workspace on any Machine (local or ssh), and save a file or
folder of the Workspace into `~/Downloads`. This is the first write the Files overlay makes,
so it is held to one rule: **write only by Upload, and Upload never overwrites**
([ADR-0005](../../adr/0005-files-write-only-by-upload-never-overwrite.md)). Agents work in the
same folders; a wrong Upload must never destroy their files.

Reference: remora (`/Users/cuongnb/Workspace/utils/remora`), `src-tauri/src/transfer.rs`,
`src/lib/transfer.ts`, its ADR-0002 and the README "Upload / Download" section. This design
ports its naming, staging and tar streaming, and departs from it where noted.

## Scope

In:

- **Upload Files…** and **Upload Folder…** in a context menu on the file tree, through the
  macOS open panel (`tauri-plugin-dialog`). Each picks one or more items.
- **Download** of a file or folder in the tree into `~/Downloads`.
- A progress toast that turns into the result, with **Show in Finder** after a Download.
- Local and ssh Machines, one code path through `Transport::wrap`.

Out:

- Drag and drop from Finder (see ADR-0005: it needs `dragDropEnabled`, which the sidebar and
  tab drag and drop rule out).
- Edit, rename, delete, move, overwrite on the Machine.
- Percent progress, cancel, more than one transfer queue.
- Copy Path / Copy Relative Path in the tree menu (later).
- A size cap. The only limit is time: 600 s per transfer.

## UX

### Tree context menu

Right-click in the tree opens the shared `ContextMenu` (`src/sidebar/ContextMenu.tsx`):

| Target | Items | Upload goes into |
|--------|-------|------------------|
| Folder row | Upload Files…, Upload Folder…, Download | that folder |
| File row | Upload Files…, Upload Folder…, Download | the file's folder |
| Empty space below the rows | Upload Files…, Upload Folder… | the Workspace root |

The Changed group and Go to file get no menu. The Workspace root itself cannot be downloaded.

### Upload

1. The menu item opens the open panel: `open({ multiple: true, directory })`, with
   `directory` false for Upload Files…, true for Upload Folder…. Cancel does nothing.
2. A sticky toast: `Uploading report.md to src/…` (`3 items` when several; the root reads `/`).
3. On success it becomes `Uploaded to src/: report (1).md, notes.md` and dismisses after 5 s,
   and the tree reloads the destination folder.
4. On failure: `Upload failed: <reason>`.

A name already in the destination gets the first free Finder-style name: `report (1).md`,
`report (2).md`; folders and dotfiles have no extension (`src (1)`, `.env (1)`); only the last
dot splits (`a.tar (1).gz`). Items of one Upload never take each other's names.

### Download

1. Sticky toast `Downloading report.md…`.
2. On success `Saved report (1).md` with a **Show in Finder** button (`revealItemInDir`), then
   dismisses after 5 s. A folder is saved as a folder, not an archive.
3. On failure: `Download failed: <reason>`.

The saved name is the first free Finder-style name in `~/Downloads`; nothing there is replaced.

### Toast

`src/ui/Toast.tsx` gains, beside `showToast`:

- `showProgressToast(text): number`: a toast without the alert icon that stays until updated.
- `updateToast(id, text, { alert?, action? })`: replaces its text, adds an optional
  `{ label, run }` button, and dismisses it 5 s later.

## Architecture

### Rust: `src-tauri/src/files/transfer.rs`

Commands in `commands.rs` next to `files_*`, both through `files_root`:

```rust
files_upload(machine_id, root, dest_rel, sources: Vec<String>) -> Vec<String> // final names
files_download(machine_id, root, rel) -> String                              // saved path
```

**One path for every Machine.** `LocalTransport::wrap` returns the argv unchanged and
`SshTransport::wrap` puts it behind the ssh control connection, so the same `sh -c` script
with tar on stdin or stdout serves both. remora's separate local copy path is not ported.

**Streaming runner.** `transport::exec_input`/`exec_bytes` buffer all of stdin and stdout in
memory and stop after 30 s, so they cannot carry a transfer. `run_piped(t, argv, timeout, io)`
spawns `t.wrap(argv, false)` with piped stdin and stdout, runs `io(stdin, stdout)` on a
separate thread, and kills the child once 600 s pass (`TRANSFER_TIMEOUT`), which also unblocks
`io`. It returns the exit status, stderr and `io`'s result. Blocking; commands call it through
`spawn_blocking`.

**Upload** (ported: `candidate`, `unique_name`, `check_sources`, `write_upload_stream`):

1. `check_sources`: each source is an absolute existing path on the Mac; a symlink is copied
   as a link, not followed.
2. `check_rel(dest_rel)`, then `list::list_dir` of the destination gives the taken names; a
   missing destination or one that is not a folder fails here. Final names are picked with
   `unique_name`.
3. The tar stream (crate `tar`, `follow_symlinks(false)`) holds `i/<final name>` per item,
   then an empty `done` entry, written only if every item was appended.
4. On the Machine, `upload_cmd(dest, names)`:

   ```sh
   set -e
   t=$(mktemp -d '<dest>/.herdr-upload.XXXXXX'); trap 'rm -rf "$t"' EXIT
   tar -xf - -C "$t"
   [ -e "$t"/done ] || { echo 'upload was interrupted' >&2; exit 1; }
   # per name:
   if [ -e '<dest>/<name>' ] || [ -L '<dest>/<name>' ]; then echo '<name> already exists, try again' >&2; exit 1; fi
   mv -n -- "$t"/i/'<name>' '<dest>/<name>' || true
   if [ -e "$t"/i/'<name>' ] || [ -L "$t"/i/'<name>' ]; then echo '<name> already exists, try again' >&2; exit 1; fi
   ```

   remora uses `mv -n -T`; `-T` is GNU only, and both the local Machine and an ssh Machine
   can be a Mac, so the existence check comes first. The window between check and `mv` is
   accepted: if a folder of that name appears in it, the item lands inside that folder, and
   `-n` still replaces nothing. `|| true` because `mv -n`'s exit status for a skipped move
   differs between implementations; the check after it decides. Items moved before a failure
   stay; the error names the one that did not.
5. When the stream fails locally and the Machine reports `upload was interrupted`, the local
   error is returned, since it says why.

**Download** (ported: `download_target`, `split_parent`, `unpack_to_staging`,
`finish_download`, `rename_excl`):

1. `download_target(root, rel)`: `check_rel`, refuses the root itself.
2. On the Machine: `tar -cf - -C '<parent>' -- '<name>'`.
3. On the Mac the stream unpacks into `~/Downloads/.herdr-download.XXXXXX` (`tempfile`). The
   `tar` crate skips entries with `..` or absolute paths.
4. The item moves to the first free Finder-style name with `renamex_np(RENAME_EXCL)`
   (through `libc`), retrying the next name on `EEXIST`. The staging dir is removed on every
   exit.

`~/Downloads` is `$HOME/Downloads`, created if missing.

### Frontend

- `src/lib/ipc.ts`: `filesUpload`, `filesDownload`.
- `src/files/transfer.ts`: `startUpload(machineId, root, destRel, sources)` and
  `startDownload(machineId, root, rel)`, which drive the toasts; `startUpload` resolves to
  whether it succeeded so the tree can reload.
- `src/files/FileTree.tsx`: `onContextMenu` on rows and the tree, the menu, the open panel,
  and `load(destRel)` after a successful Upload. `FilesOverlay.tsx` and `store.ts` are not
  touched.
- Dependencies: `tauri-plugin-dialog` (Cargo + `lib.rs` registration) and
  `@tauri-apps/plugin-dialog` (`@tauri-apps/plugin-opener` is already a dependency).
  Capabilities in `src-tauri/capabilities/default.json`: `dialog:allow-open`,
  `opener:allow-reveal-item-in-dir`.

### Docs

- `docs/adr/0005-files-write-only-by-upload-never-overwrite.md`.
- The Files overlay spec: the "Any write" line in Out points here.
- `src-tauri/src/files/mod.rs:1`: the module doc no longer says "never writing".
- `CONTEXT.md`, **Files overlay**: reading plus Upload and Download, never overwriting.

## Errors

| Case | Result |
|------|--------|
| Destination missing or not a folder | `list_dir` error before anything is sent |
| `dest_rel` / `rel` escapes the root, or `rel` is the root | `invalid` before anything runs |
| Source missing on the Mac | `check_sources` error before anything runs |
| A source unreadable mid-stream | No `done`; the Machine removes the staging dir; the local read error is shown |
| A name taken between listing and `mv` | `<name> already exists, try again`; earlier items stay |
| No `tar` or `mktemp` on the Machine | The shell's error text |
| ssh drops | Exit 255 and ssh's stderr |
| 600 s pass | Child killed, `transfer timed out after 600s`; staging removed by `trap` (Machine) or drop (Mac) |
| `~/Downloads` not writable | io error naming the path |

## Testing

Rust (`cargo test`, `files::transfer`):

- `candidate` / `unique_name`: files, folders, dotfiles, double extensions, items of one
  Upload colliding with each other.
- `upload_cmd` quoting with spaces and `'` in names.
- Real Uploads through `LocalTransport` into a tempdir: one file, a folder with a symlink,
  name clashes, a name taken after listing (fails, earlier items kept, staging gone), a
  stream without `done` (interrupted, nothing placed).
- Download through `LocalTransport`: file, folder, clash in the downloads dir, root refused.
- `run_piped` kills the child after its timeout.
- Optional, by hand: the same Upload script against `devtuf` over ssh for GNU `mv`.

Vitest:

- `FileTree`: menu items per target, the destination passed for folder / file / empty space,
  Download missing on empty space, reload after a successful Upload, nothing when the panel
  is cancelled.
- `transfer.ts`: progress text, success and failure text, Show in Finder action.
- `Toast`: a progress toast stays until updated, then dismisses.
