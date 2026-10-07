# Files overlay Upload and Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload files/folders from the Mac into a Workspace folder on any Machine, and Download a Workspace file/folder into `~/Downloads`, never overwriting anything.

**Architecture:** A new Rust module `src-tauri/src/files/transfer.rs` streams tar through a new blocking runner that spawns `Transport::wrap(argv)` (identity for the local Machine, ssh for others), so one shell script serves every Machine. Two Tauri commands sit next to `files_*`. The frontend adds a context menu to `FileTree` (open panel from `tauri-plugin-dialog`), a `transfer.ts` that drives a sticky, updatable toast.

**Tech Stack:** Rust (tauri 2, `tar` 0.4, `tempfile`, `libc`), React + TypeScript, vitest + Testing Library, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-opener`.

**Spec:** `docs/superpowers/specs/2026-10-07-files-upload-download-design.md` (rule: `docs/adr/0005-files-write-only-by-upload-never-overwrite.md`)

## Global Constraints

- Nothing on the Machine or in `~/Downloads` is ever replaced. A clash gets the first free Finder-style name: `report (1).md`; folders and dotfiles have no extension; only the last dot splits.
- Name clashes compare **case-insensitively** (APFS volumes are case-insensitive; on Linux this only costs an occasional unneeded `(1)`).
- Error codes are only those in `src-tauri/src/error.rs`: bad input `invalid`, missing thing `not_found`, a failed script or fs call `io`, the 600 s limit `timeout`. Errors are built with `AppError::new(code, msg)`.
- Script failures map to `files::paths::io_error(status, stderr)` (stderr text, else `exit N`).
- `TRANSFER_TIMEOUT = 600 s` per transfer.
- Staging names: `.herdr-upload.XXXXXX` in the destination folder on the Machine, `.herdr-download.` prefix in `~/Downloads`.
- Every tar created by a shell is prefixed with `COPYFILE_DISABLE=1` (no macOS `._*` files).
- Shell scripts take paths as positional args via `files::paths::script_argv`, never formatted into the script, except names in `upload_cmd`, which go through `transport::sh_quote`.
- Toast copy (exact): `Uploading {what} to {where}…`, `Uploaded to {where}: {names joined by ", "}`, `Upload failed: {message}`, `Downloading {name}…`, `Saved {basename}`, `Download failed: {message}`, button `Show in Finder`, `Cannot show in Finder: {message}`. `{where}` is `/` for the root, else `{dir}/`. `{what}` is the basename for one item, else `{n} items`.
- Menu labels (exact): `Upload Files…`, `Upload Folder…`, `Download`.
- Do not modify `src/files/FilesOverlay.tsx` or `src/files/store.ts`.
- `pnpm` may be missing in this worktree (untrusted `mise.toml`); if so prefix commands with the PATH from the main checkout: `PATH="$(cd ../.. && mise where pnpm 2>/dev/null)/bin:$PATH"` or run `mise trust` only if the user agrees. Bare `cargo fmt` touches unrelated files: run it, then `git checkout` every file you did not edit.

## Review Focus

- Uploading a folder into a folder inside it on the local Machine: tar would read what it is writing forever. Expected: `invalid` "cannot upload {name} into itself" before anything runs (Task 5 test).
- Downloading a local folder that contains `~/Downloads` (e.g. the home folder): same recursion. Expected: `invalid` "cannot download a folder that contains Downloads" (Task 5 test).
- `Report.md` exists and `report.md` is uploaded on a Mac: expected `report (1).md`, not an "already exists" failure (Task 2 test).
- Names with spaces, quotes, newlines-free unicode in Upload (`it's a b.md`): expected to land intact (Task 3 test).
- A source becoming unreadable mid-stream: expected the local read error, nothing placed, no staging dir left (Task 3 test).

---

### Task 1: Sticky, updatable toast

**Files:**
- Modify: `src/ui/Toast.tsx`
- Modify: `src/styles.css` (next to the existing `.toast` rules)
- Test: `src/ui/Toast.test.tsx`

**Interfaces:**
- Produces: `showProgressToast(text: string): number`; `updateToast(id: number, text: string, opts?: { alert?: boolean; action?: ToastAction }): void`; `interface ToastAction { label: string; run: () => void }`. `ToastItem` gains `action?: ToastAction`.

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe("Toast")`; add `fireEvent` and the new names to the imports)

```tsx
  it("keeps a progress toast until it is updated, then dismisses it 5 s later", () => {
    vi.useFakeTimers();
    render(<Toasts />);
    let id = 0;
    act(() => void (id = showProgressToast("Uploading a.md to /…")));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Uploading a.md to /…")).toBeTruthy();
    act(() => updateToast(id, "Uploaded to /: a.md", { alert: false }));
    expect(screen.queryByText("Uploading a.md to /…")).toBeNull();
    expect(screen.getByText("Uploaded to /: a.md")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByText("Uploaded to /: a.md")).toBeNull();
  });

  it("runs a toast's action and dismisses it", () => {
    render(<Toasts />);
    const run = vi.fn();
    let id = 0;
    act(() => void (id = showProgressToast("Downloading a.md…")));
    act(() => updateToast(id, "Saved a.md", { alert: false, action: { label: "Show in Finder", run } }));
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByText("Saved a.md")).toBeNull();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/ui/Toast.test.tsx`
Expected: FAIL, `showProgressToast` is not exported.

- [ ] **Step 3: Implement in `src/ui/Toast.tsx`**

`showProgressToast` adds an item with `alert: false` and no timer, returns its id. `updateToast` replaces that item's `text`, `alert` (default `true`) and `action`, then starts the usual `DISMISS_MS` timer; an unknown id does nothing. The toast renders `<button type="button" className="toast-action">{label}</button>` after the text when `action` is set; clicking runs `action.run()` then `dismissToast(id)`. Add a `.toast-action` rule in `src/styles.css` beside `.toast` (plain text button using the existing accent/foreground variables, `margin-left: 8px`).

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run src/ui/Toast.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/Toast.tsx src/ui/Toast.test.tsx src/styles.css
git commit -m "feat(ui): progress toasts that update in place, with an optional action"
```

---

### Task 2: Transfer naming and source checks (Rust)

**Files:**
- Create: `src-tauri/src/files/transfer.rs`
- Modify: `src-tauri/src/files/mod.rs` (add `pub mod transfer;`; replace the module doc line with `//! File browsing on a Machine: scripts run over the transport. The only write is Upload\n//! (`transfer`), which never overwrites (ADR-0005).`)
- Modify: `src-tauri/Cargo.toml` (`tar = "0.4"` in `[dependencies]`; move `tempfile = "3"` from `[dev-dependencies]` to `[dependencies]`)

**Interfaces:**
- Produces (all `pub` in `files::transfer`):
  - `struct Source { pub path: PathBuf, pub name: String, pub is_dir: bool }` (derive `Debug, Clone, PartialEq`)
  - `fn candidate(name: &str, is_dir: bool, n: usize) -> String`
  - `fn unique_name(taken: &mut HashSet<String>, name: &str, is_dir: bool) -> String` — `taken` holds **lowercased** names; the pick is inserted lowercased.
  - `fn taken_set<'a>(names: impl IntoIterator<Item = &'a str>) -> HashSet<String>` — lowercases.
  - `fn check_sources(paths: &[String]) -> AppResult<Vec<Source>>`
  - `fn join_abs(root: &str, rel: &str) -> String` — `("/r","")→"/r"`, `("/r","a/b")→"/r/a/b"`, `("/","a")→"/a"`.

- [ ] **Step 1: Write the failing tests** (a `#[cfg(test)] mod tests` at the bottom of `transfer.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    #[test]
    fn candidate_follows_finder_style() {
        assert_eq!(candidate("report.md", false, 0), "report.md");
        assert_eq!(candidate("report.md", false, 1), "report (1).md");
        assert_eq!(candidate("report.md", false, 2), "report (2).md");
        assert_eq!(candidate("assets", true, 1), "assets (1)");
        assert_eq!(candidate("v1.2", true, 1), "v1.2 (1)");
        assert_eq!(candidate(".env", false, 1), ".env (1)");
        assert_eq!(candidate("a.tar.gz", false, 1), "a.tar (1).gz");
        assert_eq!(candidate("x (1).md", false, 1), "x (1) (1).md");
        assert_eq!(candidate("Makefile", false, 1), "Makefile (1)");
    }

    #[test]
    fn unique_name_skips_taken_case_insensitively_and_records_its_pick() {
        let mut taken = taken_set(["Report.md", "report (1).md"]);
        assert_eq!(unique_name(&mut taken, "report.md", false), "report (2).md");
        assert_eq!(unique_name(&mut taken, "new.md", false), "new.md");
        assert_eq!(unique_name(&mut taken, "a.png", false), "a.png");
        assert_eq!(unique_name(&mut taken, "A.png", false), "A (1).png");
    }

    #[test]
    fn join_abs_handles_root_and_slash() {
        assert_eq!(join_abs("/r", ""), "/r");
        assert_eq!(join_abs("/r", "a/b"), "/r/a/b");
        assert_eq!(join_abs("/", "a"), "/a");
        assert_eq!(join_abs("/", ""), "/");
    }

    #[test]
    fn check_sources_validates_paths_and_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        fs::write(p.join("a.md"), "x").unwrap();
        fs::create_dir(p.join("d")).unwrap();
        symlink(p.join("d"), p.join("link")).unwrap();
        symlink(p.join("missing"), p.join("dangling")).unwrap();

        assert_eq!(check_sources(&[]).unwrap_err().code, "invalid");
        assert_eq!(check_sources(&["rel/a.md".into()]).unwrap_err().code, "invalid");
        assert_eq!(check_sources(&[format!("{}/a\nb", p.display())]).unwrap_err().code, "invalid");
        assert_eq!(check_sources(&[format!("{}/nope", p.display())]).unwrap_err().code, "not_found");
        let fifo = p.join("pipe");
        assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
        assert_eq!(check_sources(&[fifo.to_str().unwrap().into()]).unwrap_err().code, "invalid");

        let got = check_sources(&[
            format!("{}/a.md", p.display()),
            format!("{}/d", p.display()),
            format!("{}/link", p.display()),
            format!("{}/dangling", p.display()),
        ])
        .unwrap();
        let summary: Vec<_> = got.iter().map(|s| (s.name.as_str(), s.is_dir)).collect();
        // A symlink to a folder is not a folder: it is copied as a link.
        assert_eq!(summary, [("a.md", false), ("d", true), ("link", false), ("dangling", false)]);
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test files::transfer`
Expected: FAIL to compile (functions missing).

- [ ] **Step 3: Implement**

Port `candidate`, `unique_name`, `check_sources` from `/Users/cuongnb/Workspace/utils/remora/src-tauri/src/transfer.rs:20-78`, changing: errors to `AppError::new("invalid" | "not_found" | "io", …)` (a missing path → `not_found` "{p}: no such file"; other stat errors → `io`); `unique_name` compares and records `to_lowercase()`. `check_sources` rejects empty input, non-absolute paths, `\0` or `\n`, and anything not a file, dir or symlink (by `symlink_metadata`).

- [ ] **Step 4: Run to verify they pass**

Run: `cd src-tauri && cargo test files::transfer`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/files/mod.rs src-tauri/src/files/transfer.rs
git commit -m "feat(files): Finder-style names and source checks for transfers"
```

---

### Task 3: Streaming runner and Upload (Rust)

**Files:**
- Modify: `src-tauri/src/files/transfer.rs`

**Interfaces:**
- Consumes: Task 2's `Source`, `unique_name`, `taken_set`; `crate::transport::{Transport, sh_quote}`; `crate::files::paths::io_error`.
- Produces:
  - `pub const TRANSFER_TIMEOUT: Duration = Duration::from_secs(600);`
  - `pub struct Exit { pub code: i32, pub stderr: String }`
  - `pub fn run_piped<T: Send + 'static>(t: &dyn Transport, argv: &[String], timeout: Duration, io: impl FnOnce(ChildStdin, ChildStdout) -> AppResult<T> + Send + 'static) -> AppResult<(Exit, AppResult<T>)>` — `std::process::Command` from `t.wrap(argv, false)`, stdin/stdout/stderr piped; `io` on a spawned thread; stderr drained on another thread; the caller polls `try_wait` every 50 ms and kills the child at the deadline, returning `Err(AppError::new("timeout", format!("transfer timed out after {}s", timeout.as_secs())))`.
  - `pub fn upload_cmd(names: &[String]) -> String` — script for `sh -c`, destination is `$1`.
  - `pub fn write_upload_stream(w: impl Write, items: &[(Source, String)]) -> AppResult<()>`
  - `pub fn upload(t: &dyn Transport, dest_abs: &str, existing: &[String], sources: Vec<Source>) -> AppResult<Vec<String>>` — blocking; returns the final names in source order.

- [ ] **Step 1: Write the failing tests** (add to `mod tests`)

```rust
    use crate::transport::local::LocalTransport;

    fn src(p: &std::path::Path) -> Source {
        check_sources(&[p.to_str().unwrap().to_string()]).unwrap().remove(0)
    }
    /// Sorted names in `dir`, hidden ones included.
    fn ls(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn upload_copies_tree_keeps_symlinks_and_renames_on_conflict() {
        let from = tempfile::tempdir().unwrap();
        let f = from.path();
        fs::create_dir_all(f.join("assets/deep")).unwrap();
        fs::write(f.join("assets/deep/b c.md"), "deep").unwrap();
        symlink("deep/b c.md", f.join("assets/link.md")).unwrap();
        fs::write(f.join("it's a b.md"), "q").unwrap();
        let to = tempfile::tempdir().unwrap();
        let t = to.path();
        let dest = t.to_str().unwrap();
        let sources = vec![src(&f.join("assets")), src(&f.join("it's a b.md"))];

        assert_eq!(upload(&LocalTransport, dest, &[], sources.clone()).unwrap(), ["assets", "it's a b.md"]);
        assert_eq!(fs::read_to_string(t.join("assets/deep/b c.md")).unwrap(), "deep");
        assert_eq!(fs::read_link(t.join("assets/link.md")).unwrap(), std::path::PathBuf::from("deep/b c.md"));
        assert_eq!(fs::read_to_string(t.join("it's a b.md")).unwrap(), "q");

        let existing = ls(t);
        assert_eq!(upload(&LocalTransport, dest, &existing, sources).unwrap(), ["assets (1)", "it's a b (1).md"]);
        assert_eq!(ls(t), ["assets", "assets (1)", "it's a b (1).md", "it's a b.md"]);
    }

    #[test]
    fn upload_fails_on_a_name_taken_after_listing_and_never_replaces() {
        let from = tempfile::tempdir().unwrap();
        fs::write(from.path().join("a.md"), "new").unwrap();
        fs::write(from.path().join("b.md"), "new").unwrap();
        let to = tempfile::tempdir().unwrap();
        fs::write(to.path().join("b.md"), "old").unwrap();
        // The listing missed b.md: it "appeared" after listing.
        let err = upload(
            &LocalTransport,
            to.path().to_str().unwrap(),
            &[],
            vec![src(&from.path().join("a.md")), src(&from.path().join("b.md"))],
        )
        .unwrap_err();
        assert!(err.message.contains("b.md already exists, try again"), "{err:?}");
        assert_eq!(fs::read_to_string(to.path().join("b.md")).unwrap(), "old");
        // a.md was moved before the failure and stays; no staging dir is left.
        assert_eq!(ls(to.path()), ["a.md", "b.md"]);
    }

    #[test]
    fn upload_without_the_done_marker_places_nothing() {
        let to = tempfile::tempdir().unwrap();
        let argv: Vec<String> = ["sh", "-c", &upload_cmd(&["a.md".into()]), "sh", to.path().to_str().unwrap()]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (exit, io) = run_piped(&LocalTransport, &argv, TRANSFER_TIMEOUT, |stdin, _| {
            let mut b = tar::Builder::new(stdin);
            let mut h = tar::Header::new_gnu();
            h.set_size(1);
            h.set_mode(0o644);
            b.append_data(&mut h, "i/a.md", &b"x"[..]).unwrap();
            b.into_inner().map(drop).map_err(|e| AppError::new("io", e.to_string()))
        })
        .unwrap();
        io.unwrap();
        assert_ne!(exit.code, 0);
        assert!(exit.stderr.contains("upload was interrupted"), "{}", exit.stderr);
        assert!(ls(to.path()).is_empty());
    }

    #[test]
    fn upload_reports_the_local_error_when_a_source_cannot_be_read() {
        let from = tempfile::tempdir().unwrap();
        let locked = from.path().join("locked.md");
        fs::write(&locked, "x").unwrap();
        let s = src(&locked);
        fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o000)).unwrap();
        let to = tempfile::tempdir().unwrap();
        let err = upload(&LocalTransport, to.path().to_str().unwrap(), &[], vec![s]).unwrap_err();
        assert!(err.message.contains("locked.md"), "{err:?}");
        assert!(ls(to.path()).is_empty());
    }

    #[test]
    fn run_piped_kills_the_child_after_the_timeout() {
        let argv: Vec<String> = vec!["sleep".into(), "5".into()];
        let started = std::time::Instant::now();
        let err = run_piped(&LocalTransport, &argv, Duration::from_millis(200), |stdin, _| {
            drop(stdin);
            Ok(())
        })
        .unwrap_err();
        assert_eq!(err.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test files::transfer`
Expected: FAIL to compile (`upload`, `run_piped`, `upload_cmd` missing).

- [ ] **Step 3: Implement**

`run_piped`: as in the Interfaces block (port remora `transfer.rs:255-300`, minus its ssh pool handling). If `io`'s thread panics, return `AppError::new("io", "transfer thread panicked")`.

`upload_cmd(names)`: the script from the spec, with the destination as `"$1"`:

```sh
set -e
t=$(mktemp -d "$1/.herdr-upload.XXXXXX"); trap 'rm -rf "$t"' EXIT
tar -xf - -C "$t"
if [ ! -e "$t"/done ]; then echo 'upload was interrupted' >&2; exit 1; fi
```

then per name (each `<n>` is `sh_quote(name)`, each message `sh_quote(&format!("{name} already exists, try again"))`):

```sh
if [ -e "$1"/<n> ] || [ -L "$1"/<n> ]; then printf '%s\n' <msg> >&2; exit 1; fi
mv -n -- "$t"/i/<n> "$1"/<n> || true
if [ -e "$t"/i/<n> ] || [ -L "$t"/i/<n> ]; then printf '%s\n' <msg> >&2; exit 1; fi
```

`write_upload_stream`: port remora `transfer.rs:341-365` (`follow_symlinks(false)`, `i/<name>` entries, `done` last); map errors to `AppError::new("io", format!("{path}: {e}"))`.

`upload`: `let mut taken = taken_set(existing.iter().map(String::as_str))`; names via `unique_name`; `run_piped(t, &script_argv(&upload_cmd(&names), &[dest_abs]), TRANSFER_TIMEOUT, move |stdin, _| write_upload_stream(stdin, &items))`. Settle: `Err` from `run_piped` → return it; `(exit, Err(local))` where `exit.stderr` contains `upload was interrupted` → return `local`; `exit.code != 0` → `io_error(exit.code, &exit.stderr)`; `(_, Err(local))` → `local`; else `Ok(names)`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd src-tauri && cargo test files::transfer`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/files/transfer.rs
git commit -m "feat(files): Upload streams tar to the Machine and never overwrites"
```

---

### Task 4: Download (Rust)

**Files:**
- Modify: `src-tauri/src/files/transfer.rs`

**Interfaces:**
- Consumes: Task 3's `run_piped`, `TRANSFER_TIMEOUT`; Task 2's `candidate`, `join_abs`; `files::paths::{check_rel, io_error, script_argv}`.
- Produces:
  - `pub fn download_target(root: &str, rel: &str) -> AppResult<(String, String)>` — `(parent_abs, name)`; `invalid` "cannot download the whole Workspace folder" for `""`/`"/"`-only rel; runs `check_rel`.
  - `pub fn downloads_dir() -> AppResult<PathBuf>` — `$HOME/Downloads`, created if missing.
  - `pub fn finish_download(staging: &Path, name: &str, downloads: &Path) -> AppResult<PathBuf>`
  - `pub fn download(t: &dyn Transport, parent_abs: &str, name: &str, downloads: &Path) -> AppResult<PathBuf>` — blocking; returns the saved path.

- [ ] **Step 1: Write the failing tests** (add to `mod tests`)

```rust
    #[test]
    fn download_target_splits_and_refuses_the_root() {
        assert_eq!(download_target("/r", "a/b.md").unwrap(), ("/r/a".to_string(), "b.md".to_string()));
        assert_eq!(download_target("/r", "b.md").unwrap(), ("/r".to_string(), "b.md".to_string()));
        assert_eq!(download_target("/", "b").unwrap(), ("/".to_string(), "b".to_string()));
        assert_eq!(download_target("/r", "").unwrap_err().code, "invalid");
        assert_eq!(download_target("/r", "../x").unwrap_err().code, "invalid");
    }

    #[test]
    fn download_saves_files_and_folders_under_free_names() {
        let ws = tempfile::tempdir().unwrap();
        fs::create_dir_all(ws.path().join("dir/sub")).unwrap();
        fs::write(ws.path().join("dir/sub/x.md"), "x").unwrap();
        fs::write(ws.path().join("a.md"), "new").unwrap();
        let dl = tempfile::tempdir().unwrap();
        fs::write(dl.path().join("A.md"), "old").unwrap();
        let parent = ws.path().to_str().unwrap();

        let saved = download(&LocalTransport, parent, "a.md", dl.path()).unwrap();
        assert_eq!(saved, dl.path().join("a (1).md"));
        assert_eq!(fs::read_to_string(&saved).unwrap(), "new");
        assert_eq!(fs::read_to_string(dl.path().join("A.md")).unwrap(), "old");

        let saved = download(&LocalTransport, parent, "dir", dl.path()).unwrap();
        assert_eq!(saved, dl.path().join("dir"));
        assert_eq!(fs::read_to_string(saved.join("sub/x.md")).unwrap(), "x");
        // No staging dir and no AppleDouble files are left behind.
        assert_eq!(ls(dl.path()), ["A.md", "a (1).md", "dir"]);
        assert_eq!(ls(&saved), ["sub"]);
    }

    #[test]
    fn download_of_a_missing_item_fails_and_leaves_nothing() {
        let ws = tempfile::tempdir().unwrap();
        let dl = tempfile::tempdir().unwrap();
        let err = download(&LocalTransport, ws.path().to_str().unwrap(), "nope.md", dl.path()).unwrap_err();
        assert_eq!(err.code, "io");
        assert!(ls(dl.path()).is_empty());
    }
```

(On a case-sensitive volume the first assertion of the second test gets `a.md`; the test temp dirs on this Mac are on APFS case-insensitive, matching the user's machine. If `dl.path().join("a.md").exists()` is false right after writing `A.md`, return early from that part, as remora's `place_treats_case_insensitive_names_as_taken` does.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test files::transfer`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

Remote script, args `$1` parent, `$2` name: `COPYFILE_DISABLE=1 tar -cf - -C "$1" -- "$2"`. `download` runs it with `run_piped`; `io` drops stdin and unpacks stdout with `tar::Archive::new(stdout).unpack(staging)` into `tempfile::Builder::new().prefix(".herdr-download.").tempdir_in(downloads)`; a non-zero exit → `io_error`; then `finish_download`. Port `rename_excl` (macOS `libc::renamex_np(…, libc::RENAME_EXCL)`, non-macOS fallback), `place` (retry `candidate(name, is_dir, n)` for `n` in `0..10_000` on `AlreadyExists`) and `finish_download` from remora `transfer.rs:84-147`. `finish_download` with nothing at `staging/name` → `io` "{name}: nothing was downloaded".

- [ ] **Step 4: Run to verify they pass**

Run: `cd src-tauri && cargo test files::transfer`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/files/transfer.rs
git commit -m "feat(files): Download a file or folder into ~/Downloads under a free name"
```

---

### Task 5: Tauri commands, local-Machine guards, dialog plugin

**Files:**
- Modify: `src-tauri/src/files/transfer.rs` (two guards)
- Modify: `src-tauri/src/commands.rs` (after `files_changed`)
- Modify: `src-tauri/src/lib.rs` (register commands and `tauri_plugin_dialog::init()`)
- Modify: `src-tauri/src/machines.rs:59` (`const LOCAL` → `pub const LOCAL`)
- Modify: `src-tauri/Cargo.toml` (`tauri-plugin-dialog = "2"`)
- Modify: `src-tauri/capabilities/default.json` (add `"dialog:allow-open"`, `"opener:allow-reveal-item-in-dir"`)

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - `pub fn check_upload_into_self(dest_abs: &Path, sources: &[Source]) -> AppResult<()>` — `invalid` "cannot upload {name} into itself" when a real folder source's canonical path is a prefix of `dest_abs`'s canonical path.
  - `pub fn check_download_contains_downloads(src_abs: &Path, downloads: &Path) -> AppResult<()>` — `invalid` "cannot download a folder that contains Downloads" when `src_abs` is a real dir whose canonical path is a prefix of `downloads`' canonical path.
  - Tauri commands (JS names `files_upload`, `files_download`):
    - `files_upload(mgr, machine_id: String, root: String, dest_rel: String, sources: Vec<String>) -> Result<Vec<String>, AppError>`
    - `files_download(mgr, machine_id: String, root: String, rel: String) -> Result<String, AppError>`

- [ ] **Step 1: Write the failing tests** (add to `mod tests` in `transfer.rs`)

```rust
    #[test]
    fn refuses_to_upload_a_folder_into_itself() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("x/inner")).unwrap();
        let s = vec![src(&d.path().join("x"))];
        assert_eq!(check_upload_into_self(&d.path().join("x/inner"), &s).unwrap_err().code, "invalid");
        assert_eq!(check_upload_into_self(&d.path().join("x"), &s).unwrap_err().code, "invalid");
        assert!(check_upload_into_self(d.path(), &s).is_ok());
    }

    #[test]
    fn refuses_to_download_a_folder_that_contains_downloads() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join("Downloads")).unwrap();
        fs::create_dir_all(home.path().join("w")).unwrap();
        let dl = home.path().join("Downloads");
        assert_eq!(check_download_contains_downloads(home.path(), &dl).unwrap_err().code, "invalid");
        assert!(check_download_contains_downloads(&home.path().join("w"), &dl).is_ok());
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test files::transfer`
Expected: FAIL to compile.

- [ ] **Step 3: Implement the guards and the commands**

`files_upload`: `root = files_root(&mgr, &machine_id, &root)?`; `check_rel(&dest_rel)?`; `sources = transfer::check_sources(&sources)?`; `dest = transfer::join_abs(&root, &dest_rel)`; `t = mgr.transport(&machine_id)?`; `existing: Vec<String> = list::list_dir(&*t, &root, &dest_rel).await?` names; if `machine_id == crate::machines::LOCAL` run `check_upload_into_self(Path::new(&dest), &sources)?`; then `tokio::task::spawn_blocking(move || transfer::upload(&*t, &dest, &existing, sources))`, mapping a join error to `AppError::new("io", e.to_string())` as `system_fonts` does.

`files_download`: `root = files_root(…)?`; `(parent, name) = transfer::download_target(&root, &rel)?`; `downloads = transfer::downloads_dir()?`; if local, `check_download_contains_downloads(&Path::new(&parent).join(&name), &downloads)?`; `spawn_blocking(move || transfer::download(&*t, &parent, &name, &downloads))`; return `saved.to_string_lossy().into_owned()`.

Register both in `lib.rs`'s `invoke_handler` after `commands::files_changed`, and `.plugin(tauri_plugin_dialog::init())` after the opener plugin.

- [ ] **Step 4: Run Rust checks**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all tests PASS, no clippy warnings. Then `cargo fmt` and `git checkout` any file this task did not edit.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(files): files_upload and files_download commands; dialog plugin"
```

---

### Task 6: Frontend IPC and transfer flow

**Files:**
- Modify: `src/lib/ipc.ts` (after `filesChanged`)
- Modify: `package.json`, `pnpm-lock.yaml` (`pnpm add @tauri-apps/plugin-dialog@^2`)
- Create: `src/files/transfer.ts`
- Test: `src/files/transfer.test.ts`

**Interfaces:**
- Consumes: Task 1's `showProgressToast`, `updateToast`; Task 5's commands.
- Produces:
  - `filesUpload(machineId: string, root: string, destRel: string, sources: string[]): Promise<string[]>` → `invoke("files_upload", { machineId, root, destRel, sources })`
  - `filesDownload(machineId: string, root: string, rel: string): Promise<string>` → `invoke("files_download", { machineId, root, rel })`
  - `startUpload(machineId: string, root: string, destRel: string, sources: string[]): Promise<boolean>` — `false` without a toast when `sources` is empty.
  - `startDownload(machineId: string, root: string, rel: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const revealItemInDir = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }));
vi.mock("../ui/Toast", () => ({ showProgressToast: vi.fn(() => 7), updateToast: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { showProgressToast, updateToast } from "../ui/Toast";
import { startDownload, startUpload } from "./transfer";

describe("transfer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uploads and reports the final names", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(["a (1).md", "b.md"]);
    expect(await startUpload("m", "/r", "src", ["/Users/u/a.md", "/Users/u/b.md"])).toBe(true);
    expect(invoke).toHaveBeenCalledWith("files_upload", { machineId: "m", root: "/r", destRel: "src", sources: ["/Users/u/a.md", "/Users/u/b.md"] });
    expect(showProgressToast).toHaveBeenCalledWith("Uploading 2 items to src/…");
    expect(updateToast).toHaveBeenCalledWith(7, "Uploaded to src/: a (1).md, b.md", { alert: false });
  });

  it("names one item and the root", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(["a.md"]);
    await startUpload("m", "/r", "", ["/Users/u/a.md"]);
    expect(showProgressToast).toHaveBeenCalledWith("Uploading a.md to /…");
  });

  it("reports a failed upload", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: "io", message: "b.md already exists, try again" });
    expect(await startUpload("m", "/r", "", ["/Users/u/b.md"])).toBe(false);
    expect(updateToast).toHaveBeenCalledWith(7, "Upload failed: b.md already exists, try again");
  });

  it("does nothing for an empty pick", async () => {
    expect(await startUpload("m", "/r", "", [])).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(showProgressToast).not.toHaveBeenCalled();
  });

  it("downloads and offers Show in Finder", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("/Users/u/Downloads/x (1).md");
    await startDownload("m", "/r", "docs/x.md");
    expect(showProgressToast).toHaveBeenCalledWith("Downloading x.md…");
    const [id, text, opts] = vi.mocked(updateToast).mock.calls[0];
    expect([id, text]).toEqual([7, "Saved x (1).md"]);
    expect(opts?.action?.label).toBe("Show in Finder");
    opts?.action?.run();
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/u/Downloads/x (1).md");
  });

  it("reports a failed download", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: "io", message: "tar: x.md: Cannot stat" });
    await startDownload("m", "/r", "x.md");
    expect(updateToast).toHaveBeenCalledWith(7, "Download failed: tar: x.md: Cannot stat");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/files/transfer.test.ts`
Expected: FAIL, `./transfer` not found.

- [ ] **Step 3: Implement**

`ipc.ts` bindings as in Interfaces. `transfer.ts` follows remora `src/lib/transfer.ts` with the Global Constraints copy; failures call `updateToast(id, text)` (alert defaults to true), successes pass `{ alert: false }`. A failed reveal calls `showToast("Cannot show in Finder: …")`. Error text: the `message` of an `{ code, message }` object, else `String(e)`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run src/files/transfer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/ipc.ts src/files/transfer.ts src/files/transfer.test.ts
git commit -m "feat(files): upload and download flows with progress toasts"
```

---

### Task 7: Tree context menu

**Files:**
- Modify: `src/files/FileTree.tsx`
- Modify: `src/ui/icons.tsx` (add `ArrowUpIcon`: `<path d="M12 19V5M6 11l6-6 6 6" />`, same shape as the others)
- Test: `src/files/FileTree.test.tsx`

**Interfaces:**
- Consumes: Task 6's `startUpload`, `startDownload`; `ContextMenu`, `MenuItem` from `src/sidebar/ContextMenu.tsx`; `open` from `@tauri-apps/plugin-dialog`.
- Produces: nothing new for other tasks.

- [ ] **Step 1: Write the failing tests** (add mocks at the top of `FileTree.test.tsx`, below the existing `vi.mock`, and a new `describe`)

```tsx
const dialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => dialogOpen(...a) }));
const startUpload = vi.fn(async () => true);
const startDownload = vi.fn(async () => {});
vi.mock("./transfer", () => ({
  startUpload: (...a: unknown[]) => startUpload(...a),
  startDownload: (...a: unknown[]) => startDownload(...a),
}));

describe("FileTree context menu", () => {
  const listing = async (_cmd: string, args: any) =>
    args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [{ name: "x.ts", kind: "file" }];
  const menuLabels = () => screen.getAllByRole("menuitem").map((b) => b.textContent);

  it("offers Upload and Download on rows, Upload only on empty space", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    render(<FileTree machineId="m" root="/r" filesKey="m/default/c1" onOpen={() => {}} reloadKey={0} />);
    fireEvent.contextMenu(await screen.findByText("src"));
    expect(menuLabels()).toEqual(["Upload Files…", "Upload Folder…", "Download"]);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.contextMenu(screen.getByRole("tree"));
    expect(menuLabels()).toEqual(["Upload Files…", "Upload Folder…"]);
  });

  it("uploads into the folder, the file's folder, or the root, then reloads it", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    dialogOpen.mockResolvedValue(["/Users/u/n.md"]);
    render(<FileTree machineId="m" root="/r" filesKey="m/default/c2" onOpen={() => {}} reloadKey={0} />);
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("x.ts");

    fireEvent.contextMenu(screen.getByText("x.ts"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload Files…" }));
    await waitFor(() => expect(startUpload).toHaveBeenLastCalledWith("m", "/r", "src", ["/Users/u/n.md"]));
    expect(dialogOpen).toHaveBeenLastCalledWith({ multiple: true, directory: false });
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([, a]: any) => a.rel === "src").length).toBe(2));

    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload Folder…" }));
    await waitFor(() => expect(startUpload).toHaveBeenLastCalledWith("m", "/r", "src", ["/Users/u/n.md"]));
    expect(dialogOpen).toHaveBeenLastCalledWith({ multiple: true, directory: true });

    fireEvent.contextMenu(screen.getByRole("tree"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload Files…" }));
    await waitFor(() => expect(startUpload).toHaveBeenLastCalledWith("m", "/r", "", ["/Users/u/n.md"]));
  });

  it("does nothing when the open panel is cancelled", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    startUpload.mockClear();
    dialogOpen.mockResolvedValue(null);
    render(<FileTree machineId="m" root="/r" filesKey="m/default/c3" onOpen={() => {}} reloadKey={0} />);
    fireEvent.contextMenu(await screen.findByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload Files…" }));
    await waitFor(() => expect(dialogOpen).toHaveBeenCalled());
    expect(startUpload).not.toHaveBeenCalled();
  });

  it("downloads the row", async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(listing as any);
    render(<FileTree machineId="m" root="/r" filesKey="m/default/c4" onOpen={() => {}} reloadKey={0} />);
    fireEvent.contextMenu(await screen.findByText("a.md"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(startDownload).toHaveBeenCalledWith("m", "/r", "a.md");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/files/FileTree.test.tsx`
Expected: FAIL (no `menuitem`s).

- [ ] **Step 3: Implement in `FileTree.tsx`**

State `menu: { x: number; y: number; rel: string | null; dir: string } | null`. Each row's `onContextMenu` calls `preventDefault`, `stopPropagation`, and sets `rel` to the row and `dir` to the row for a folder or its parent folder (`""` at top level) for a file. The `role="tree"` div's `onContextMenu` sets `{ rel: null, dir: "" }`. Make the tree div fill the remaining height of its column (CSS `min-height: 100%` on `.files-tree` in `src/styles.css`) so empty space below the rows is clickable. Items: `Upload Files…` (`ArrowUpIcon`), `Upload Folder…` (`FolderInputIcon`), and when `rel !== null` `Download` (`ArrowDownIcon`). Upload: `const picked = await open({ multiple: true, directory })`; `null` → return; normalise a string to `[string]`; `if (await startUpload(machineId, root, dir, picked)) load(dir)`. Render the menu through `createPortal(…, document.body)` like `FileTabs.tsx:87`.

- [ ] **Step 4: Run the frontend suite**

Run: `pnpm vitest run && pnpm tsc --noEmit`
Expected: all PASS. If `FilesOverlay.test.tsx` fails because its `vi.mock("../ui/Toast", …)` lacks the new exports, add `showProgressToast: vi.fn(() => 1), updateToast: vi.fn()` to that mock.

- [ ] **Step 5: Commit**

```bash
git add src/files/FileTree.tsx src/files/FileTree.test.tsx src/ui/icons.tsx src/styles.css src/files/FilesOverlay.test.tsx
git commit -m "feat(files): tree context menu with Upload Files, Upload Folder and Download"
```

---

### Task 8: Whole-branch verification

**Files:** none (fixes only if something fails).

- [ ] **Step 1: Full suites**

Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cd .. && pnpm vitest run && pnpm tsc --noEmit`
Expected: all pass, zero warnings.

- [ ] **Step 2: GNU `mv` check on a Linux Machine**

Run (ssh, no Docker): generate the script with a throwaway test that prints `upload_cmd(&["a.md".into()])`, then on `devtuf`:
`ssh devtuf 'd=$(mktemp -d); touch "$d/a.md"; sh -c "<script>" sh "$d" < /dev/null; echo "exit $?"; ls -A "$d"; rm -rf "$d"'`
Expected: non-zero exit with `upload was interrupted` (empty stdin), `ls` shows only `a.md` (staging removed). Then the same with a tar built locally (`tar -cf - -C <tmp> i done`) piped in, where `i/a.md` clashes: expected `a.md already exists, try again`, original `a.md` intact.

- [ ] **Step 3: Report**

Summarise test counts and the devtuf result; do not launch the app.
