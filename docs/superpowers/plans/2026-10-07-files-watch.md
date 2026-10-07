# Files Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Files overlay follows changes on the Machine live (open file and loaded tree folders) through a backend Files watch, replacing 2 s polling and the CHANGED list.

**Architecture:** A Rust `FilesWatch` (Tauri state) runs one watch at a time: `inotifywait` over a long-running ssh process, a POSIX `find` poll loop when inotify-tools is missing, or FSEvents (`notify` crate) for the local Machine. Changes stream to the UI over a `tauri::ipc::Channel`; `useWatch` subscribes from `FilesBrowser`, which reloads the open file and hands batches to `FileTree` to relist loaded folders.

**Tech Stack:** Rust (tokio, tauri 2, `notify` 8), React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-files-watch-design.md`

## Global Constraints

- Work in the worktree `.worktrees/files-watch` (branch `files-watch`). Before any `pnpm` command: `export PATH="$HOME/.local/share/mise/installs/pnpm/11.18.0:$HOME/.local/share/mise/installs/node/24.14.0/bin:$PATH"` (check the versions in `~/.local/share/mise/installs/`), then `pnpm install --frozen-lockfile` once.
- Rust tests: `cd src-tauri && cargo test <filter>`. Frontend: `pnpm test <file>` and `pnpm typecheck`.
- Never run bare `cargo fmt`: run `rustfmt --edition 2021 <your files>` and `git checkout --` any file you did not edit before `git add` (the crate is not fmt-clean).
- The crate has its own `mod notify` (`src-tauri/src/notify.rs`); always refer to the file-watch crate as `::notify::…`.
- Heavy folders are `crate::complete::files::SKIP_DIRS`; prune them in `find` with `crate::complete::files::find_prune()`. Shell-quote with `crate::transport::sh_quote`.
- Rust `Change` serializes camelCase: `{ path, isDir, removed }`; `path` is relative to the root, `""` is the root itself.
- Rust `WatchEvent` serializes `#[serde(tag = "type", rename_all = "snake_case")]`: `{type:"resync"}`, `{type:"changes", changes}`, `{type:"error", message}`. The TS type mirrors it exactly.
- The UI error copy is exactly `Auto-refresh stopped: <message>`.
- Commit messages: Conventional Commits with scope `files`, lowercase sentence summary, as in `git log` (e.g. `feat(files): …`).

## Review Focus

1. Roots and file names with spaces, quotes, tabs or newlines: commands stay quoted, poll records are NUL-separated and a name with a tab keeps it (Task 1 tests; Task 2 uses a root with a space).
2. Overlay closed and reopened quickly, or offline→online: a late `files_unwatch` must not stop the newer watch (Task 3 `FilesWatch` id test; Task 5 `useWatch` test).
3. Remote processes left behind after the overlay closes or the app drops the ssh child (Task 2 stdin-EOF test; Task 4 devtuf probe).
4. Root is the home folder: refused with an error instead of a recursive watch over `~` (Task 3 test; Task 7 banner test).
5. An excluded folder (`node_modules`) created after the watch started: no events from inside it (Task 1 `adds_excluded_dir`; Task 2 poll test).

---

### Task 1: Pure watch pieces (`files/watch.rs`)

**Files:**
- Create: `src-tauri/src/files/watch.rs`
- Modify: `src-tauri/src/files/mod.rs` (add `pub mod watch;`)

**Interfaces:**
- Produces (all `pub` in `crate::files::watch`):
  - `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(rename_all = "camelCase")] pub struct Change { pub path: String, pub is_dir: bool, pub removed: bool }`
  - `#[derive(Debug, Clone, PartialEq, Serialize)] #[serde(tag = "type", rename_all = "snake_case")] pub enum WatchEvent { Resync, Changes { changes: Vec<Change> }, Error { message: String } }`
  - `pub const POLL_SECS: u64 = 2;`
  - `pub fn inotify_cmd(abs: &str) -> String`
  - `pub fn poll_cmd(abs: &str) -> String`
  - `pub fn parse_inotify_line(root: &str, line: &str) -> Option<Change>`
  - `pub enum PollRecord { Change(Change), End }` and `pub fn parse_poll_record(root: &str, rec: &[u8]) -> Option<PollRecord>`
  - `pub fn adds_excluded_dir(change: &Change) -> bool`
  - `pub fn exit_message(stderr: &str) -> String`
  - `pub fn dedupe(changes: Vec<Change>) -> Vec<Change>`
  - `#[derive(Default)] pub struct Backoff` with `next_delay(&mut self) -> Duration` (1, 2, 5, 10, 10… s) and `reset(&mut self)`

Port from `/Users/cuongnb/Workspace/utils/remora/src-tauri/src/watcher.rs`, minus the `.remora-` staging prefix, `local_change`, `poll_cmd`/`Poller`; excludes are always `SKIP_DIRS` (no parameter).

- [ ] **Step 1: Write the failing tests** at the bottom of `watch.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn c(path: &str, is_dir: bool, removed: bool) -> Change {
        Change { path: path.into(), is_dir, removed }
    }

    #[test]
    fn inotify_cmd_watches_recursively_and_skips_heavy_dirs() {
        let cmd = inotify_cmd("/r/p q");
        assert!(cmd.starts_with("exec 3<&0; (cat; kill $$) <&3 >/dev/null 2>&1 & exec inotifywait -m -r -q -e close_write,create,delete,moved_to,moved_from --format '%e|%w%f'"), "{cmd}");
        // Events inside a heavy folder are dropped, the folder's own creation is not.
        assert!(cmd.contains(r"--exclude '(^|/)(\.git|node_modules|\.venv|venv|__pycache__|target|dist|build|\.next|\.worktrees)/'"), "{cmd}");
        // Heavy folders present now get no watches at all.
        assert!(cmd.contains(" --fromfile - '/r/p q' 3<&- <<HERDR_WATCH\n$(find '/r/p q' -mindepth 1 \\( -name '.git' -o -name 'node_modules' -o -name '.venv' -o -name 'venv' -o -name '__pycache__' -o -name 'target' -o -name 'dist' -o -name 'build' -o -name '.next' -o -name '.worktrees' \\) -prune -printf '@%p\\n' 2>/dev/null)\nHERDR_WATCH\n"), "{cmd}");
        assert!(inotify_cmd("/it's").contains(r"'/it'\''s'"));
    }

    #[test]
    fn poll_cmd_loops_on_a_marker_file_with_heavy_dirs_pruned() {
        let cmd = poll_cmd("/r/p q");
        assert!(cmd.starts_with("exec 3<&0; (cat; kill $$) <&3 >/dev/null 2>&1 &\n"), "{cmd}");
        assert!(cmd.contains("trap 'rm -rf \"$d\"' EXIT"), "{cmd}");
        assert!(cmd.contains("sleep 2;"), "{cmd}");
        assert!(cmd.contains(&format!("find '/r/p q' {} -o -newer \"$d/prev\"", crate::complete::files::find_prune())), "{cmd}");
        assert!(cmd.contains(r"-type d -exec printf 'd\t%s\0' {} + -o -exec printf 'f\t%s\0' {} +"), "{cmd}");
        assert!(cmd.contains(r"printf 'e\t\0'"), "{cmd}");
        assert!(cmd.contains("mv \"$d/next\" \"$d/prev\""), "{cmd}");
    }

    #[test]
    fn parses_poll_records() {
        let p = |rec: &[u8]| parse_poll_record("/r/", rec);
        assert!(matches!(p(b"f\t/r/docs/a\tb.md"), Some(PollRecord::Change(ch)) if ch == c("docs/a\tb.md", false, false)));
        assert!(matches!(p(b"d\t/r/new\ndir"), Some(PollRecord::Change(ch)) if ch == c("new\ndir", true, false)));
        assert!(matches!(p(b"d\t/r"), Some(PollRecord::Change(ch)) if ch == c("", true, false)));
        assert!(matches!(p(b"e\t"), Some(PollRecord::End)));
        assert!(p(b"f\t/other/x").is_none());
        assert!(p(b"garbage").is_none());
    }

    #[test]
    fn parses_inotify_lines() {
        assert_eq!(parse_inotify_line("/r", "CLOSE_WRITE,CLOSE|/r/docs/a b.md"), Some(c("docs/a b.md", false, false)));
        assert_eq!(parse_inotify_line("/r/", "CREATE,ISDIR|/r/new"), Some(c("new", true, false)));
        assert_eq!(parse_inotify_line("/r", "DELETE|/r/x.md"), Some(c("x.md", false, true)));
        assert_eq!(parse_inotify_line("/r", "MOVED_FROM|/r/y|z.md"), Some(c("y|z.md", false, true)));
        assert_eq!(parse_inotify_line("/r", "DELETE_SELF|/r"), Some(c("", false, true)));
        assert_eq!(parse_inotify_line("/r", "CREATE|/other/x"), None);
        assert_eq!(parse_inotify_line("/r", "garbage"), None);
    }

    #[test]
    fn adds_excluded_dir_only_for_new_heavy_folders() {
        assert!(adds_excluded_dir(&c("web/node_modules", true, false)));
        assert!(adds_excluded_dir(&c(".venv", true, false)));
        assert!(!adds_excluded_dir(&c("web/node_modules", true, true)));
        assert!(!adds_excluded_dir(&c("web/node_modules", false, false)));
        assert!(!adds_excluded_dir(&c("node_modules/x", true, false)));
        assert!(!adds_excluded_dir(&c("my_venv", true, false)));
    }

    #[test]
    fn exit_message_prefers_the_first_stderr_line() {
        let stderr = "\nFailed to watch /r; upper limit on inotify watches reached!\nPlease increase…\n";
        assert_eq!(exit_message(stderr), "Failed to watch /r; upper limit on inotify watches reached!");
        assert_eq!(exit_message(" \n"), "watch session ended");
        let noisy = "ControlSocket /u/.ssh/cm already exists, disabling multiplexing\r\nCouldn't watch /r: No such file or directory\n";
        assert_eq!(exit_message(noisy), "Couldn't watch /r: No such file or directory");
    }

    #[test]
    fn dedupe_keeps_first_position_last_value() {
        assert_eq!(dedupe(vec![c("a", false, false), c("b", false, false), c("a", false, true)]), vec![c("a", false, true), c("b", false, false)]);
    }

    #[test]
    fn backoff_sequence_and_reset() {
        let mut b = Backoff::default();
        let secs: Vec<u64> = (0..6).map(|_| b.next_delay().as_secs()).collect();
        assert_eq!(secs, [1, 2, 5, 10, 10, 10]);
        b.reset();
        assert_eq!(b.next_delay().as_secs(), 1);
    }

    #[test]
    fn events_serialize_for_the_ui() {
        let v = serde_json::to_value(WatchEvent::Changes { changes: vec![c("a", true, false)] }).unwrap();
        assert_eq!(v, serde_json::json!({"type":"changes","changes":[{"path":"a","isDir":true,"removed":false}]}));
        assert_eq!(serde_json::to_value(WatchEvent::Resync).unwrap(), serde_json::json!({"type":"resync"}));
        assert_eq!(serde_json::to_value(WatchEvent::Error { message: "x".into() }).unwrap(), serde_json::json!({"type":"error","message":"x"}));
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test files::watch`
Expected: compile errors (items not defined).

- [ ] **Step 3: Implement the items listed under Interfaces**

- `inotify_cmd`: remora's shape with heredoc tag `HERDR_WATCH`; the `--exclude` filter is `(^|/)(<SKIP_DIRS ERE-escaped, joined by |>)/`; the `--fromfile` heredoc lists `$(find <q> -mindepth 1 \( -name '<n>' -o … \) -prune -printf '@%p\n' 2>/dev/null)` (GNU find is fine: only Linux has inotify).
- `poll_cmd` is exactly this script, `<q>` = `sh_quote(abs)`, `<prune>` = `find_prune()`, `<secs>` = `POLL_SECS`:
  ```sh
  exec 3<&0; (cat; kill $$) <&3 >/dev/null 2>&1 &
  d=$(mktemp -d) || exit 1
  trap 'rm -rf "$d"' EXIT
  trap 'exit 0' TERM HUP INT
  touch "$d/prev"
  while :; do
    sleep <secs>; touch "$d/next"
    find <q> <prune> -o -newer "$d/prev" \( -type d -exec printf 'd\t%s\0' {} + -o -exec printf 'f\t%s\0' {} + \) 3<&- 2>/dev/null
    printf 'e\t\0'
    mv "$d/next" "$d/prev"
  done
  ```
- `parse_poll_record`: split on the first `\t` only; kind `d`/`f` → `Change` relative to the root (root trailing `/` ignored, the root itself → `""`, outside the root → `None`), `e` → `End`, anything else → `None`. Lossy UTF-8.
- `adds_excluded_dir`: folder, not removed, last segment in `SKIP_DIRS`.
- The rest as in remora.

- [ ] **Step 4: Run to verify they pass**

Run: `cd src-tauri && cargo test files::watch`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/files/watch.rs src-tauri/src/files/mod.rs
git commit -m "feat(files): watch commands and parsers for inotifywait and a portable find poll"
```

---

### Task 2: Watch loops (`files/watch_manager.rs`)

**Files:**
- Create: `src-tauri/src/files/watch_manager.rs`
- Modify: `src-tauri/src/files/mod.rs` (add `pub mod watch_manager;`), `src-tauri/Cargo.toml` (`notify = "8"` under `[dependencies]`)

**Interfaces:**
- Consumes: Task 1 (`Change`, `WatchEvent`, `inotify_cmd`, `poll_cmd`, `parse_inotify_line`, `parse_poll_record`, `PollRecord`, `adds_excluded_dir`, `exit_message`, `dedupe`, `Backoff`); `crate::transport::{Transport, exec}`.
- Produces:
  - `pub type WatchSink = Arc<dyn Fn(WatchEvent) + Send + Sync>;`
  - `pub async fn run_watch(t: Arc<dyn Transport>, local: bool, root: String, sink: WatchSink)` — never returns; aborting the task stops it.
  - `pub(crate) fn spawn_stream(t: &dyn Transport, script: &str) -> AppResult<tokio::process::Child>` — `t.wrap(["sh","-c",script], false)`, stdin/stdout/stderr piped, `kill_on_drop(true)`. The caller keeps `child.stdin` alive for as long as it reads.
  - `pub(crate) async fn watch_poll(t: &dyn Transport, root: &str, sink: &WatchSink, backoff: &mut Backoff) -> AppResult<()>`
  - `pub(crate) async fn watch_inotify(t: &dyn Transport, root: &str, sink: &WatchSink, backoff: &mut Backoff) -> AppResult<()>` — `Ok(())` means "restart" (a heavy folder appeared).
  - `pub(crate) async fn watch_local(root: &str, sink: &WatchSink, backoff: &mut Backoff) -> AppResult<()>`

Behavior (from the spec):
- Each `watch_*` sends `WatchEvent::Resync` once its process/watcher has started, then `Changes` batches: inotify and FSEvents debounce 300 ms (`DEBOUNCE`), the poll loop sends one batch per scan (on `PollRecord::End`, only if non-empty). `backoff.reset()` on the first event.
- inotify: when `adds_excluded_dir`, flush the batch and return `Ok(())`. When stdout ends: read stderr (2 s timeout), return `Err(AppError::new("io", exit_message(&stderr)))`.
- poll: stdout split on NUL; stdout end → same error as inotify.
- local: port remora `watch_local`/`local_change` (`symlink_metadata` for `is_dir`/`removed`, roots = configured + canonicalized, skip `Access` events and any path with a `SKIP_DIRS` segment).
- `run_watch` loop: `local` → `watch_local`; otherwise check `command -v inotifywait` once (via `exec`) and use `watch_inotify`, or `watch_poll` when absent. On `Err(e)` send `WatchEvent::Error { message: e.message }`. Count inotify errors that happened with no event since the last start; at 3 switch to `watch_poll` for the rest of this run. Sleep `backoff.next_delay()` after an error; restart at once after `Ok(())`.

- [ ] **Step 1: Write the failing tests** at the bottom of `watch_manager.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::watch::{Change, WatchEvent};
    use crate::transport::local::LocalTransport;
    use std::time::Duration;
    use tokio::sync::mpsc;

    fn collect() -> (WatchSink, mpsc::UnboundedReceiver<WatchEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(move |e| { let _ = tx.send(e); }), rx)
    }

    /// Changes until `want` matches one, failing after 15 s.
    async fn until(rx: &mut mpsc::UnboundedReceiver<WatchEvent>, want: impl Fn(&Change) -> bool) -> Vec<Change> {
        let mut seen = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(WatchEvent::Changes { changes })) => {
                    let hit = changes.iter().any(&want);
                    seen.extend(changes);
                    if hit { return seen; }
                }
                Ok(Some(_)) => {}
                _ => panic!("timed out, saw {seen:?}"),
            }
        }
    }

    #[tokio::test]
    async fn poll_reports_new_files_and_folder_changes_but_nothing_inside_heavy_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("a b");
        std::fs::create_dir(&root).unwrap();
        let root_s = root.to_string_lossy().into_owned();
        let (sink, mut rx) = collect();
        let r = root_s.clone();
        let task = tokio::spawn(async move { watch_poll(&LocalTransport, &r, &sink, &mut Backoff::default()).await });
        assert!(matches!(rx.recv().await, Some(WatchEvent::Resync)));
        // Marker mtimes have 1 s resolution on some filesystems: write after the first scan.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        std::fs::write(root.join("x y.md"), "hi").unwrap();
        until(&mut rx, |c| c.path == "x y.md" && !c.is_dir).await;
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/pkg.js"), "").unwrap();
        std::fs::remove_file(root.join("x y.md")).unwrap();
        let seen = until(&mut rx, |c| c.path.is_empty() && c.is_dir).await;
        assert!(seen.iter().all(|c| !c.path.starts_with("node_modules")), "{seen:?}");
        task.abort();
    }

    #[tokio::test]
    async fn the_poll_loop_exits_when_stdin_closes() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = spawn_stream(&LocalTransport, &crate::files::watch::poll_cmd(&dir.path().to_string_lossy())).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(child.stdin.take());
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        assert!(status.is_ok(), "poll loop still running after stdin closed");
    }

    #[tokio::test]
    async fn local_watch_reports_created_and_removed_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let (sink, mut rx) = collect();
        let task = tokio::spawn(async move { watch_local(&root, &sink, &mut Backoff::default()).await });
        assert!(matches!(rx.recv().await, Some(WatchEvent::Resync)));
        let target = dir.path().join("notes.md");
        // FSEvents needs a moment to start; keep writing until an event arrives.
        let mut seen = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !seen.iter().any(|c: &Change| c.path == "notes.md" && !c.removed) {
            std::fs::write(&target, "hello").unwrap();
            if let Ok(Some(WatchEvent::Changes { changes })) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
                seen.extend(changes);
            }
            assert!(tokio::time::Instant::now() < deadline, "no create event, saw {seen:?}");
        }
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/x.js"), "").unwrap();
        std::fs::remove_file(&target).unwrap();
        let seen = until(&mut rx, |c| c.path == "notes.md" && c.removed).await;
        assert!(seen.iter().all(|c| !c.path.starts_with("node_modules/")), "{seen:?}");
        task.abort();
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test files::watch_manager`
Expected: compile errors (items not defined).

- [ ] **Step 3: Add `notify = "8"` to `src-tauri/Cargo.toml` and implement the items listed under Interfaces**

- [ ] **Step 4: Run to verify they pass**

Run: `cd src-tauri && cargo test files::watch_manager`
Expected: 3 passed (on this Mac the poll test exercises BSD `find`/`printf`/`mktemp`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/files/watch_manager.rs src-tauri/src/files/mod.rs
git commit -m "feat(files): watch loops over inotifywait, a find poll and FSEvents"
```

---

### Task 3: `FilesWatch` state, commands, and removing CHANGED/stat on the backend

**Files:**
- Modify: `src-tauri/src/files/watch_manager.rs` (add `FilesWatch`)
- Modify: `src-tauri/src/commands.rs` (add `files_watch`, `files_unwatch`; remove `files_stat`, `files_changed` and their imports)
- Modify: `src-tauri/src/lib.rs` (register commands, `app.manage(Arc::new(FilesWatch::default()))`)
- Modify: `src-tauri/src/machines.rs:59` (`const LOCAL` → `pub const LOCAL`)
- Delete: `src-tauri/src/files/changed.rs`; remove `pub mod changed;` and `MAX_CHANGED` from `files/mod.rs`
- Modify: `src-tauri/src/files/read.rs` (remove `stat_files`, `STAT_SCRIPT` if then unused, and their tests; keep `FileStat`/`parse_stat`, which `read_file` uses)

**Interfaces:**
- Consumes: Task 2 `run_watch`, `WatchSink`; `crate::complete::files::is_home`.
- Produces:
  - `#[derive(Default)] pub struct FilesWatch` with
    - `pub fn start(&self, t: Arc<dyn Transport>, local: bool, root: String, sink: WatchSink) -> u64` — aborts the running watch, spawns `run_watch`, returns a new id (first is 1, then increasing).
    - `pub fn stop(&self, id: u64)` — aborts only when `id` is current.
    - `pub fn is_running(&self) -> bool`
  - `#[tauri::command] files_watch(mgr, watch: State<'_, Arc<FilesWatch>>, machine_id: String, root: String, events: Channel<WatchEvent>) -> Result<u64, AppError>`: `files_root`, then `is_home(&info.home, &root)` → `Err(AppError::new("invalid", "auto-refresh is off for the home folder"))`, then `start(transport, machine_id == machines::LOCAL, root, sink)` where the sink does `events.send(e)` and logs a failed send with `tracing::warn!` (as `chat_open` does).
  - `#[tauri::command] files_unwatch(watch: State<'_, Arc<FilesWatch>>, id: u64)`.

- [ ] **Step 1: Write the failing test** in `watch_manager.rs` tests

```rust
    #[tokio::test]
    async fn a_stale_stop_leaves_the_newer_watch_running() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let w = FilesWatch::default();
        let (sink, _rx) = collect();
        let first = w.start(Arc::new(LocalTransport), true, root.clone(), sink.clone());
        let second = w.start(Arc::new(LocalTransport), true, root, sink);
        assert!(second > first);
        w.stop(first);
        assert!(w.is_running());
        w.stop(second);
        assert!(!w.is_running());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test files::watch_manager::tests::a_stale_stop`
Expected: compile error (`FilesWatch` not defined).

- [ ] **Step 3: Implement `FilesWatch`, the two commands, the registration, and the removals listed under Files**

- [ ] **Step 4: Run the whole backend suite and build**

Run: `cd src-tauri && cargo test && cargo build`
Expected: all tests pass; no warnings about unused `FileStat`/`STAT_SCRIPT`/imports.

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri
git status --short   # only files listed above
git commit -m "feat(files): files_watch and files_unwatch commands; drop files_changed and files_stat"
```

---

### Task 4: Probe inotify and the GNU poll loop on devtuf (no code kept)

**Files:**
- Create (throwaway, not committed): `$SCRATCH/watch-probe/` — print the two scripts from a tiny test, e.g. `cargo test files::watch -- --nocapture` with a temporary `println!`, or copy them from the Task 1 test output.

**Interfaces:**
- Consumes: Task 1 `inotify_cmd`, `poll_cmd`.

- [ ] **Step 1: inotify path.** `ssh devtuf 'command -v inotifywait'` (if missing, note it and skip to Step 2). Make `/tmp/hw-probe/{a,node_modules}`, run `ssh devtuf sh -c '<inotify_cmd("/tmp/hw-probe")>'` with stdin from a FIFO you hold open; in a second ssh, `touch /tmp/hw-probe/a/x`, `touch /tmp/hw-probe/node_modules/y`, `mkdir /tmp/hw-probe/a/node_modules && touch /tmp/hw-probe/a/node_modules/z`.
  Expected: lines for `a/x` and the `CREATE,ISDIR|…/a/node_modules` folder only.
- [ ] **Step 2: poll path on GNU tools.** Same with `poll_cmd("/tmp/hw-probe")`, piping stdout through `tr '\0' '\n'`.
  Expected: `f\t/tmp/hw-probe/a/x`-style records within ~2 s, `e\t` after each scan, nothing under `node_modules/`.
- [ ] **Step 3: cleanup.** Close the FIFO writer for each run, then `ssh devtuf 'pgrep -af "inotifywait|hw-probe"'`.
  Expected: no output (no watcher or poll loop left), and `ls /tmp` holds no leftover `tmp.*` marker dir from the poll loop.
- [ ] **Step 4: Record the outcome** in the task report (and fix Task 1/2 code plus its test if a probe fails, then commit that fix with `fix(files): …`). Remove `/tmp/hw-probe` on devtuf.

---

### Task 5: IPC, types and `useWatch`

**Files:**
- Modify: `src/lib/types.ts` (add `FileChange`, `WatchEvent`)
- Modify: `src/lib/ipc.ts` (add `filesWatch`, `filesUnwatch`)
- Create: `src/files/useWatch.ts`
- Test: `src/files/useWatch.test.ts`

**Interfaces:**
- Consumes: Task 3 commands `files_watch { machineId, root, events } -> number`, `files_unwatch { id }`.
- Produces:
  - `export interface FileChange { path: string; isDir: boolean; removed: boolean }`
  - `export type WatchEvent = { type: "resync" } | { type: "changes"; changes: FileChange[] } | { type: "error"; message: string }`
  - `export const filesWatch = (machineId: string, root: string, events: Channel<WatchEvent>) => invoke<number>("files_watch", { machineId, root, events })`
  - `export const filesUnwatch = (id: number) => invoke<void>("files_unwatch", { id })`
  - `export function useWatch(opts: { enabled: boolean; machineId: string; root: string; onChanges(changes: FileChange[]): void; onResync(): void; onError(message: string): void }): void` — effect keyed on `[enabled, machineId, root]`; callbacks read through a ref; a Channel from an earlier run is ignored after cleanup; cleanup unwatches with the id `filesWatch` resolved to (after it resolves, if it has not yet); a rejected `filesWatch` calls `onError(e.message ?? String(e))`.

- [ ] **Step 1: Write the failing test** `src/files/useWatch.test.ts`

```ts
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const channels = vi.hoisted(() => [] as { onmessage?: (e: unknown) => void }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage?: (e: unknown) => void;
    constructor() {
      channels.push(this);
    }
  },
}));
import { invoke } from "@tauri-apps/api/core";
import { useWatch } from "./useWatch";

const opts = (enabled: boolean) => ({
  enabled,
  machineId: "m",
  root: "/r",
  onChanges: vi.fn(),
  onResync: vi.fn(),
  onError: vi.fn(),
});

describe("useWatch", () => {
  beforeEach(() => {
    channels.length = 0;
    vi.mocked(invoke).mockReset();
    let id = 0;
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === "files_watch" ? ++id : undefined));
  });

  it("does nothing while disabled", () => {
    renderHook(() => useWatch(opts(false)));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("subscribes, routes events, and unwatches its own id on cleanup", async () => {
    const o = opts(true);
    const { unmount } = renderHook(() => useWatch(o));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_watch", { machineId: "m", root: "/r", events: channels[0] }));
    channels[0].onmessage!({ type: "resync" });
    channels[0].onmessage!({ type: "changes", changes: [{ path: "a", isDir: false, removed: false }] });
    channels[0].onmessage!({ type: "error", message: "boom" });
    expect(o.onResync).toHaveBeenCalledTimes(1);
    expect(o.onChanges).toHaveBeenCalledWith([{ path: "a", isDir: false, removed: false }]);
    expect(o.onError).toHaveBeenCalledWith("boom");
    unmount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_unwatch", { id: 1 }));
  });

  it("re-subscribes for a new root and ignores the old channel", async () => {
    const o = opts(true);
    const { rerender } = renderHook((p: { root: string }) => useWatch({ ...o, root: p.root }), { initialProps: { root: "/r" } });
    await waitFor(() => expect(channels).toHaveLength(1));
    rerender({ root: "/s" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_watch", { machineId: "m", root: "/s", events: channels[1] }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("files_unwatch", { id: 1 }));
    channels[0].onmessage!({ type: "resync" });
    expect(o.onResync).not.toHaveBeenCalled();
  });

  it("reports a refused watch as an error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: "invalid", message: "auto-refresh is off for the home folder" });
    const o = opts(true);
    renderHook(() => useWatch(o));
    await waitFor(() => expect(o.onError).toHaveBeenCalledWith("auto-refresh is off for the home folder"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/files/useWatch.test.ts`
Expected: FAIL (cannot resolve `./useWatch`).

- [ ] **Step 3: Implement the types, the two ipc functions, and `useWatch`**

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/files/useWatch.test.ts && pnpm typecheck`
Expected: 4 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/ipc.ts src/files/useWatch.ts src/files/useWatch.test.ts
git commit -m "feat(files): useWatch subscribes to the Files watch over a Channel"
```

---

### Task 6: `FileTree` relists folders that changed

**Files:**
- Create: `src/files/watchDirs.ts`, `src/files/watchDirs.test.ts`
- Modify: `src/files/FileTree.tsx` (new `changes` prop)
- Test: `src/files/FileTree.test.tsx`

**Interfaces:**
- Consumes: Task 5 `FileChange`.
- Produces:
  - `export function parentDir(rel: string): string` — `"a/b/c"` → `"a/b"`, `"a"` → `""`, `""` → `""`.
  - `export function dirsToRelist(changes: FileChange[]): string[]` — per change `parentDir(path)`, plus `path` itself when `isDir && !removed`; deduped, first-seen order. A root change (`path === ""`) contributes `""` once.
  - `FileTree` prop `changes?: { seq: number; changes: FileChange[] } | null`: on a new `seq`, `load(dir)` for every `dirsToRelist` dir already present in `entries`; for each removed folder change, drop `entries`/`errors` keys equal to it or under it (`key === path || key.startsWith(path + "/")`).

- [ ] **Step 1: Write the failing tests**

`src/files/watchDirs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dirsToRelist, parentDir } from "./watchDirs";

const ch = (path: string, isDir = false, removed = false) => ({ path, isDir, removed });

describe("watchDirs", () => {
  it("parentDir", () => {
    expect(parentDir("a/b/c")).toBe("a/b");
    expect(parentDir("a")).toBe("");
    expect(parentDir("")).toBe("");
  });

  it("relists parents, and a new or touched folder itself, once each", () => {
    expect(dirsToRelist([ch("src/a.ts"), ch("src/b.ts"), ch("docs", true), ch("old", true, true), ch("", true)])).toEqual(["src", "", "docs"]);
  });
});
```

Add to `src/files/FileTree.test.tsx` (inside `describe("FileTree")`):

```tsx
  it("relists only loaded folders named by a change batch, once per batch", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "lib", kind: "dir" }] : [{ name: "x.ts", kind: "file" }],
    );
    const props = { machineId: "local", root: "/r", filesKey: "local/default/w9", onOpen: () => {}, reloadKey: 0 };
    const { rerender } = render(<FileTree {...props} changes={null} />);
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("x.ts");
    vi.mocked(invoke).mockClear();
    const batch = { seq: 1, changes: [{ path: "src/new.ts", isDir: false, removed: false }, { path: "lib/y.ts", isDir: false, removed: false }] };
    rerender(<FileTree {...props} changes={batch} />);
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("files_list_dir", { machineId: "local", root: "/r", rel: "src", showHeavy: false });
    rerender(<FileTree {...props} changes={batch} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test src/files/watchDirs.test.ts src/files/FileTree.test.tsx`
Expected: FAIL (module missing; FileTree does not relist).

- [ ] **Step 3: Implement `watchDirs.ts` and the `changes` prop in `FileTree`**

Track the last handled `seq` in a ref so a re-render with the same batch does nothing.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test src/files/watchDirs.test.ts src/files/FileTree.test.tsx && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/files/watchDirs.ts src/files/watchDirs.test.ts src/files/FileTree.tsx src/files/FileTree.test.tsx
git commit -m "feat(files): the tree relists loaded folders when the Files watch reports changes"
```

---

### Task 7: Wire `FilesBrowser` to the watch; remove polling and CHANGED

**Files:**
- Modify: `src/files/FilesOverlay.tsx`
- Modify: `src/files/FilesOverlay.test.tsx`
- Modify: `src/files/limits.ts` (remove `POLL_MS`)
- Modify: `src/lib/ipc.ts`, `src/lib/types.ts` (remove `filesStat`, `filesChanged`, `FileStat`, `Changed`; keep `GitChange`, used by `GitStatus`), `src/lib/ipc.test.ts` (drop their cases)
- Modify: `src/styles.css` (remove `.files-changed*` rules)
- Delete: `src/files/ChangedList.tsx`, `src/files/ChangedList.test.tsx`, `src/files/usePolling.ts`, `src/files/usePolling.test.ts`

**Interfaces:**
- Consumes: Task 5 `useWatch`, `FileChange`; Task 6 `parentDir`, `FileTree` `changes` prop.
- Produces (behavior in `FilesBrowser`):
  - `useWatch({ enabled: online, machineId, root, … })`.
  - `onResync` → clear the watch error, `reload()`.
  - `onChanges(changes)` → clear the watch error; root removed (`path === ""` and `removed`) → `onMissing()`; a change with `path === active` → `removed ? setRemoved(active) : load(active)`; else a folder change with `path === parentDir(active)` → `load(active)`; then `setBatch({ seq: prev + 1, changes })` passed to `FileTree` as `changes`.
  - `onError(message)` → banner `<div className="files-banner files-banner-error" role="status">Auto-refresh stopped: {message}</div>`, hidden while offline.
  - `load(rel)` rejection with `code === "not_found"` → `setRemoved(rel)` (and no read error); other codes as today.

- [ ] **Step 1: Update the tests in `src/files/FilesOverlay.test.tsx`**

- Replace the `@tauri-apps/api/core` mock's `Channel: class {}` with a recording one, and answer `files_watch`:

```ts
const channels = vi.hoisted(() => [] as { onmessage?: (e: unknown) => void }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { rel?: string }) => {
    if (cmd === "files_list_all") return { paths: [], capped: false, refused: false };
    if (cmd === "files_watch") return 1;
    if (cmd === "files_read") {
      const text = texts[args?.rel ?? ""] ?? "x";
      return { kind: "text", text, truncated: truncated.has(args?.rel ?? ""), size: text.length, mtime: 1 };
    }
    return [];
  }),
  Channel: class {
    onmessage?: (e: unknown) => void;
    constructor() {
      channels.push(this);
    }
  },
}));
```

- Remove `POLL_MS` from the `./limits` import and delete the test "shows File removed when polling finds the open file gone".
- Rename `describe("read errors and polling")` to `describe("read errors and the watch")` and add, inside it (it has `key` and `prev` in scope):

```tsx
    const watch = () => channels[channels.length - 1];

    it("reloads the open file when the watch reports it written", async () => {
      useFiles.getState().open(key, "a.ts", { pin: true });
      const { container } = render(<FilesOverlay />);
      await waitFor(() => expect(container.querySelector(".files-text")).toBeTruthy());
      await waitFor(() => expect(watch()).toBeTruthy());
      texts["a.ts"] = "changed";
      act(() => watch().onmessage!({ type: "changes", changes: [{ path: "a.ts", isDir: false, removed: false }] }));
      await waitFor(() => expect(container.querySelector(".files-text")!.textContent).toContain("changed"));
      delete texts["a.ts"];
    });

    it("shows File removed when the watch reports the open file removed", async () => {
      useFiles.getState().open(key, "a.ts", { pin: true });
      const { container } = render(<FilesOverlay />);
      await waitFor(() => expect(container.querySelector(".files-text")).toBeTruthy());
      act(() => watch().onmessage!({ type: "changes", changes: [{ path: "a.ts", isDir: false, removed: true }] }));
      expect(await screen.findByText("File removed")).toBeTruthy();
    });

    it("shows File removed when a parent-folder change finds the open file gone", async () => {
      useFiles.getState().open(key, "src/a.ts", { pin: true });
      const { container } = render(<FilesOverlay />);
      await waitFor(() => expect(container.querySelector(".files-text")).toBeTruthy());
      vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
        if (cmd === "files_read") throw { code: "not_found", message: "no such file" };
        return prev!(cmd, args as never);
      }) as never);
      act(() => watch().onmessage!({ type: "changes", changes: [{ path: "src", isDir: true, removed: false }] }));
      expect(await screen.findByText("File removed")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("a resync reloads the lists and the open file", async () => {
      useFiles.getState().open(key, "a.ts", { pin: true });
      render(<FilesOverlay />);
      await waitFor(() => expect(watch()).toBeTruthy());
      vi.mocked(invoke).mockClear();
      act(() => watch().onmessage!({ type: "resync" }));
      await waitFor(() => {
        const cmds = vi.mocked(invoke).mock.calls.map((c) => c[0]);
        expect(cmds).toContain("files_list_all");
        expect(cmds).toContain("files_read");
        expect(cmds).toContain("files_list_dir");
      });
    });

    it("shows and clears the auto-refresh error", async () => {
      render(<FilesOverlay />);
      await waitFor(() => expect(watch()).toBeTruthy());
      act(() => watch().onmessage!({ type: "error", message: "upper limit on inotify watches reached!" }));
      expect(screen.getByRole("status").textContent).toBe("Auto-refresh stopped: upper limit on inotify watches reached!");
      act(() => watch().onmessage!({ type: "resync" }));
      expect(screen.queryByRole("status")).toBeNull();
    });
```

Also add `channels.length = 0;` to the outer `beforeEach`.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm test src/files/FilesOverlay.test.tsx`
Expected: the five new tests FAIL (no watch wired yet).

- [ ] **Step 3: Wire `useWatch` in `FilesBrowser`, add the `changes` batch and error banner, map `not_found` in `load`, and do the removals listed under Files**

- [ ] **Step 4: Run the whole frontend suite**

Run: `pnpm test && pnpm typecheck && grep -rn "filesChanged\|filesStat\|usePolling\|POLL_MS\|ChangedList\|files-changed" src`
Expected: all tests pass, typecheck clean, grep prints nothing for `src/files` and `src/lib` (an unrelated `POLL_MS` in `src/chat` or `src/quota` is fine).

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(files): the overlay follows the Files watch; polling and the CHANGED list are gone"
```

---

### Task 8: Full verification

- [ ] **Step 1:** `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings 2>&1 | tail -20` — Expected: tests pass; no clippy errors in files you touched (pre-existing warnings elsewhere are out of scope; report them, do not fix).
- [ ] **Step 2:** `pnpm test && pnpm typecheck` — Expected: pass.
- [ ] **Step 3:** `git status --short` — Expected: clean (no stray `cargo fmt` rewrites).
