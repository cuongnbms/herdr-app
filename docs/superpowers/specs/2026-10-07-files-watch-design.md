# Files watch: live updates for the Files overlay

Date: 2026-10-07
Status: approved design, pending implementation plan

## Goal

The Files overlay follows changes on the Machine as they happen, the way remora does:
the open file reloads when it is written or removed, and the file tree picks up files and
folders that are created, removed or renamed. Today the overlay polls every 2 s (`usePolling`:
a `stat` of the open file plus `git status` for the CHANGED list) and the tree only updates on
a manual reload.

## Scope

In:
- A backend **Files watch** per open Files overlay, streaming changes over a `tauri::ipc::Channel`.
- Three watch modes, chosen per Machine: `inotifywait` (remote with inotify-tools), a portable
  `find`-poll loop (remote without it, e.g. macOS), FSEvents via the `notify` crate (local Machine).
- The open file and the loaded folders of the tree react to changes.
- Removal of the CHANGED list and of polling.

Out:
- Go to file (`files_list_all`) stays as is: it refreshes on a manual reload only.
- Changes inside heavy folders (`SKIP_DIRS`: `.git`, `node_modules`, …) are never watched, even
  with "show heavy folders" on; they show after a manual reload.

## Backend

### `src-tauri/src/files/watch.rs`: pure pieces, ported from remora `watcher.rs`

- `Change { path, is_dir, removed }` (camelCase over IPC), `path` relative to the root, `""` for the root.
- `inotify_cmd(abs, excludes)`: the stdin watchdog (`exec 3<&0; (cat; kill $$) <&3 … &`),
  `inotifywait -m -r -q -e close_write,create,delete,moved_to,moved_from --format '%e|%w%f'`,
  `--exclude` regex for events inside excluded folders, and the excluded folders present now
  fed through `--fromfile` with `@` so they get no watches. The remora staging prefix is dropped
  (herdr-app never writes into the tree).
- `parse_inotify_line`, `adds_excluded_dir`, `exit_message`, `dedupe`, `Backoff` (1/2/5/10 s): as in remora.
- `poll_cmd(abs, excludes)`: a long-running POSIX `sh` loop, behind the same stdin watchdog:
  ```sh
  d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; touch "$d/prev"
  while :; do
    sleep 2; touch "$d/next"
    find "$root" \( -name … -o -name … \) -prune -o -newer "$d/prev" \
      \( -type d -exec printf 'd\t%s\0' {} + -o -exec printf 'f\t%s\0' {} + \)
    printf 'e\t\0'         # end of one scan: flush
    mv "$d/next" "$d/prev"
  done
  ```
  The marker file replaces remora's `-newermt '@since'` + `-printf` (neither is in BSD find) and
  its `since`/`seen` bookkeeping. Deletions are not listed, but the parent folder's mtime moves,
  so the parent arrives as a folder change.
- `parse_poll_scan(root, bytes) -> Vec<Change>`: one scan's NUL-separated `kind\tpath` records
  up to the `e\t` end record, made relative to the root. Records are NUL-separated so names
  with newlines survive.
- Excludes are `SKIP_DIRS`.

### `src-tauri/src/files/watch_manager.rs`

- `FilesWatch` (app state) holds one slot `(key, JoinHandle)`; key = machine id + root.
  `start` with the same key keeps the running watch (the new Channel replaces the sink);
  another key aborts the old one first. `stop` aborts.
- Aborting drops the ssh child (`kill_on_drop`), its stdin closes, the remote watchdog kills
  `inotifywait` / the poll loop.
- The run loop, until aborted:
  1. Local Machine: `notify::recommended_watcher` recursive on the root, events mapped like
     remora's `local_change` (excluded segments dropped, `symlink_metadata` for `is_dir`/`removed`).
  2. Remote: `command -v inotifywait` (via `exec`); spawn `inotify_cmd` or `poll_cmd` with
     `Transport::wrap`, stdin piped and held, stdout read as a stream (no 30 s exec timeout).
  3. On a successful start send `Resync`, then batches of `Changes` (300 ms debounce for
     inotify/FSEvents, one batch per poll scan). Backoff resets on the first event.
  4. When an excluded folder appears (`adds_excluded_dir`), flush and restart so it gets no watches.
  5. When the stream ends: the reason from stderr (`exit_message`) goes out as `Error { message }`,
     sleep the backoff, retry. After 3 consecutive inotify failures with no event in between,
     switch to the poll loop for this watch.
- Events (`#[serde(tag = "kind")]`): `Resync`, `Changes { changes }`, `Error { message }`.

### Commands

- `files_watch(machine_id, root, events: Channel<WatchEvent>)`: resolves the root with
  `files_root` like the other `files_*` commands, then `FilesWatch::start`.
- `files_unwatch()`: `FilesWatch::stop`.

### Removed

`files_changed`, `files_stat`, `files/changed.rs`, `read::stat_files` and its tests, `MAX_CHANGED`.

## Frontend

### `src/files/useWatch.ts` (replaces `usePolling.ts`)

`useWatch({ enabled, machineId, root, onChanges, onResync, onError })`: while enabled, makes a
`Channel`, calls `filesWatch`, and on cleanup (offline, new root, overlay closed) calls
`filesUnwatch`. Events from a Channel of an earlier subscription are ignored. Callbacks are
read through a ref so they are not dependencies.

### `FilesBrowser` (`FilesOverlay.tsx`)

- `enabled` = `online`. Reconnecting re-subscribes; the backend's `Resync` then calls `reload()`
  (tree folders, Go-to-file list, open file), covering anything missed while disconnected.
- `onChanges(batch)`:
  - root removed (`path === ""`, `removed`) → `onMissing()`;
  - a change at `active` → `removed` ? `setRemoved(active)` : `load(active)`;
  - a folder change at `dirname(active)` → `load(active)` (poll mode reports a deletion only
    through the parent);
  - the batch is passed to `FileTree` as `{ seq, changes }`.
- `load` maps a `not_found` read error to `setRemoved(rel)` instead of an error.
- `onError(message)` shows a `files-banner`: "Auto-refresh stopped: <message>"; cleared on the
  next `Resync` or `Changes`.
- Images reload through the existing path: `load` returns a new `mtime`, `ImageView` refetches on it.

### `FileTree`

New prop `changes: { seq: number; changes: Change[] } | null`. On a new `seq`, the set of
folders to relist is, per change: `dirname(path)`, plus `path` itself when it is a folder that is
not removed. Each one already in `entries` (the root or a loaded folder) is listed again once.
Entries of folders under a removed folder are dropped, so a later re-creation lists afresh.
Folders never loaded are left alone; expanding them lists them.

### Removed

`ChangedList.tsx` and its test, `usePolling.ts` and its test, `POLL_MS` in `limits.ts`,
`filesChanged` / `filesStat` / `Changed` in `lib/ipc.ts` and `lib/types.ts`, `.files-changed*` CSS,
and the CHANGED-related cases in `FilesOverlay.test.tsx` and `ipc.test.ts`.

## Testing

- Rust unit: `inotify_cmd` shape and quoting, `parse_inotify_line`, `adds_excluded_dir`,
  `exit_message`, `dedupe`, `Backoff`, `parse_poll_scan`, `poll_cmd` shape.
- Rust integration (`LocalTransport`, this Mac, BSD tools): run `poll_cmd` for real; create,
  modify and delete files, create a `node_modules` folder; assert the scans, and that the loop
  exits once stdin closes. FSEvents watch: create and remove a file, nothing from `node_modules`.
- Manual probe over `ssh devtuf` (no app launch): `inotify_cmd` and `poll_cmd` against a temp
  folder with GNU tools; confirm events and that closing stdin leaves no `inotifywait` / loop behind.
- Vitest: `useWatch` (subscribes only when enabled, unwatches on cleanup, ignores a stale
  Channel); `FileTree` (relists only loaded folders, once per batch, a new folder and its parent);
  `FilesBrowser` (open file reload / removed / parent-folder change, `Resync` reloads, error
  banner shown and cleared, `not_found` read → removed).

## Glossary

**Files watch**: the live feed of changes under a Files overlay's root, from `inotifywait`,
a `find` poll loop, or FSEvents. One at a time, owned by the open Files overlay.
