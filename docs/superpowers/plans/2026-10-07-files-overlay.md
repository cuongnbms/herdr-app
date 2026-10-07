# Files overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only, full-screen Files overlay (⌘O) that browses and reads the files of one Workspace, local or over ssh.

**Architecture:** A new Rust module `src-tauri/src/files/` runs small `sh -c` scripts through the Machine's `Transport` (so local and ssh share one path) behind six Tauri commands. A new frontend folder `src/files/` holds a zustand store keyed by Workspace, the tree, Go to file, tabs and the text/markdown/image views; the overlay mounts from `App.tsx` the way the Agent Dashboard does.

**Tech Stack:** Rust (tokio, serde, tauri 2), React 19 + TypeScript, zustand 5, `@tanstack/react-virtual`, `lowlight` 3 (highlight.js 11), react-markdown + remark-gfm + rehype-highlight, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-10-07-files-overlay-design.md`

## Global Constraints

- Read-only: no command in `files/` writes, moves or deletes anything.
- Every script gets its arguments as positional parameters (`sh -c SCRIPT sh "$root" "$rel" …`); never format a path into script text.
- `rel` is checked by `files::paths::check_rel` before any script runs; `root` goes through `files::paths::resolve_root`. Both return `AppError::new("invalid", …)` on failure.
- Error codes: `invalid` (bad argument), `not_found` (missing file or folder), `too_large` is NOT a code — use `invalid` with message `"image larger than 5 MB"`; script failure is `io` with the trimmed stderr as message.
- Limits, as Rust `pub const` in `src-tauri/src/files/mod.rs`: `MAX_TEXT_BYTES = 2 * 1024 * 1024`, `MAX_IMAGE_BYTES = 5 * 1024 * 1024`, `BINARY_SNIFF_BYTES = 8192`, `MAX_LIST_FILES = 50_000`, `MAX_CHANGED = 200`, `MAX_DIR_ENTRIES = 5000`. Frontend: `HIGHLIGHT_LIMIT = 300_000` chars, `POLL_MS = 2000`, `GOTO_RESULTS = 50` in `src/files/limits.ts`.
- The skipped folder names live in one place: `pub const SKIP_DIRS` in `src-tauri/src/complete/files.rs` (made `pub`), used by both `complete` and `files`.
- Image extensions (lowercase): `png jpg jpeg gif webp svg avif bmp`; markdown: `md markdown`. Rust owns the image decision (`files::paths::is_image`); the frontend uses `FileContent.kind`.
- `mtime` is whole seconds since the epoch (`u64`); `size` is bytes (`u64`).
- Tauri command args are snake_case in Rust and camelCase in `invoke` (`machineId`, `root`, `rel`, `rels`), as in `src/lib/ipc.ts`.
- Workspace key for the files store: `wsKey(ref) = [machine_id, session, workspace_id].join("/")`, exported from `src/files/store.ts`.
- UI copy is exact as written in the spec (e.g. "Binary file, not shown", "Showing the first 2 MB", "File removed", "Machine offline", "Select a workspace first", "Too many files at this root", "First 50,000 files", "Open a file from the tree, or press ⌘P").
- CSS: new rules go at the end of `src/styles.css` under a `/* Files overlay */` comment, class prefix `files-`, colours only from existing tokens (`--surface-*`, `--fg*`, `--line*`, `--accent*`, `--hl-*`, `--amber`, `--green`, `--err`).
- After `cargo fmt`, revert formatting changes to Rust files this plan does not touch (repo is not fmt-clean).
- pnpm: if `pnpm` is not on PATH in this checkout, run it via `mise exec -- pnpm` or `npx pnpm`.

## Review Focus

- Root is a subfolder of a git repo: `git status` paths are repo-relative and must be rewritten relative to the root, and changes outside the root dropped (Task 5 tests it).
- File names with spaces, quotes, leading dashes or non-UTF-8 bytes must list and open (Tasks 2–3 test spaces/quotes/dash).
- A slow remote response for an old file must not overwrite the view of a newer one (Task 7 tests `latestOnly`).
- `~` in a stored Workspace folder must resolve to the Machine's home, not the Mac's (Task 1 tests `resolve_root`).
- Esc inside Go to file / find bar must close only that, not the overlay (Task 12 tests it).

---

### Task 1: Raw exec and path checks

**Files:**
- Modify: `src-tauri/src/transport/mod.rs` (add `exec_bytes`)
- Modify: `src-tauri/src/complete/files.rs` (rename `SKIP` → `pub const SKIP_DIRS`)
- Create: `src-tauri/src/files/mod.rs`, `src-tauri/src/files/paths.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod files;`)

**Interfaces:**
- Produces:
  - `pub struct ExecBytes { pub status: i32, pub stdout: Vec<u8>, pub stderr: String }` and `pub async fn exec_bytes(t: &dyn Transport, argv: &[String]) -> AppResult<ExecBytes>` in `transport/mod.rs`. `exec_input` is refactored to call a shared private runner so the timeout/kill behaviour is identical; `exec` keeps its signature.
  - `pub fn check_rel(rel: &str) -> AppResult<()>`: `""` is the root and is allowed; rejects a leading `/`, any `..` segment, any NUL.
  - `pub fn resolve_root(home: &str, root: &str) -> AppResult<String>`: `~` → `home`, `~/x` → `home/x`; result must start with `/`; trailing `/` trimmed except for `/` itself.
  - `pub fn is_image(rel: &str) -> bool`.
  - `pub fn script_argv(script: &str, args: &[&str]) -> Vec<String>` → `["sh","-c",script,"sh",args…]`.
  - Constants listed in Global Constraints, in `files/mod.rs`.

- [ ] **Step 1: Write the failing tests** in `src-tauri/src/files/paths.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_accepts_plain_and_empty() {
        for ok in ["", "a.txt", "src/a b.ts", ".github/x.yml", "-dash.md", "a..b"] {
            assert!(check_rel(ok).is_ok(), "{ok}");
        }
    }

    #[test]
    fn rel_rejects_escapes() {
        for bad in ["/etc/passwd", "..", "../x", "a/../../x", "a/..", "a\0b"] {
            assert_eq!(check_rel(bad).unwrap_err().code, "invalid", "{bad:?}");
        }
    }

    #[test]
    fn root_expands_tilde_against_machine_home() {
        assert_eq!(resolve_root("/home/u", "~").unwrap(), "/home/u");
        assert_eq!(resolve_root("/home/u", "~/w/app/").unwrap(), "/home/u/w/app");
        assert_eq!(resolve_root("/home/u", "/srv/x").unwrap(), "/srv/x");
        assert_eq!(resolve_root("/home/u", "/").unwrap(), "/");
        assert_eq!(resolve_root("/home/u", "rel/x").unwrap_err().code, "invalid");
        assert_eq!(resolve_root("/home/u", "").unwrap_err().code, "invalid");
    }

    #[test]
    fn images_by_extension() {
        assert!(is_image("a/B.PNG"));
        assert!(is_image("x.svg"));
        assert!(!is_image("x.svgz"));
        assert!(!is_image("png"));
    }
}
```

And in `transport/mod.rs` tests:

```rust
#[tokio::test]
async fn exec_bytes_keeps_non_utf8_stdout() {
    let argv: Vec<String> = ["sh", "-c", "printf '\\377\\000a'"].iter().map(|s| s.to_string()).collect();
    let o = exec_bytes(&local::LocalTransport, &argv).await.unwrap();
    assert_eq!(o.status, 0);
    assert_eq!(o.stdout, vec![0xff, 0x00, b'a']);
}
```

- [ ] **Step 2: Run** `cd src-tauri && cargo test files::paths exec_bytes` — expect compile errors (functions missing).
- [ ] **Step 3: Implement** the Produces list above. `complete/files.rs` uses `SKIP_DIRS` in place of `SKIP`, no behaviour change.
- [ ] **Step 4: Run** `cd src-tauri && cargo test` — all pass (existing `complete::files` tests included).
- [ ] **Step 5: Commit** `feat(files): raw exec and path checks for the Files overlay`

### Task 2: `list_dir`

**Files:**
- Create: `src-tauri/src/files/list.rs`

**Interfaces:**
- Consumes: `check_rel`, `script_argv`, `exec`, `SKIP_DIRS`, `MAX_DIR_ENTRIES`.
- Produces: `#[derive(Serialize, Debug, PartialEq)] #[serde(rename_all = "lowercase")] pub enum EntryKind { File, Dir, Symlink }`; `#[derive(Serialize, Debug, PartialEq)] pub struct Entry { pub name: String, pub kind: EntryKind }`; `pub async fn list_dir(t: &dyn Transport, root: &str, rel: &str) -> AppResult<Vec<Entry>>`.

Behaviour: script `cd "$1" && cd "./$2"` (exit 3 when either fails → `not_found`), loop `for e in * .*` skipping `.`/`..`, prints `d\t<name>`, `l\t<name>` (symlink, tested first) or `f\t<name>`. Rust drops names in `SKIP_DIRS` whose kind is `Dir`, sorts dirs first then files/symlinks, each case-insensitively, truncates to `MAX_DIR_ENTRIES`. Names containing `\n` are dropped (cannot round-trip).

- [ ] **Step 1: Write the failing tests** (in `list.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    fn mk(root: &std::path::Path, files: &[&str]) {
        for p in files {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "x").unwrap();
        }
    }

    #[tokio::test]
    async fn lists_one_level_dirs_first_skipping_heavy_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("my root");
        mk(&root, &["b.md", "A.txt", "src/x.ts", "node_modules/y.js", ".git/HEAD", "-dash.md", "it's.md", "build"]);
        std::os::unix::fs::symlink("b.md", root.join("link")).unwrap();
        let got = list_dir(&LocalTransport, &root.to_string_lossy(), "").await.unwrap();
        let names: Vec<(&str, &EntryKind)> = got.iter().map(|e| (e.name.as_str(), &e.kind)).collect();
        assert_eq!(
            names,
            vec![
                ("src", &EntryKind::Dir),
                ("-dash.md", &EntryKind::File),
                ("A.txt", &EntryKind::File),
                ("b.md", &EntryKind::File),
                ("build", &EntryKind::File),
                ("it's.md", &EntryKind::File),
                ("link", &EntryKind::Symlink),
            ]
        );
        let sub = list_dir(&LocalTransport, &root.to_string_lossy(), "src").await.unwrap();
        assert_eq!(sub, vec![Entry { name: "x.ts".into(), kind: EntryKind::File }]);
    }

    #[tokio::test]
    async fn missing_folder_is_not_found_and_escape_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().to_string_lossy().into_owned();
        assert_eq!(list_dir(&LocalTransport, &r, "nope").await.unwrap_err().code, "not_found");
        assert_eq!(list_dir(&LocalTransport, &r, "../").await.unwrap_err().code, "invalid");
    }
}
```

- [ ] **Step 2: Run** `cd src-tauri && cargo test files::list` — fails to compile.
- [ ] **Step 3: Implement** `list_dir` and `pub mod list;` in `files/mod.rs`.
- [ ] **Step 4: Run** `cd src-tauri && cargo test files::list` — pass.
- [ ] **Step 5: Commit** `feat(files): list one folder of a Workspace`

### Task 3: `read`, `image`, `stat`

**Files:**
- Create: `src-tauri/src/files/read.rs`

**Interfaces:**
- Consumes: Task 1 items, `exec`, `exec_bytes`.
- Produces:
  - `#[serde(rename_all = "lowercase")] pub enum ContentKind { Text, Binary, Image }`
  - `#[derive(Serialize)] pub struct FileContent { pub kind: ContentKind, pub text: Option<String>, pub truncated: bool, pub size: u64, pub mtime: u64 }`
  - `#[derive(Serialize, Clone, Copy, PartialEq, Debug)] pub struct FileStat { pub size: u64, pub mtime: u64 }`
  - `pub async fn read_file(t, root, rel) -> AppResult<FileContent>`
  - `pub async fn read_image(t, root, rel) -> AppResult<Vec<u8>>`
  - `pub async fn stat_files(t, root, rels: &[String]) -> AppResult<Vec<Option<FileStat>>>`

Script notes (POSIX sh, GNU and BSD):
- stat line: `stat -c '%s %Y' -- "$f" 2>/dev/null || stat -f '%z %m' -- "$f"`.
- `read_file`: `cd "$1" || exit 3; f="./$2"; [ -f "$f" ] || exit 3;` print the stat line, then a line `1` or `0` from `head -c 8192 -- "$f" | od -An -c | grep -q '\\0'`, then (when not binary and not an image) `head -c 2097152 -- "$f"`. Rust splits the first two lines off the raw bytes, `String::from_utf8_lossy` on the rest. `truncated = size > MAX_TEXT_BYTES`. For `is_image(rel)` it returns `kind: Image, text: None` without reading content.
- `read_image`: refuse with `invalid` "image larger than 5 MB" when size > `MAX_IMAGE_BYTES` (check in script: print stat line, exit 4 if too big, else `cat`); returns the bytes after the first line.
- `stat_files`: `cd "$1" || exit 3; shift; for r; do s=$(stat … "./$r" 2>/dev/null) || s=-; printf '%s\n' "$s"; done`; `-` → `None`. Every `rel` goes through `check_rel` first. Empty `rels` returns `vec![]` without running anything.
- exit 3 → `not_found`; other non-zero → `io`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    fn root() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("r o'ot");
        std::fs::create_dir_all(r.join("src")).unwrap();
        let s = r.to_string_lossy().into_owned();
        (tmp, s)
    }

    #[tokio::test]
    async fn reads_text_with_size_and_mtime() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/src/a b.ts"), "let x = 1;\n").unwrap();
        let c = read_file(&LocalTransport, &r, "src/a b.ts").await.unwrap();
        assert!(matches!(c.kind, ContentKind::Text));
        assert_eq!(c.text.as_deref(), Some("let x = 1;\n"));
        assert_eq!(c.size, 11);
        assert!(!c.truncated);
        assert!(c.mtime > 1_600_000_000);
    }

    #[tokio::test]
    async fn binary_and_truncated_and_image() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/bin"), [b'a', 0, b'b']).unwrap();
        let c = read_file(&LocalTransport, &r, "bin").await.unwrap();
        assert!(matches!(c.kind, ContentKind::Binary));
        assert_eq!(c.text, None);
        assert_eq!(c.size, 3);

        std::fs::write(format!("{r}/big.txt"), vec![b'x'; MAX_TEXT_BYTES + 10]).unwrap();
        let c = read_file(&LocalTransport, &r, "big.txt").await.unwrap();
        assert!(c.truncated);
        assert_eq!(c.text.unwrap().len(), MAX_TEXT_BYTES);
        assert_eq!(c.size, (MAX_TEXT_BYTES + 10) as u64);

        std::fs::write(format!("{r}/p.png"), [0x89, b'P', b'N', b'G', 0]).unwrap();
        let c = read_file(&LocalTransport, &r, "p.png").await.unwrap();
        assert!(matches!(c.kind, ContentKind::Image));
        assert_eq!(read_image(&LocalTransport, &r, "p.png").await.unwrap(), vec![0x89, b'P', b'N', b'G', 0]);
    }

    #[tokio::test]
    async fn too_large_image_is_refused() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/huge.png"), vec![0u8; MAX_IMAGE_BYTES + 1]).unwrap();
        let e = read_image(&LocalTransport, &r, "huge.png").await.unwrap_err();
        assert_eq!((e.code.as_str(), e.message.as_str()), ("invalid", "image larger than 5 MB"));
    }

    #[tokio::test]
    async fn missing_is_not_found_and_stat_maps_missing_to_none() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/a"), "abc").unwrap();
        assert_eq!(read_file(&LocalTransport, &r, "nope").await.unwrap_err().code, "not_found");
        let s = stat_files(&LocalTransport, &r, &["a".into(), "nope".into()]).await.unwrap();
        assert_eq!(s[0].unwrap().size, 3);
        assert_eq!(s[1], None);
        assert!(stat_files(&LocalTransport, &r, &[]).await.unwrap().is_empty());
        assert_eq!(stat_files(&LocalTransport, &r, &["../x".into()]).await.unwrap_err().code, "invalid");
    }
}
```

- [ ] **Step 2: Run** `cd src-tauri && cargo test files::read` — fails.
- [ ] **Step 3: Implement** the three functions; `pub mod read;` in `files/mod.rs`.
- [ ] **Step 4: Run** `cd src-tauri && cargo test files::read` — pass.
- [ ] **Step 5: Commit** `feat(files): read text, images and stats`

### Task 4: `list_all`

**Files:**
- Create: `src-tauri/src/files/all.rs`

**Interfaces:**
- Consumes: `exec_bytes`, `SKIP_DIRS`, `MAX_LIST_FILES`.
- Produces: `#[derive(Serialize, Debug, PartialEq)] pub struct FileList { pub paths: Vec<String>, pub capped: bool, pub refused: bool }`; `pub async fn list_all(t: &dyn Transport, home: &str, root: &str) -> AppResult<FileList>`.

Behaviour: root equal to `home` or `/` (trailing slashes ignored) → `refused: true`, empty, nothing run. Script: `cd "$1" || exit 3`; inside a work tree `git ls-files -z -co --exclude-standard` (paths are relative to the cwd); otherwise `find . <prune SKIP_DIRS> -o -type f -print0` with `./` stripped in Rust. Output piped through `head -c 16777216` to bound transfer. Rust splits on `\0`, drops empty, drops paths having any segment in `SKIP_DIRS` (git can track them), sorts, sets `capped` when more than `MAX_LIST_FILES` and truncates. exit 3 → `not_found`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;
    use std::process::Command;

    fn mk(root: &std::path::Path, files: &[&str]) {
        for p in files {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "x").unwrap();
        }
    }

    #[tokio::test]
    async fn git_repo_respects_gitignore_and_lists_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("repo");
        mk(&r, &[".gitignore", "src/a.ts", "out/gen.js", "new file.md", "node_modules/m.js"]);
        std::fs::write(r.join(".gitignore"), "out/\n").unwrap();
        Command::new("git").args(["init", "-q"]).current_dir(&r).status().unwrap();
        Command::new("git").args(["add", "src/a.ts", ".gitignore", "-f", "node_modules/m.js"]).current_dir(&r).status().unwrap();
        let got = list_all(&LocalTransport, "/nonexistent-home", &r.to_string_lossy()).await.unwrap();
        assert_eq!(got, FileList { paths: vec![".gitignore".into(), "new file.md".into(), "src/a.ts".into()], capped: false, refused: false });
        // A subfolder root lists paths relative to itself.
        let sub = list_all(&LocalTransport, "/nonexistent-home", &r.join("src").to_string_lossy()).await.unwrap();
        assert_eq!(sub.paths, vec!["a.ts".to_string()]);
    }

    #[tokio::test]
    async fn plain_folder_uses_find_and_skips_heavy_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("plain");
        mk(&r, &["a.md", "target/x", "deep/b.md"]);
        let got = list_all(&LocalTransport, "/nonexistent-home", &r.to_string_lossy()).await.unwrap();
        assert_eq!(got.paths, vec!["a.md".to_string(), "deep/b.md".to_string()]);
    }

    #[tokio::test]
    async fn home_and_slash_are_refused() {
        for (home, root) in [("/home/u", "/home/u/"), ("/home/u", "/")] {
            let got = list_all(&LocalTransport, home, root).await.unwrap();
            assert!(got.refused && got.paths.is_empty(), "{root}");
        }
    }
}
```

- [ ] **Step 2: Run** `cd src-tauri && cargo test files::all` — fails.
- [ ] **Step 3: Implement**; `pub mod all;`.
- [ ] **Step 4: Run** `cd src-tauri && cargo test files::all` — pass.
- [ ] **Step 5: Commit** `feat(files): list every file under a root for Go to file`

### Task 5: Changed files under a root

**Files:**
- Modify: `src-tauri/src/git.rs` (parser takes a limit)
- Create: `src-tauri/src/files/changed.rs`

**Interfaces:**
- Consumes: `git::GitChange`.
- Produces in `git.rs`: `pub(crate) fn parse_porcelain_v2(out: &str, limit: usize) -> GitStatus` (callers in `git_status` pass `MAX_CHANGES`; Chat behaviour unchanged).
- Produces in `files/changed.rs`: `#[derive(Serialize, Debug, PartialEq)] pub struct Changed { pub repo: bool, pub total: u32, pub changes: Vec<GitChange> }`; `pub async fn changed(t: &dyn Transport, root: &str) -> AppResult<Changed>`.

Behaviour: script `cd "$1" 2>/dev/null || exit 0; p=$(git rev-parse --show-prefix 2>/dev/null) || exit 0; printf '%s\0' "$p"; exec git --no-optional-locks status --porcelain=v2 -z -uall -- .`. Empty output → `repo: false`. Rust reads the prefix (first `\0` record), parses the rest with `parse_porcelain_v2(rest, usize::MAX)`, keeps only paths starting with the prefix and strips it, sets `total` to the kept count, truncates `changes` to `MAX_CHANGED`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;
    use std::process::Command;

    #[tokio::test]
    async fn changes_are_relative_to_a_subfolder_root() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("repo");
        std::fs::create_dir_all(r.join("app/src")).unwrap();
        std::fs::write(r.join("top.md"), "1").unwrap();
        std::fs::write(r.join("app/src/a.ts"), "1").unwrap();
        let git = |args: &[&str]| { Command::new("git").args(args).current_dir(&r).output().unwrap(); };
        git(&["init", "-q"]);
        git(&["-c", "user.email=a@b", "-c", "user.name=a", "add", "."]);
        git(&["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"]);
        std::fs::write(r.join("top.md"), "2").unwrap();
        std::fs::write(r.join("app/src/a.ts"), "2").unwrap();
        std::fs::write(r.join("app/new.md"), "n").unwrap();

        let got = changed(&LocalTransport, &r.join("app").to_string_lossy()).await.unwrap();
        assert!(got.repo);
        assert_eq!(got.total, 2);
        let paths: Vec<(&str, &str)> = got.changes.iter().map(|c| (c.code.as_str(), c.path.as_str())).collect();
        assert!(paths.contains(&(" M", "src/a.ts")));
        assert!(paths.contains(&("??", "new.md")));
    }

    #[tokio::test]
    async fn outside_a_repo_is_not_a_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let got = changed(&LocalTransport, &tmp.path().to_string_lossy()).await.unwrap();
        assert_eq!(got, Changed { repo: false, total: 0, changes: vec![] });
    }
}
```

- [ ] **Step 2: Run** `cd src-tauri && cargo test files::changed git::` — fails.
- [ ] **Step 3: Implement**; `pub mod changed;`. Existing `git.rs` tests keep passing with `MAX_CHANGES` passed explicitly.
- [ ] **Step 4: Run** `cd src-tauri && cargo test` — all pass.
- [ ] **Step 5: Commit** `feat(files): changed files under a Workspace root`

### Task 6: Tauri commands, IPC wrappers, types

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` (register)
- Modify: `src/lib/types.ts`, `src/lib/ipc.ts`
- Test: `src/lib/ipc.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces (Rust, each `#[tauri::command] pub async fn`, `mgr: Mgr<'_>, machine_id: String, root: String`, root resolved with `resolve_root(&mgr.info(&machine_id)?.home, &root)`, transport from `mgr.transport(&machine_id)?`):
  - `files_list_dir(.., rel: String) -> Result<Vec<Entry>, AppError>`
  - `files_list_all(..) -> Result<FileList, AppError>`
  - `files_read(.., rel: String) -> Result<FileContent, AppError>`
  - `files_image(.., rel: String) -> Result<tauri::ipc::Response, AppError>`
  - `files_stat(.., rels: Vec<String>) -> Result<Vec<Option<FileStat>>, AppError>`
  - `files_changed(..) -> Result<Changed, AppError>`
- Produces (TS, `types.ts`): `FileEntry { name: string; kind: "file" | "dir" | "symlink" }`, `FileContent { kind: "text" | "binary" | "image"; text: string | null; truncated: boolean; size: number; mtime: number }`, `FileStat { size: number; mtime: number }`, `FileList { paths: string[]; capped: boolean; refused: boolean }`, `Changed { repo: boolean; total: number; changes: GitChange[] }` (reuse the existing `GitChange` type if `types.ts` has one; add it otherwise as `{ code: string; path: string }`).
- Produces (TS, `ipc.ts`): `filesListDir(machineId, root, rel)`, `filesListAll(machineId, root)`, `filesRead(machineId, root, rel)`, `filesImage(machineId, root, rel): Promise<ArrayBuffer>`, `filesStat(machineId, root, rels: string[]): Promise<(FileStat | null)[]>`, `filesChanged(machineId, root)`.

- [ ] **Step 1: Write the failing test** (append to `src/lib/ipc.test.ts`)

```ts
import { filesRead, filesStat } from "./ipc";

describe("files ipc", () => {
  it("passes camelCase args", async () => {
    (invoke as any).mockResolvedValueOnce({ kind: "text", text: "x", truncated: false, size: 1, mtime: 2 });
    await filesRead("devtuf", "~/app", "src/a.ts");
    expect(invoke).toHaveBeenLastCalledWith("files_read", { machineId: "devtuf", root: "~/app", rel: "src/a.ts" });
    (invoke as any).mockResolvedValueOnce([null]);
    await filesStat("local", "/x", ["a"]);
    expect(invoke).toHaveBeenLastCalledWith("files_stat", { machineId: "local", root: "/x", rels: ["a"] });
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/lib/ipc.test.ts` — fails (no export).
- [ ] **Step 3: Implement** the Rust commands, register them in `lib.rs` `generate_handler!`, then the TS types and wrappers.
- [ ] **Step 4: Run** `pnpm vitest run src/lib/ipc.test.ts && pnpm typecheck && (cd src-tauri && cargo build)` — pass.
- [ ] **Step 5: Commit** `feat(files): Tauri commands and IPC for the Files overlay`

### Task 7: Files store, root resolution, stale-response guard

**Files:**
- Create: `src/files/store.ts`, `src/files/root.ts`, `src/files/latest.ts`, `src/files/limits.ts`
- Modify: `src/store/app.ts` (overlay open state)
- Test: `src/files/store.test.ts`, `src/files/root.test.ts`, `src/files/latest.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRef`, `getFolder`, `suggestFolder` from `src/workspaces/folder.ts`; `selectedPane` from `src/store/app.ts`.
- Produces:
  - `src/store/app.ts`: `filesOverlay: WorkspaceRef | null; setFilesOverlay(ref: WorkspaceRef | null): void` — opening sets `dashboardOpen: false, paletteOpen: false`. Not persisted.
  - `src/files/root.ts`: `type Root = { path: string; source: "folder" | "pane" }`; `resolveRoot(ref: WorkspaceRef, ws: WorkspaceView | undefined, selectedCwd: string | null): Root | null` — folder → `{source:"folder"}`; else `selectedCwd` (when the selected pane is in this workspace) else `suggestFolder(ws)` → `{source:"pane"}`; empty → `null`. Also `workspaceOfSelection(state): WorkspaceRef | null` built on `selectedPane`.
  - `src/files/store.ts`: `wsKey(ref)`; per-workspace `FilesWs = { tabs: string[]; preview: string | null; active: string | null; expanded: string[]; scroll: Record<string, number>; recent: string[] }`; zustand `useFiles` with actions taking `key: string` first: `open(key, rel, { pin }: { pin: boolean })`, `pin(key, rel)`, `close(key, rel)`, `cycle(key, delta: 1 | -1)`, `toggleDir(key, rel)`, `setScroll(key, rel, top)`; selector `ws(key): FilesWs` (empty default). `recent` keeps the last 20 opened, newest first.
  - `src/files/latest.ts`: `latestOnly<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R | typeof STALE>` and `export const STALE: unique symbol` — a call whose promise settles after a newer call started resolves to `STALE`.
  - `src/files/limits.ts`: `HIGHLIGHT_LIMIT`, `POLL_MS`, `GOTO_RESULTS`.

Tab rules: `open` without pin replaces the existing preview tab in place (same index) or appends; opening a file already in `tabs` just activates it (and pins it if `pin`). `close` of the active tab activates the right neighbour, else the left, else `null`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/files/store.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { useFiles, wsKey } from "./store";

const K = wsKey({ machine_id: "local", session: "default", workspace_id: "w1" });
const s = () => useFiles.getState().ws(K);

describe("files tabs", () => {
  beforeEach(() => useFiles.setState(useFiles.getInitialState(), true));

  it("previews replace each other; pinned stay", () => {
    const { open } = useFiles.getState();
    open(K, "a.ts", { pin: false });
    open(K, "b.ts", { pin: false });
    expect(s().tabs).toEqual(["b.ts"]);
    expect(s().preview).toBe("b.ts");
    open(K, "c.ts", { pin: true });
    open(K, "d.ts", { pin: false });
    expect(s().tabs).toEqual(["b.ts", "c.ts", "d.ts"]);
    expect(s().preview).toBe("d.ts");
    expect(s().active).toBe("d.ts");
  });

  it("pin keeps the preview tab", () => {
    const { open, pin } = useFiles.getState();
    open(K, "a.ts", { pin: false });
    pin(K, "a.ts");
    open(K, "b.ts", { pin: false });
    expect(s().tabs).toEqual(["a.ts", "b.ts"]);
  });

  it("closing the active tab activates the right neighbour, else the left", () => {
    const { open, close } = useFiles.getState();
    for (const f of ["a", "b", "c"]) open(K, f, { pin: true });
    useFiles.getState().open(K, "b", { pin: true });
    close(K, "b");
    expect(s().active).toBe("c");
    close(K, "c");
    expect(s().active).toBe("a");
    close(K, "a");
    expect(s().active).toBeNull();
  });

  it("cycles and records recent files newest first", () => {
    const { open, cycle } = useFiles.getState();
    for (const f of ["a", "b", "c"]) open(K, f, { pin: true });
    cycle(K, 1);
    expect(s().active).toBe("a");
    cycle(K, -1);
    expect(s().active).toBe("c");
    expect(s().recent.slice(0, 3)).toEqual(["c", "b", "a"]);
  });

  it("keeps workspaces apart", () => {
    const other = wsKey({ machine_id: "local", session: "default", workspace_id: "w2" });
    useFiles.getState().open(K, "a", { pin: true });
    expect(useFiles.getState().ws(other).tabs).toEqual([]);
  });
});
```

```ts
// src/files/root.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { resolveRoot } from "./root";
import { setFolder } from "../workspaces/folder";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };
const ws = { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [{ panes: [{ cwd: "/p/first" }] }] } as never;

describe("resolveRoot", () => {
  beforeEach(() => localStorage.clear());
  it("prefers the workspace folder", () => {
    setFolder(ref, "~/app");
    expect(resolveRoot(ref, ws, "/p/sel")).toEqual({ path: "~/app", source: "folder" });
  });
  it("falls back to the selected pane cwd, then the first pane cwd", () => {
    expect(resolveRoot(ref, ws, "/p/sel")).toEqual({ path: "/p/sel", source: "pane" });
    expect(resolveRoot(ref, ws, null)).toEqual({ path: "/p/first", source: "pane" });
  });
  it("is null with nothing to go on", () => {
    expect(resolveRoot(ref, undefined, null)).toBeNull();
  });
});
```

```ts
// src/files/latest.test.ts
import { describe, expect, it } from "vitest";
import { latestOnly, STALE } from "./latest";

describe("latestOnly", () => {
  it("drops a response that settles after a newer call started", async () => {
    let resolveFirst!: (v: string) => void;
    const calls = [new Promise<string>((r) => (resolveFirst = r)), Promise.resolve("second")];
    let i = 0;
    const f = latestOnly(() => calls[i++]);
    const first = f();
    const second = f();
    resolveFirst("first");
    expect(await first).toBe(STALE);
    expect(await second).toBe("second");
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/files` — fails.
- [ ] **Step 3: Implement** the Produces list.
- [ ] **Step 4: Run** `pnpm vitest run src/files src/store && pnpm typecheck` — pass.
- [ ] **Step 5: Commit** `feat(files): per-workspace tabs, root resolution and stale guard`

### Task 8: Fuzzy matcher

**Files:**
- Create: `src/files/fuzzy.ts`
- Test: `src/files/fuzzy.test.ts`

**Interfaces:**
- Produces: `fuzzyScore(query: string, path: string): number | null` (null = no match; case-insensitive subsequence); `rankFiles(query: string, paths: string[], recent: string[], limit: number): string[]` — empty query returns `recent` (those still in `paths`) followed by `paths` in order, up to `limit`; otherwise matches sorted by score desc, then shorter path, then alphabetical.

Scoring: +1 per matched char, +5 for each char that directly follows the previous match, +8 when a match starts a segment (after `/`, `-`, `_`, `.`, or at a lower→upper case change), +10 when every matched char falls in the file name (last segment).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { fuzzyScore, rankFiles } from "./fuzzy";

const paths = ["src/files/FileTree.tsx", "src/files/fuzzy.ts", "docs/tree.md", "src/lib/ipc.ts"];

describe("fuzzy", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("ftr", "src/files/FileTree.tsx")).not.toBeNull();
    expect(fuzzyScore("zz", "src/lib/ipc.ts")).toBeNull();
  });
  it("prefers file-name and boundary matches", () => {
    expect(rankFiles("tree", paths, [], 50)).toEqual(["docs/tree.md", "src/files/FileTree.tsx"]);
    expect(rankFiles("ipc", paths, [], 50)[0]).toBe("src/lib/ipc.ts");
  });
  it("empty query shows recent first, then the rest, capped", () => {
    expect(rankFiles("", paths, ["src/lib/ipc.ts", "gone.ts"], 3)).toEqual([
      "src/lib/ipc.ts",
      "src/files/FileTree.tsx",
      "src/files/fuzzy.ts",
    ]);
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/files/fuzzy.test.ts` — fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — pass.
- [ ] **Step 5: Commit** `feat(files): fuzzy file ranking for Go to file`

### Task 9: Highlighted, virtualised text view with find

**Files:**
- Modify: `package.json` (add `"lowlight": "^3.3.0"` as a direct dependency; already installed transitively)
- Create: `src/files/highlightLines.ts`, `src/files/find.ts`, `src/files/TextView.tsx`, `src/files/FindBar.tsx`
- Test: `src/files/highlightLines.test.ts`, `src/files/find.test.ts`

**Interfaces:**
- Produces:
  - `type Seg = { text: string; cls: string }` (`cls` = space-joined `hljs-*` classes, `""` for plain); `highlightLines(text: string, path: string): Seg[][]` — language from extension via `lowlight` `common` grammars (`registered(ext)` else plain); text longer than `HIGHLIGHT_LIMIT` or unknown language → one plain seg per line. Splits the hast tree into lines by walking text nodes with a stack of ancestor classes and cutting at `\n`, so a multi-line token (block comment, template string) keeps its class on every line. Trailing `\n` does not add an empty last line.
  - `findMatches(lines: string[], query: string): { line: number; start: number; end: number }[]` — case-insensitive, non-overlapping, empty query → `[]`.
  - `TextView({ text, path, initialScroll, onScroll, find }: { text: string; path: string; initialScroll: number; onScroll(top: number): void; find: { query: string; index: number } | null })` — `useVirtualizer` with fixed row height (read from a CSS var `--files-line-h`, default 20px), gutter with line numbers, current match scrolled into view, matches wrapped in `<mark className="files-match">` (current: `files-match current`).
  - `FindBar({ count, index, query, onQuery, onStep, onClose })` — Enter → `onStep(1)`, Shift+Enter → `onStep(-1)`, Esc → `onClose()` with `stopPropagation()`; shows `${index + 1} / ${count}` or `0 / 0`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/files/highlightLines.test.ts
import { describe, expect, it } from "vitest";
import { highlightLines } from "./highlightLines";
import { HIGHLIGHT_LIMIT } from "./limits";

const text = (l: { text: string }[]) => l.map((s) => s.text).join("");

describe("highlightLines", () => {
  it("splits into lines and keeps token classes across line breaks", () => {
    const lines = highlightLines("/* a\nb */\nconst x = 1;\n", "x.ts");
    expect(lines).toHaveLength(3);
    expect(lines.map(text)).toEqual(["/* a", "b */", "const x = 1;"]);
    expect(lines[1][0].cls).toContain("hljs-comment");
    expect(lines[2].some((s) => s.cls.includes("hljs-keyword") && s.text === "const")).toBe(true);
  });
  it("unknown extension and huge text are plain", () => {
    expect(highlightLines("a\nb", "x.unknownext")).toEqual([[{ text: "a", cls: "" }], [{ text: "b", cls: "" }]]);
    const big = "x".repeat(HIGHLIGHT_LIMIT + 1);
    expect(highlightLines(big, "a.ts")).toEqual([[{ text: big, cls: "" }]]);
  });
});
```

```ts
// src/files/find.test.ts
import { describe, expect, it } from "vitest";
import { findMatches } from "./find";

describe("findMatches", () => {
  it("finds case-insensitive, non-overlapping matches per line", () => {
    expect(findMatches(["aAa", "xa"], "aa")).toEqual([{ line: 0, start: 0, end: 2 }]);
    expect(findMatches(["Foo foo", "bar"], "foo")).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 0, start: 4, end: 7 },
    ]);
    expect(findMatches(["x"], "")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `pnpm install && pnpm vitest run src/files/highlightLines.test.ts src/files/find.test.ts` — fails.
- [ ] **Step 3: Implement** the four files.
- [ ] **Step 4: Run** the same tests + `pnpm typecheck` — pass.
- [ ] **Step 5: Commit** `feat(files): virtualised highlighted text view with find`

### Task 10: Markdown and image views, FileView dispatch

**Files:**
- Create: `src/chat/markdown.tsx` (moved out of `ChatItemView.tsx`), `src/files/links.ts`, `src/files/MarkdownView.tsx`, `src/files/ImageView.tsx`, `src/files/FileView.tsx`
- Modify: `src/chat/ChatItemView.tsx` (import from `./markdown`)
- Test: `src/files/links.test.ts`, `src/files/FileView.test.tsx`

**Interfaces:**
- Consumes: `TextView`, `FindBar`, `findMatches` (Task 9); `filesRead`, `filesImage` (Task 6); `latestOnly` (Task 7).
- Produces:
  - `src/chat/markdown.tsx`: `export const mdComponents`, `export const remarkPlugins`, `export const rehypePlugins` (bodies moved unchanged, plus `ExternalLink`, `InLinkContext`, helpers they need). `ChatItemView` behaviour unchanged; its existing tests must still pass.
  - `src/files/links.ts`: `resolveLink(fromRel: string, href: string): { kind: "file"; rel: string; hash: string | null } | { kind: "external"; url: string } | { kind: "anchor"; hash: string } | null` — `http(s):`/`mailto:` → external; `#x` → anchor; relative or root-relative (`/docs/a.md` = from root) → file with `..` resolved; escaping above root → `null`.
  - `MarkdownView({ text, rel, onOpen }: { text: string; rel: string; onOpen(rel: string): void })` — `ReactMarkdown` with `{ ...mdComponents, a: … }` where `a` uses `resolveLink`: file → `onOpen`, external → existing `ExternalLink`, anchor → scroll to the id.
  - `ImageView({ machineId, root, rel })` — `filesImage` → `new Blob([buf])` → `URL.createObjectURL`, revoked on unmount/change; fit by default, click toggles `files-image actual`. SVG uses `type: "image/svg+xml"` on the Blob.
  - `FileView({ machineId, root, rel, content, mode, onMode, onOpen, find, … })`: picks Text / Markdown (when `rel` ends `.md|.markdown` and `mode === "render"`) / Image / the binary notice "Binary file, not shown" + size; shows the "Showing the first 2 MB" banner when `content.truncated`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/files/links.test.ts
import { describe, expect, it } from "vitest";
import { resolveLink } from "./links";

describe("resolveLink", () => {
  it("resolves relative and root-relative files", () => {
    expect(resolveLink("docs/a.md", "./b.md")).toEqual({ kind: "file", rel: "docs/b.md", hash: null });
    expect(resolveLink("docs/a.md", "../src/x.ts#L3")).toEqual({ kind: "file", rel: "src/x.ts", hash: "L3" });
    expect(resolveLink("docs/a.md", "/README.md")).toEqual({ kind: "file", rel: "README.md", hash: null });
    expect(resolveLink("docs/a.md", "b%20c.md")).toEqual({ kind: "file", rel: "docs/b c.md", hash: null });
  });
  it("classifies external, anchors and escapes", () => {
    expect(resolveLink("a.md", "https://x.y")).toEqual({ kind: "external", url: "https://x.y" });
    expect(resolveLink("a.md", "#intro")).toEqual({ kind: "anchor", hash: "intro" });
    expect(resolveLink("a.md", "../../etc/passwd")).toBeNull();
  });
});
```

```tsx
// src/files/FileView.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { FileView } from "./FileView";

const base = { machineId: "local", root: "/r", onMode: () => {}, onOpen: () => {}, find: null, initialScroll: 0, onScroll: () => {} };

describe("FileView", () => {
  it("shows the binary notice", () => {
    render(<FileView {...base} rel="a.bin" mode="render" content={{ kind: "binary", text: null, truncated: false, size: 2048, mtime: 1 }} />);
    expect(screen.getByText("Binary file, not shown")).toBeInTheDocument();
  });
  it("shows the truncated banner", () => {
    render(<FileView {...base} rel="a.log" mode="render" content={{ kind: "text", text: "x", truncated: true, size: 3e6, mtime: 1 }} />);
    expect(screen.getByText("Showing the first 2 MB")).toBeInTheDocument();
  });
  it("renders markdown in render mode and source in source mode", () => {
    const content = { kind: "text" as const, text: "# Title", truncated: false, size: 7, mtime: 1 };
    const { rerender } = render(<FileView {...base} rel="a.md" mode="render" content={content} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    rerender(<FileView {...base} rel="a.md" mode="source" content={content} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `pnpm vitest run src/files/links.test.ts src/files/FileView.test.tsx` — fails.
- [ ] **Step 3: Implement**; move the markdown pieces out of `ChatItemView.tsx` first.
- [ ] **Step 4: Run** `pnpm vitest run src/files src/chat && pnpm typecheck` — pass.
- [ ] **Step 5: Commit** `feat(files): markdown, image and file view`

### Task 11: Tree, Changed list, Go to file

**Files:**
- Create: `src/files/FileTree.tsx`, `src/files/ChangedList.tsx`, `src/files/GoToFile.tsx`
- Test: `src/files/FileTree.test.tsx`, `src/files/GoToFile.test.tsx`

**Interfaces:**
- Consumes: `filesListDir`, `filesListAll`, `filesChanged` types; `useFiles` (`toggleDir`, `expanded`); `rankFiles`, `GOTO_RESULTS`.
- Produces:
  - `FileTree({ machineId, root, wsKey, onOpen }: { …; onOpen(rel: string, pin: boolean): void })` — loads `""` on mount and each expanded folder on first expand (cache per folder in component state; `reloadKey` prop forces a refetch). Click → `onOpen(rel, false)`, double click → `onOpen(rel, true)`. A failed folder shows a row "Could not list: <message>" with a "Retry" button. Keyboard on the tree (`role="tree"`, items `role="treeitem"` with `aria-expanded`): ↑/↓ move focus, → expand or move into, ← collapse or go to parent, Enter open pinned.
  - `ChangedList({ changed, onOpen })` — hidden when `!changed?.repo || changed.total === 0`; header `CHANGED (${total})`; rows show the code (`??` shown as `?`, else the non-space letter) and the path; click → `onOpen(path, false)`.
  - `GoToFile({ list, recent, onOpen, inputRef })` where `list: FileList | null` — input placeholder "Go to file…  ⌘P"; when `list.refused` the placeholder is "Too many files at this root" and the input is disabled; when `list.capped` a hint "First 50,000 files"; results via `rankFiles(query, list.paths, recent, GOTO_RESULTS)`; ↑/↓ select, Enter → `onOpen(sel, true)` and clears; Esc clears and blurs with `stopPropagation()`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/files/FileTree.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { invoke } from "@tauri-apps/api/core";
import { FileTree } from "./FileTree";

describe("FileTree", () => {
  it("loads lazily and opens files as preview or pinned", async () => {
    vi.mocked(invoke).mockImplementation(async (_cmd, args: any) =>
      args.rel === "" ? [{ name: "src", kind: "dir" }, { name: "a.md", kind: "file" }] : [{ name: "x.ts", kind: "file" }],
    );
    const onOpen = vi.fn();
    render(<FileTree machineId="local" root="/r" wsKey="local/default/w1" onOpen={onOpen} reloadKey={0} />);
    fireEvent.click(await screen.findByText("a.md"));
    expect(onOpen).toHaveBeenLastCalledWith("a.md", false);
    fireEvent.doubleClick(screen.getByText("a.md"));
    expect(onOpen).toHaveBeenLastCalledWith("a.md", true);
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(await screen.findByText("x.ts"));
    expect(onOpen).toHaveBeenLastCalledWith("src/x.ts", false);
  });

  it("shows a retry row when a folder fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ code: "io", message: "Permission denied" });
    render(<FileTree machineId="local" root="/r" wsKey="local/default/w2" onOpen={() => {}} reloadKey={0} />);
    expect(await screen.findByText("Could not list: Permission denied")).toBeInTheDocument();
    vi.mocked(invoke).mockResolvedValueOnce([{ name: "ok.md", kind: "file" }]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("ok.md")).toBeInTheDocument());
  });
});
```

```tsx
// src/files/GoToFile.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { GoToFile } from "./GoToFile";

describe("GoToFile", () => {
  it("opens the best match pinned on Enter", () => {
    const onOpen = vi.fn();
    render(<GoToFile list={{ paths: ["docs/tree.md", "src/a.ts"], capped: false, refused: false }} recent={[]} onOpen={onOpen} inputRef={createRef()} />);
    const input = screen.getByPlaceholderText("Go to file…  ⌘P");
    fireEvent.change(input, { target: { value: "tree" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("docs/tree.md", true);
  });
  it("refused root disables the input; capped shows a hint", () => {
    const { rerender } = render(<GoToFile list={{ paths: [], capped: false, refused: true }} recent={[]} onOpen={() => {}} inputRef={createRef()} />);
    expect(screen.getByPlaceholderText("Too many files at this root")).toBeDisabled();
    rerender(<GoToFile list={{ paths: ["a"], capped: true, refused: false }} recent={[]} onOpen={() => {}} inputRef={createRef()} />);
    expect(screen.getByText("First 50,000 files")).toBeInTheDocument();
  });
  it("Esc does not bubble to the overlay", () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><GoToFile list={{ paths: ["a"], capped: false, refused: false }} recent={[]} onOpen={() => {}} inputRef={createRef()} /></div>);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
  });
});
```

(The input has `role="combobox"`.)

- [ ] **Step 2: Run** `pnpm vitest run src/files/FileTree.test.tsx src/files/GoToFile.test.tsx` — fails.
- [ ] **Step 3: Implement** the three components.
- [ ] **Step 4: Run** — pass; `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(files): tree, changed list and Go to file`

### Task 12: Overlay shell, polling, keys, entry points, styles

**Files:**
- Create: `src/files/FilesOverlay.tsx`, `src/files/usePolling.ts`
- Modify: `src/App.tsx` (⌘O, mount), `src/agents/AgentList.tsx` ("Browse files" menu item), `src/ui/icons.tsx` (a `FilesIcon` if none fits; else reuse `FolderOpenIcon`), `src/styles.css`, `CONTEXT.md` (no change if term already present)
- Test: `src/files/FilesOverlay.test.tsx`, `src/App.test.tsx` (⌘O), `src/files/usePolling.test.ts`

**Interfaces:**
- Consumes: everything above; `useApp` (`filesOverlay`, `setFilesOverlay`, `machines`, `selected`); `showToast`; `setFolder`; the existing "Change folder…" action (`a.changeFolder(ref, folder)` from the Agent list actions — call the same action from the overlay's empty state).
- Produces:
  - `usePolling({ enabled, machineId, root, rel, mtime, size, onChanged, onChanges })`: every `POLL_MS` while `enabled`: `filesStat` for `rel` → when `size`/`mtime` differ, `onChanged()`; when it returns `null`, `onChanged("removed")`; then `filesChanged` → `onChanges(result)`. Uses `setTimeout` chaining (next tick scheduled after both calls settle), stops on unmount or `enabled=false`.
  - `FilesOverlay()` — renders when `filesOverlay` is set. Layout per spec: header (`Files · <label>`, root path, machine name when `machine.kind === "ssh"`, ⟳, ✕, and "Set as workspace folder" when `root.source === "pane"`), left column (GoToFile, ChangedList, FileTree; width draggable 200–600px, default 280, kept in component state), right column (tabs with preview tab in italics, breadcrumb, copy path via the clipboard plugin, Source/Render toggle for markdown, FileView, FindBar). Empty right column copy: "Open a file from the tree, or press ⌘P". No root → empty state with "Change folder…".
  - Banners: "Machine offline" when `machines[id].state !== "connected"` (polling disabled; last content kept); "File removed" after polling reports removal (content kept).
  - Read flow: `latestOnly(filesRead)` per overlay; result `STALE` ignored; a read error shows its message inside the view.
  - Keys while open (listener on window, `capture: false`): ⌘P focus Go to file; ⌘W close active tab (prevent default so the window does not close); ⌘⇧[ / ⌘⇧] cycle; ⌘F open find (Source mode first for markdown); ⌘R reload active file + changed + tree (`reloadKey++`) + file list; Esc closes the overlay unless `document.activeElement` is inside an input or `.overlay` dialog exists.
  - `App.tsx`: ⌘O (no shift/alt/ctrl, ignore repeat, ignored while `dashboardOpen`): if `filesOverlay` set → close; else `workspaceOfSelection(state)` → `setFilesOverlay(ref)`; null → `showToast("Select a workspace first")`. Mount `{filesOverlay && <FilesOverlay />}` next to the dashboard.
  - `AgentList.tsx`: add `{ label: "Browse files", icon: FolderOpenIcon, onSelect: () => useApp.getState().setFilesOverlay(ref) }` as the first non-agent item (before "Change folder…").

- [ ] **Step 1: Write the failing tests**

```ts
// src/files/usePolling.test.ts
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ filesStat: vi.fn(), filesChanged: vi.fn() }));
import { filesChanged, filesStat } from "../lib/ipc";
import { usePolling } from "./usePolling";
import { POLL_MS } from "./limits";

describe("usePolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports a changed mtime and a removed file, and stops when disabled", async () => {
    vi.mocked(filesChanged).mockResolvedValue({ repo: false, total: 0, changes: [] });
    vi.mocked(filesStat).mockResolvedValueOnce([{ size: 1, mtime: 2 }]).mockResolvedValueOnce([null]);
    const onChanged = vi.fn();
    const { rerender } = renderHook((p: { enabled: boolean }) =>
      usePolling({ enabled: p.enabled, machineId: "local", root: "/r", rel: "a", mtime: 1, size: 1, onChanged, onChanges: () => {} }),
      { initialProps: { enabled: true } });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onChanged).toHaveBeenLastCalledWith();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(onChanged).toHaveBeenLastCalledWith("removed");
    rerender({ enabled: false });
    const calls = vi.mocked(filesStat).mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(vi.mocked(filesStat).mock.calls.length).toBe(calls);
  });
});
```

```tsx
// src/files/FilesOverlay.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []), Channel: class {} }));
import { useApp } from "../store/app";
import { FilesOverlay } from "./FilesOverlay";

const ref = { machine_id: "local", session: "default", workspace_id: "w1" };

describe("FilesOverlay", () => {
  beforeEach(() => {
    localStorage.clear();
    useApp.setState({
      machines: { local: { id: "local", kind: "local", state: "connected", sessions: [{ name: "default", running: true, workspaces: [
        { workspace_id: "w1", label: "app", number: 1, status: "idle", tabs: [{ panes: [{ pane_id: "p1", cwd: "/r" }] }] },
      ] }] } } as never,
      filesOverlay: ref,
    });
  });

  it("shows the root from the pane and offers to save it as the workspace folder", () => {
    render(<FilesOverlay />);
    expect(screen.getByText("/r")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set as workspace folder" })).toBeInTheDocument();
    expect(screen.getByText("Open a file from the tree, or press ⌘P")).toBeInTheDocument();
  });

  it("Esc closes the overlay, but not while an input has focus", () => {
    render(<FilesOverlay />);
    screen.getByRole("combobox").focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useApp.getState().filesOverlay).not.toBeNull();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useApp.getState().filesOverlay).toBeNull();
  });

  it("shows Machine offline when the machine is not connected", () => {
    useApp.setState((s) => ({ machines: { local: { ...s.machines.local, state: "disconnected" } } as never }));
    render(<FilesOverlay />);
    expect(screen.getByText("Machine offline")).toBeInTheDocument();
  });
});
```

Add to `src/App.test.tsx` (follow that file's existing render/setup helpers):

```tsx
it("⌘O with no selection toasts, with a selection opens the Files overlay", () => {
  // no pane selected
  fireEvent.keyDown(window, { key: "o", metaKey: true });
  expect(showToast).toHaveBeenCalledWith("Select a workspace first");
  // select a pane in workspace w1 using the file's existing fixture, then:
  fireEvent.keyDown(window, { key: "o", metaKey: true });
  expect(useApp.getState().filesOverlay).toMatchObject({ workspace_id: expect.any(String) });
  fireEvent.keyDown(window, { key: "o", metaKey: true });
  expect(useApp.getState().filesOverlay).toBeNull();
});
```

(Fixture shapes above use `as never`; the implementer adjusts field names to `src/lib/types.ts` without changing what is asserted.)

- [ ] **Step 2: Run** `pnpm vitest run src/files src/App.test.tsx` — fails.
- [ ] **Step 3: Implement** `usePolling`, `FilesOverlay`, the ⌘O handler, the menu item and the CSS (overlay above the app like `.dash` / the dashboard: fixed inset 0, `--surface-0` background, header on `--surface-chrome`, left column on `--surface-side`, code on `--surface-code`, preview tab title italic, `mark.files-match` on `--accent-soft`, current match outlined with `--accent`, banners amber/err).
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && (cd src-tauri && cargo test)` — all pass.
- [ ] **Step 5: Commit** `feat(files): Files overlay with ⌘O, polling and workspace menu entry`

### Task 13: Real-render check

**Files:**
- Scratch: a headless WKWebView probe under `tmp/` (see `tmp/csp-probe`, `tmp/font-probe` for the existing runners)

- [ ] **Step 1:** `pnpm build` — succeeds.
- [ ] **Step 2:** Load the built `dist/` in the headless WKWebView probe with the production CSP from `src-tauri/tauri.conf.json`, mocking `__TAURI_INTERNALS__.invoke` to return a fixture tree, a `.ts` file, a `.md` file with a mermaid block and a PNG. Expected: the overlay renders, the `.ts` file shows `hljs-*` spans, the markdown renders a heading and the mermaid SVG, the PNG `<img>` loads from a `blob:` URL (no CSP violation in the console).
- [ ] **Step 3:** Report what the probe showed (screenshots or console output); fix any CSP or render issue found in the owning file, re-run `pnpm test`, and commit as `fix(files): …`. No commit when nothing needed fixing.
