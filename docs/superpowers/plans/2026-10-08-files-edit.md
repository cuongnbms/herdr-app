# File Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quick edits of text files in the File viewer, on local and ssh Machines, where Save never silently overwrites a file that changed on disk.

**Architecture:** A new `files_write` Tauri command runs a shell script over the existing Transport. The script checks size, mtime and POSIX `cksum` against the version the edit started from, then writes a temp file and `mv`s it into place. The frontend keeps each file's unsaved CodeMirror 6 `EditorState` as a **Draft** in a zustand store keyed by the Open item key. The File viewer swaps its read-only view for a `FileEditor` while a Draft exists. The Files watch never replaces a dirty Draft; it raises a conflict banner instead. Closing items, the window or the app asks before a dirty Draft is lost.

**Tech Stack:** Rust (Tauri 2, tokio), TypeScript, React 19, zustand 5, CodeMirror 6 (`@codemirror/state`, `view`, `commands`, `search`, `language`, `language-data`), vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/2026-10-08-files-edit-design.md` (ADR: `docs/adr/0007-file-viewer-edits-save-never-silently-overwrites.md`)

## Global Constraints

- Package manager is **pnpm** (`pnpm add`, `pnpm test`, `pnpm typecheck`). Rust tests: `cd src-tauri && cargo test`. Do not run bare `cargo fmt` (it rewrites unrelated files). Use `rustfmt --edition 2021 <file>` on files you edited only.
- Error codes crossing IPC are `AppError { code, message }`. The new code is `conflict` (add it to the allowed list in `src-tauri/src/error.rs`'s doc comment). The write script's exit statuses map as follows: 3 → `not_found` "no such folder: {root:?}"; 5 → `not_found` "no such file: {rel:?}"; 6 → `conflict` "{rel} changed on disk"; 7 → `invalid` "too many links: {rel:?}"; 8 → `invalid` "{rel} is not a file"; 9 → `io` "incomplete write" (fewer bytes than `$7`, the content length, reached the temp file); anything else → `io_error(status, stderr)`.
- A disk version is `FileVersion { size: u64, mtime: u64, cksum: u32 }` in Rust (`src-tauri/src/files/read.rs`) and `FileVersion { size: number; mtime: number; cksum: number }` in TS (`src/lib/types.ts`). `mtime` is whole seconds, as `stat %Y` / `%m`.
- A Draft's key is exactly the file Open item's key: `itemKey({ kind: "file", ws, root, rel })` = `"file:" + filesKey(ws, root) + "|" + rel`. `draftKey(fk, rel)` in `src/files/drafts.ts` builds it from a files key, and every module uses `draftKey` or `itemKey`, never its own concatenation.
- Text sent to `files_write` is always `state.sliceDoc()` (joined with the Draft's own line separator), never `state.doc.toString()`.
- A file can be edited (`canEdit(content)` in `src/files/editorSetup.ts`) only when `content.editable && content.cksum !== null && roundTrips(content.text)`.
- UI copy, exact strings: buttons `Edit`, `Save`, `Done`, `Reload`, `Overwrite`, `Save again`, `Close`, `Cancel`, `Discard`, `Save All`. Banners `File changed on disk` and `File was deleted`. Dialog title `Unsaved Changes`. Messages `Save changes to "<name>"?` (one file) and `Save changes to <n> files?` (several). Toast `Cannot save <name>: <message>`. Disabled-edit title `Mixed line endings`. Delete-confirm suffix ` Unsaved changes will be lost.`
- Shortcuts in Edit mode: ⌘S saves, ⌘⇧E toggles Edit / Done, Esc is Done (only when no one else handled it, i.e. `!e.defaultPrevented`). ⌘F, ⌘G and Esc inside the editor belong to CodeMirror's search. The viewer's own ⌘F / ⌘G handling is skipped while a Draft exists. ⌘R still publishes a reload.
- Every user-facing "lose a Draft" path goes through `settleDrafts(keys)` in `src/files/closeGuard.ts`. Nothing else asks Save / Discard / Cancel.
- A Draft's `saving` flag blocks a second concurrent save, and conflict detection ignores any read that resolves while `saving` is true.

## Review Focus

- **A watch event for the app's own save** arriving before `files_write` resolves must not raise a false "File changed on disk". Covered by the `saving` rule; Task 9 tests it.
- **Typing during a save**: the text typed after Save was pressed must stay dirty after the save succeeds. Covered in Task 4 (`saved` recomputes dirty against the current doc) and Task 5.
- **Mixed line endings / lone `\r`** must never be editable, or saving rewrites every line. Covered in Task 4.
- **Renaming a folder** that holds a file with a dirty Draft keeps the Draft under the new path, and Save writes to the new path. Covered in Task 11.
- **Esc pressed to close CodeMirror's search panel** must not also leave Edit mode. Covered in Task 8.

---

### Task 1: POSIX `cksum` in Rust

**Files:**
- Create: `src-tauri/src/files/cksum.rs`
- Modify: `src-tauri/src/files/mod.rs` (add `pub mod cksum;`)

**Interfaces:**
- Produces: `pub fn cksum(bytes: &[u8]) -> u32` in `crate::files::cksum`. It returns the first number that the `cksum` binary prints for the same bytes.

- [ ] **Step 1: Write the failing test** (bottom of `cksum.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::cksum;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn system(bytes: &[u8]) -> u32 {
        let mut child = Command::new("cksum")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(bytes).unwrap();
        let out = child.wait_with_output().unwrap();
        let s = String::from_utf8(out.stdout).unwrap();
        s.split_whitespace().next().unwrap().parse().unwrap()
    }

    #[test]
    fn known_values() {
        assert_eq!(cksum(b""), 4294967295);
        assert_eq!(cksum(b"hello\n"), 3015617425);
    }

    #[test]
    fn matches_the_cksum_binary() {
        let long: Vec<u8> = (0..70_000u32).map(|i| (i * 31 % 251) as u8).collect();
        for sample in [&b"a"[..], b"a\r\nb\n", "héllo wörld\n".as_bytes(), &long] {
            assert_eq!(cksum(sample), system(sample), "{} bytes", sample.len());
        }
    }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd src-tauri && cargo test files::cksum`
Expected: compile error, `cksum` not found.

- [ ] **Step 3: Implement `pub fn cksum(bytes: &[u8]) -> u32`**

POSIX algorithm: CRC-32 with polynomial `0x04C11DB7`, MSB-first, initial value 0, no input reflection. Run it over the bytes, then over the length's bytes (least-significant byte first, only as many bytes as the length needs; none for 0). Return the bitwise complement. A 256-entry table built in a `const fn` is fine. Add a `//!` line: "POSIX `cksum` CRC (ADR-0007): the version check of a save compares it with the `cksum` binary's output on the Machine."

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test files::cksum`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/files/cksum.rs src-tauri/src/files/mod.rs
git commit -m "feat(files): POSIX cksum in Rust for the save version check"
```

---

### Task 2: `files_read` reports `cksum` and `editable`

**Files:**
- Modify: `src-tauri/src/files/read.rs` (`FileContent`, `read_file`, new `FileVersion`)
- Modify: `src/lib/types.ts:169-175` (`FileContent`, new `FileVersion`)

**Interfaces:**
- Consumes: `cksum(bytes) -> u32` (Task 1).
- Produces (Rust, `crate::files::read`):
  ```rust
  #[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
  pub struct FileVersion { pub size: u64, pub mtime: u64, pub cksum: u32 }
  // FileContent gains:
  pub cksum: Option<u32>,   // Some only for kind Text and !truncated
  pub editable: bool,       // Text && !truncated && body is valid UTF-8
  ```
- Produces (TS): `export interface FileVersion { size: number; mtime: number; cksum: number }`. `FileContent` gains `cksum: number | null; editable: boolean`.

- [ ] **Step 1: Write the failing tests** (in `read.rs`'s `mod tests`, reusing its `root()` helper)

```rust
    #[tokio::test]
    async fn text_is_editable_with_its_cksum() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/crlf.txt"), b"a\r\nb\n").unwrap();
        let c = read_file(&LocalTransport, &r, "crlf.txt").await.unwrap();
        assert!(c.editable);
        assert_eq!(c.cksum, Some(crate::files::cksum::cksum(b"a\r\nb\n")));
        assert_eq!(c.text.as_deref(), Some("a\r\nb\n"));
    }

    #[tokio::test]
    async fn invalid_utf8_and_truncated_text_are_not_editable() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/latin1.txt"), [b'a', 0xE9, b'b', b'\n']).unwrap();
        let c = read_file(&LocalTransport, &r, "latin1.txt").await.unwrap();
        assert!(!c.editable);
        assert!(c.cksum.is_some());
        std::fs::write(format!("{r}/big.txt"), vec![b'a'; MAX_TEXT_BYTES + 1]).unwrap();
        let c = read_file(&LocalTransport, &r, "big.txt").await.unwrap();
        assert!(c.truncated && !c.editable);
        assert_eq!(c.cksum, None);
    }

    #[tokio::test]
    async fn binary_and_images_are_not_editable() {
        let (_t, r) = root();
        std::fs::write(format!("{r}/b.bin"), [0u8, 1, 2]).unwrap();
        std::fs::write(format!("{r}/i.png"), [0x89u8, b'P', b'N', b'G']).unwrap();
        for rel in ["b.bin", "i.png"] {
            let c = read_file(&LocalTransport, &r, rel).await.unwrap();
            assert!(!c.editable, "{rel}");
            assert_eq!(c.cksum, None, "{rel}");
        }
    }
```

If the test module does not already import `MAX_TEXT_BYTES` and `LocalTransport`, add `use super::super::MAX_TEXT_BYTES;` and `use crate::transport::local::LocalTransport;`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd src-tauri && cargo test files::read`
Expected: compile error, no field `editable` / `cksum`.

- [ ] **Step 3: Implement**

In `read_file`'s text branch, compute `cksum(body)` and `std::str::from_utf8(body).is_ok()` when `!truncated`. Keep `from_utf8_lossy` for `text`. Image and binary content gets `cksum: None, editable: false`. Add `FileVersion` next to `FileStat` with `use serde::Deserialize`. Update the TS types.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test files::read && cd .. && pnpm typecheck`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/files/read.rs src/lib/types.ts
git commit -m "feat(files): files_read reports a text file's cksum and whether it can be edited"
```

---

### Task 3: `files_write` command

**Files:**
- Modify: `src-tauri/src/files/edit.rs` (new `WRITE_SCRIPT`, `pub async fn write`, tests)
- Modify: `src-tauri/src/files/mod.rs` (module doc: "Write (`edit`) replaces a file's content only after a version check, ADR-0007")
- Modify: `src-tauri/src/commands.rs` (new `files_write` after `files_delete`)
- Modify: `src-tauri/src/lib.rs` (register `commands::files_write`)
- Modify: `src-tauri/src/error.rs` (doc: add `conflict`)
- Modify: `src/lib/ipc.ts` (new `filesWrite`)

**Interfaces:**
- Consumes: `FileVersion` (Task 2), `cksum` (Task 1), `exec_input` (`crate::transport`), `check_item` (private in `edit.rs`), `script_argv`, `io_error`.
- Produces:
  ```rust
  pub async fn write(t: &dyn Transport, root: &str, rel: &str, text: &str,
                     expected: Option<FileVersion>) -> AppResult<FileVersion>
  #[tauri::command] pub async fn files_write(mgr: Mgr<'_>, machine_id: String, root: String,
      rel: String, text: String, expected: Option<FileVersion>) -> Result<FileVersion, AppError>
  ```
  ```ts
  export const filesWrite = (machineId: string, root: string, rel: string, text: string, expected: FileVersion | null) =>
    invoke<FileVersion>("files_write", { machineId, root, rel, text, expected });
  ```

- [ ] **Step 1: Write the failing tests** (in `edit.rs`'s `mod tests`, reusing `root()` and `code()`)

```rust
    use crate::files::cksum::cksum;
    use crate::files::read::FileVersion;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fn ver(path: &str) -> FileVersion {
        let m = std::fs::metadata(path).unwrap();
        FileVersion { size: m.size(), mtime: m.mtime() as u64, cksum: cksum(&std::fs::read(path).unwrap()) }
    }

    fn temp_left(dir: &str) -> bool {
        std::fs::read_dir(dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains(".herdr-"))
    }

    #[tokio::test]
    async fn writes_over_the_expected_version_and_keeps_the_mode() {
        let (_t, r) = root();
        let p = format!("{r}/src/a b.txt");
        std::fs::write(&p, "old\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o750)).unwrap();
        let v = write(&LocalTransport, &r, "src/a b.txt", "new\r\nline\n", Some(ver(&p))).await.unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "new\r\nline\n");
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o750);
        assert_eq!(v, ver(&p));
        assert!(!temp_left(&format!("{r}/src")));
    }

    #[tokio::test]
    async fn a_changed_file_is_a_conflict_and_stays_untouched() {
        let (_t, r) = root();
        let p = format!("{r}/src/a.txt");
        std::fs::write(&p, "old\n").unwrap();
        let mut stale = ver(&p);
        stale.cksum ^= 1;
        let e = write(&LocalTransport, &r, "src/a.txt", "mine\n", Some(stale)).await.unwrap_err();
        assert_eq!(code(e), "conflict");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "old\n");
        let mut stale = ver(&p);
        stale.mtime -= 5;
        let e = write(&LocalTransport, &r, "src/a.txt", "mine\n", Some(stale)).await.unwrap_err();
        assert_eq!(code(e), "conflict");
        assert!(!temp_left(&format!("{r}/src")));
    }

    #[tokio::test]
    async fn expected_on_a_removed_file_is_not_found() {
        let (_t, r) = root();
        let v = FileVersion { size: 1, mtime: 1, cksum: 1 };
        let e = write(&LocalTransport, &r, "src/gone.txt", "x", Some(v)).await.unwrap_err();
        assert_eq!(code(e), "not_found");
    }

    #[tokio::test]
    async fn force_overwrites_and_recreates_but_needs_the_folder() {
        let (_t, r) = root();
        let p = format!("{r}/src/a.txt");
        std::fs::write(&p, "theirs\n").unwrap();
        write(&LocalTransport, &r, "src/a.txt", "mine\n", None).await.unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "mine\n");
        std::fs::remove_file(&p).unwrap();
        let v = write(&LocalTransport, &r, "src/a.txt", "back\n", None).await.unwrap();
        assert_eq!(v, ver(&p));
        let e = write(&LocalTransport, &r, "nope/a.txt", "x", None).await.unwrap_err();
        assert_eq!(code(e), "not_found");
    }

    #[tokio::test]
    async fn writes_through_a_symlink_and_keeps_the_link() {
        let (_t, r) = root();
        let p = format!("{r}/src/a.txt");
        std::fs::write(&p, "old\n").unwrap();
        std::os::unix::fs::symlink("src/a.txt", format!("{r}/link.txt")).unwrap();
        write(&LocalTransport, &r, "link.txt", "new\n", Some(ver(&p))).await.unwrap();
        assert!(std::fs::symlink_metadata(format!("{r}/link.txt")).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "new\n");
    }

    #[tokio::test]
    async fn refuses_a_folder_too_much_text_and_unclean_paths() {
        let (_t, r) = root();
        assert_eq!(code(write(&LocalTransport, &r, "src", "x", None).await.unwrap_err()), "invalid");
        let big = "a".repeat(crate::files::MAX_TEXT_BYTES + 1);
        assert_eq!(code(write(&LocalTransport, &r, "src/a.txt", &big, None).await.unwrap_err()), "invalid");
        for rel in ["", "../x", "src//a", "./a"] {
            assert_eq!(code(write(&LocalTransport, &r, rel, "x", None).await.unwrap_err()), "invalid", "{rel:?}");
        }
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd src-tauri && cargo test files::edit`
Expected: compile error, `write` not found.

- [ ] **Step 3: Implement `write` and `WRITE_SCRIPT`**

Args: `$1` root, `$2` rel, `$3` `check` or `force`, `$4` size, `$5` mtime, `$6` cksum (pass `""` for the last three when forced). Stdin is the text. The script is below because the exit contract and its order are the decision:

```sh
cd "$1" || exit 3
f="./$2"
n=0
while [ -L "$f" ]; do
  n=$((n+1)); [ "$n" -le 40 ] || exit 7
  l=$(readlink -- "$f") || exit 1
  case "$l" in /*) f="$l";; *) f="$(dirname -- "$f")/$l";; esac
done
if [ -e "$f" ] && [ ! -f "$f" ]; then exit 8; fi
if [ "$3" = check ]; then
  [ -f "$f" ] || exit 5
  s=$(stat -c '%s %Y' -- "$f" 2>/dev/null || stat -f '%z %m' -- "$f") || exit 1
  [ "$s" = "$4 $5" ] || exit 6
  c=$(cksum < "$f") || exit 1
  [ "${c%% *}" = "$6" ] || exit 6
else
  [ -d "$(dirname -- "$f")" ] || exit 5
fi
t="$(dirname -- "$f")/.$(basename -- "$f").herdr-$$.tmp"
trap 'rm -f -- "$t"' EXIT
cat > "$t" || exit 1
if [ -f "$f" ]; then
  m=$(stat -c '%a' -- "$f" 2>/dev/null || stat -f '%Lp' -- "$f") || exit 1
  chmod "$m" "$t" || exit 1
fi
mv -f -- "$t" "$f" || exit 1
stat -c '%s %Y' -- "$f" 2>/dev/null || stat -f '%z %m' -- "$f"
```

In Rust: `check_item(rel)?`, then refuse `text.len() > MAX_TEXT_BYTES` with `invalid` "text larger than 2 MB". Run `exec_input(t, &script_argv(WRITE_SCRIPT, &[...]), Some(text.as_bytes()))`. Map statuses per Global Constraints. Parse the last stdout line with `read.rs`'s `parse_stat` (make it `pub(super)`) and return `FileVersion { size, mtime, cksum: cksum(text.as_bytes()) }`. A malformed stat line is `io` "unexpected output from the file script". Doc comment: "Replaces `rel`'s content with `text` (ADR-0007): only while it is still `expected`, or regardless when `expected` is None (Overwrite / Save again); atomically, through links."

Add `files_write` to `commands.rs` shaped like `files_create` (resolve with `files_root`, then `edit::write(&*t, &root, &rel, &text, expected).await`), register it in `lib.rs`, and add `filesWrite` to `ipc.ts` with a doc line "Rejects with code `conflict` when the file is no longer `expected`."

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test files:: && cargo clippy --all-targets -- -D warnings && cd .. && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src src/lib/ipc.ts
git commit -m "feat(files): files_write saves only over the expected version, atomically"
```

---

### Task 4: CodeMirror setup and the Drafts store

**Files:**
- Modify: `package.json` / `pnpm-lock.yaml` (`pnpm add @codemirror/state @codemirror/view @codemirror/commands @codemirror/search @codemirror/language @codemirror/language-data`)
- Create: `src/files/editorSetup.ts`
- Create: `src/files/drafts.ts`
- Test: `src/files/editorSetup.test.ts`, `src/files/drafts.test.ts`

**Interfaces:**
- Consumes: `FileContent`, `FileVersion` (Task 2); `itemKey` (`src/store/openItems.ts`); `filesKey`, `relUnder` (`src/files/store.ts`).
- Produces, `editorSetup.ts`:
  ```ts
  export const languageSlot: Compartment;               // FileEditor fills it after the language loads
  export function roundTrips(text: string): boolean;    // createEditorState(text, "").sliceDoc() === text
  export function canEdit(c: FileContent): boolean;     // see Global Constraints
  export function createEditorState(text: string): EditorState; // lineSeparator "\r\n" iff text includes "\r\n"; history(); languageSlot.of([]); editorExtensions()
  export function editorExtensions(): Extension;        // lineNumbers, bracketMatching, highlightActiveLine, search({ top: true }), keymap(defaultKeymap, historyKeymap, searchKeymap, indentWithTab), syntaxHighlighting(defaultHighlightStyle, { fallback: true }); no lineWrapping
  export function languageFor(rel: string): Promise<LanguageSupport | null>; // LanguageDescription.matchFilename(languages, basename) → load()
  ```
  `createEditorState` holds every extension, view ones included (they are facets and work without a view), so a remounted `EditorView` needs only the Draft's state. No other module creates an `EditorState`.
- Produces, `drafts.ts`:
  ```ts
  export interface DiskVersion extends FileVersion { text: string }
  export interface DraftTarget { fk: string; machineId: string; root: string; rel: string }
  export interface Draft extends DraftTarget {
    state: EditorState; base: DiskVersion; baseDoc: Text;
    dirty: boolean; conflict: "changed" | "removed" | null; saving: boolean;
  }
  export const draftKey: (fk: string, rel: string) => string;
  export function diskVersion(c: FileContent): DiskVersion | null; // null unless canEdit(c)
  export const useDrafts: UseBoundStore<StoreApi<{
    drafts: Record<string, Draft>;
    open(target: DraftTarget, base: DiskVersion): void;   // (re)creates a clean Draft, conflict null
    update(key: string, state: EditorState): void;        // dirty = !state.doc.eq(baseDoc)
    rebase(key: string, base: DiskVersion): void;         // only when !dirty: new state from base; else no-op
    saved(key: string, base: DiskVersion): void;          // base := base, baseDoc := state.toText(base.text), dirty recomputed, conflict null, saving false
    setConflict(key: string, c: "changed" | "removed" | null): void;
    setSaving(key: string, on: boolean): void;
    moveUnder(fk: string, from: string, to: string): void; // every draft in fk with relUnder(rel, from) gets rel to + rel.slice(from.length) and its new key
    dropUnder(fk: string, rel: string): void;
    drop(key: string): void;
  }>>;
  export const dirtyUnder: (fk: string, rel: string) => string[]; // keys, from useDrafts.getState()
  export const isDirty: (key: string) => boolean;
  ```

- [ ] **Step 1: Install the dependencies**

Run: `pnpm add @codemirror/state @codemirror/view @codemirror/commands @codemirror/search @codemirror/language @codemirror/language-data`
Expected: `package.json` lists the six packages.

- [ ] **Step 2: Write the failing tests**

`src/files/editorSetup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canEdit, createEditorState, languageFor, roundTrips } from "./editorSetup";

const text = (t: string, over: Partial<{ editable: boolean; cksum: number | null }> = {}) => ({
  kind: "text" as const, text: t, truncated: false, size: t.length, mtime: 1, cksum: 7, editable: true, ...over,
});

describe("editorSetup", () => {
  it("keeps LF and CRLF files byte for byte", () => {
    for (const t of ["", "a", "a\nb\n", "a\r\nb\r\n", "a\r\nb", "\n\n"]) {
      expect(createEditorState(t).sliceDoc()).toBe(t);
      expect(roundTrips(t)).toBe(true);
    }
  });

  it("refuses mixed line endings and a lone CR", () => {
    expect(roundTrips("a\r\nb\nc")).toBe(false);
    expect(roundTrips("a\rb")).toBe(false);
  });

  it("can edit only editable text with a cksum that round-trips", () => {
    expect(canEdit(text("a\n"))).toBe(true);
    expect(canEdit(text("a\n", { editable: false }))).toBe(false);
    expect(canEdit(text("a\n", { cksum: null }))).toBe(false);
    expect(canEdit(text("a\r\nb\n"))).toBe(false);
    expect(canEdit({ kind: "binary", text: null, truncated: false, size: 3, mtime: 1, cksum: null, editable: false })).toBe(false);
  });

  it("finds a language by file name", async () => {
    expect(await languageFor("src/a.ts")).not.toBeNull();
    expect(await languageFor("README.md")).not.toBeNull();
    expect(await languageFor("notes.zzz")).toBeNull();
  });
});
```

`src/files/drafts.test.ts`:

```ts
import { undo } from "@codemirror/commands";
import type { EditorState, Transaction } from "@codemirror/state";
import { beforeEach, describe, expect, it } from "vitest";
import { itemKey } from "../store/openItems";
import { dirtyUnder, draftKey, isDirty, useDrafts, type DiskVersion } from "./drafts";
import { filesKey } from "./store";

const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
const fk = filesKey(ws, "/r");
const target = (rel: string) => ({ fk, machineId: "local", root: "/r", rel });
const base = (text: string, cksum = 1): DiskVersion => ({ text, size: text.length, mtime: 1, cksum });
const d = (rel: string) => useDrafts.getState().drafts[draftKey(fk, rel)];
const type = (rel: string, insert: string) => {
  const s = d(rel).state;
  useDrafts.getState().update(draftKey(fk, rel), s.update({ changes: { from: s.doc.length, insert } }).state);
};
const undoOnce = (rel: string) => {
  let next: EditorState = d(rel).state;
  undo({ state: next, dispatch: (tr: Transaction) => void (next = tr.state) });
  useDrafts.getState().update(draftKey(fk, rel), next);
};

describe("drafts", () => {
  beforeEach(() => useDrafts.setState(useDrafts.getInitialState(), true));

  it("keys a draft like its Open item", () => {
    expect(draftKey(fk, "src/a.ts")).toBe(itemKey({ kind: "file", ws, root: "/r", rel: "src/a.ts" }));
  });

  it("is dirty after typing and clean again after undoing back to the base", () => {
    useDrafts.getState().open(target("a.txt"), base("one\n"));
    expect(d("a.txt").dirty).toBe(false);
    type("a.txt", "two");
    expect(isDirty(draftKey(fk, "a.txt"))).toBe(true);
    undoOnce("a.txt");
    expect(d("a.txt").dirty).toBe(false);
  });

  it("rebases a clean draft onto newer disk content but never a dirty one", () => {
    useDrafts.getState().open(target("a.txt"), base("one\n"));
    useDrafts.getState().rebase(draftKey(fk, "a.txt"), base("agent\n", 2));
    expect(d("a.txt").state.sliceDoc()).toBe("agent\n");
    expect(d("a.txt").base.cksum).toBe(2);
    type("a.txt", "mine");
    useDrafts.getState().rebase(draftKey(fk, "a.txt"), base("agent again\n", 3));
    expect(d("a.txt").state.sliceDoc()).toBe("agent\nmine");
    expect(d("a.txt").base.cksum).toBe(2);
  });

  it("after a save stays dirty only for text typed since", () => {
    useDrafts.getState().open(target("a.txt"), base("one\n"));
    type("a.txt", "x");
    useDrafts.getState().setSaving(draftKey(fk, "a.txt"), true);
    useDrafts.getState().saved(draftKey(fk, "a.txt"), base("one\nx", 5));
    expect(d("a.txt")).toMatchObject({ dirty: false, saving: false, conflict: null });
    type("a.txt", "y");
    useDrafts.getState().saved(draftKey(fk, "a.txt"), base("one\nxy", 6));
    type("a.txt", "z");
    expect(d("a.txt").dirty).toBe(true);
    useDrafts.getState().saved(draftKey(fk, "a.txt"), base("one\nxy", 6));
    expect(d("a.txt").dirty).toBe(true);
  });

  it("follows a folder rename and drops everything under a deleted path", () => {
    useDrafts.getState().open(target("src/a.txt"), base("a"));
    useDrafts.getState().open(target("src/sub/b.txt"), base("b"));
    useDrafts.getState().open(target("srcx.txt"), base("c"));
    type("src/sub/b.txt", "!");
    useDrafts.getState().moveUnder(fk, "src", "lib");
    expect(Object.keys(useDrafts.getState().drafts).sort()).toEqual(
      [draftKey(fk, "lib/a.txt"), draftKey(fk, "lib/sub/b.txt"), draftKey(fk, "srcx.txt")].sort(),
    );
    expect(d("lib/sub/b.txt")).toMatchObject({ rel: "lib/sub/b.txt", dirty: true });
    expect(dirtyUnder(fk, "lib")).toEqual([draftKey(fk, "lib/sub/b.txt")]);
    useDrafts.getState().dropUnder(fk, "lib");
    expect(Object.keys(useDrafts.getState().drafts)).toEqual([draftKey(fk, "srcx.txt")]);
  });
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `pnpm vitest run src/files/editorSetup.test.ts src/files/drafts.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `editorSetup.ts` and `drafts.ts` per the Interfaces block**

`rebase` and `open` build the state with `createEditorState(base.text)`. `baseDoc` is `state.toText(base.text)`. `diskVersion(c)` returns `{ text, size, mtime, cksum }` when `canEdit(c)`. `relUnder(rel, from)` from `./store` decides "under" (the path itself or below it).

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/files/editorSetup.test.ts src/files/drafts.test.ts && pnpm typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/files/editorSetup.ts src/files/editorSetup.test.ts src/files/drafts.ts src/files/drafts.test.ts
git commit -m "feat(files): Drafts hold a file's unsaved CodeMirror state"
```

`package-lock.json` is left as it is (pnpm owns the install).

---

### Task 5: Saving a Draft

**Files:**
- Create: `src/files/save.ts`
- Test: `src/files/save.test.ts`

**Interfaces:**
- Consumes: `filesWrite` (Task 3); `useDrafts`, `Draft` (Task 4); `showToast` (`src/ui/Toast`).
- Produces: `export async function saveDraft(key: string, opts: { force: boolean }): Promise<boolean>`. It resolves true when written. It writes nothing and resolves false when there is no Draft, the Draft is `saving`, or the Draft has a `conflict` while `!opts.force`.

- [ ] **Step 1: Write the failing test**

```ts
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn() }));
import { showToast } from "../ui/Toast";
import { draftKey, useDrafts } from "./drafts";
import { saveDraft } from "./save";

const fk = "fk";
const key = draftKey(fk, "src/a.txt");
const open = (text = "one\n") =>
  useDrafts.getState().open({ fk, machineId: "m1", root: "/r", rel: "src/a.txt" }, { text, size: text.length, mtime: 10, cksum: 99 });
const typeEnd = (s: string) => {
  const st = useDrafts.getState().drafts[key].state;
  useDrafts.getState().update(key, st.update({ changes: { from: st.doc.length, insert: s } }).state);
};

describe("saveDraft", () => {
  beforeEach(() => {
    useDrafts.setState(useDrafts.getInitialState(), true);
    vi.mocked(invoke).mockReset();
    vi.mocked(showToast).mockClear();
  });

  it("writes the text over the base version and takes the new version", async () => {
    open();
    typeEnd("two\n");
    vi.mocked(invoke).mockResolvedValueOnce({ size: 8, mtime: 11, cksum: 5 });
    expect(await saveDraft(key, { force: false })).toBe(true);
    expect(invoke).toHaveBeenCalledWith("files_write", {
      machineId: "m1", root: "/r", rel: "src/a.txt", text: "one\ntwo\n", expected: { size: 4, mtime: 10, cksum: 99 },
    });
    expect(useDrafts.getState().drafts[key]).toMatchObject({ dirty: false, saving: false, base: { text: "one\ntwo\n", cksum: 5 } });
  });

  it("forces with no expected version", async () => {
    open();
    vi.mocked(invoke).mockResolvedValueOnce({ size: 4, mtime: 12, cksum: 6 });
    await saveDraft(key, { force: true });
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ expected: null });
  });

  it("marks a conflict or a removal and keeps the edits", async () => {
    open();
    typeEnd("x");
    vi.mocked(invoke).mockRejectedValueOnce({ code: "conflict", message: "src/a.txt changed on disk" });
    expect(await saveDraft(key, { force: false })).toBe(false);
    expect(useDrafts.getState().drafts[key]).toMatchObject({ conflict: "changed", dirty: true, saving: false });
    expect(await saveDraft(key, { force: false })).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    useDrafts.getState().setConflict(key, null);
    vi.mocked(invoke).mockRejectedValueOnce({ code: "not_found", message: "no such file" });
    await saveDraft(key, { force: false });
    expect(useDrafts.getState().drafts[key].conflict).toBe("removed");
  });

  it("reports other failures in a toast and does not save twice at once", async () => {
    open();
    let fail!: (e: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((_, rej) => (fail = rej)));
    const first = saveDraft(key, { force: false });
    expect(await saveDraft(key, { force: false })).toBe(false);
    fail({ code: "io", message: "disk full" });
    expect(await first).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Cannot save a.txt: disk full");
    expect(useDrafts.getState().drafts[key]).toMatchObject({ saving: false, conflict: null });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run src/files/save.test.ts`
Expected: FAIL, `./save` not found.

- [ ] **Step 3: Implement `saveDraft`**

Capture `text = draft.state.sliceDoc()` before the call. On success call `saved(key, { text, ...version })`, using the key the Draft has *after* the await: a rename during the save moved it, so look it up again by its `fk` and `rel`. If it was dropped, do nothing. Errors keep `saving` cleared. Error code `conflict` → `setConflict(key, "changed")`; `not_found` → `"removed"`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/files/save.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/files/save.ts src/files/save.test.ts
git commit -m "feat(files): saveDraft writes a Draft and records conflicts"
```

---

### Task 6: `FileEditor` component

**Files:**
- Create: `src/files/FileEditor.tsx`
- Modify: `src/styles.css` (append a `/* File editor */` block)
- Test: `src/files/FileEditor.test.tsx`

**Interfaces:**
- Consumes: `useDrafts`, `languageSlot`, `editorExtensions`, `languageFor` (Task 4).
- Produces: `export function FileEditor({ draftKey }: { draftKey: string }): JSX.Element`. It renders `<div className="files-editor">` holding one `EditorView` built from the Draft's `state`, focuses it on mount, and writes each transaction's state back with `useDrafts.getState().update`. It reloads the view when the store's state for that key is replaced from outside (Reload, rebase): compare `draft.state !== view.state`, then `view.setState`. It fills `languageSlot` for the Draft's `rel` once per mount, unless the state already has a language. It destroys the view on unmount.

- [ ] **Step 1: Write the failing test**

```tsx
import { EditorView } from "@codemirror/view";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { draftKey, useDrafts } from "./drafts";
import { FileEditor } from "./FileEditor";

const key = draftKey("fk", "a.ts");
const open = (text: string) =>
  useDrafts.getState().open({ fk: "fk", machineId: "m", root: "/r", rel: "a.ts" }, { text, size: text.length, mtime: 1, cksum: 1 });
const viewOf = (c: HTMLElement) => EditorView.findFromDOM(c.querySelector(".cm-editor") as HTMLElement)!;

describe("FileEditor", () => {
  beforeEach(() => useDrafts.setState(useDrafts.getInitialState(), true));

  it("shows the draft and writes edits back to it", () => {
    open("const a = 1;\n");
    const { container } = render(<FileEditor draftKey={key} />);
    expect(container.querySelector(".cm-content")?.textContent).toContain("const a = 1;");
    act(() => viewOf(container).dispatch({ changes: { from: 0, insert: "// hi\n" } }));
    expect(useDrafts.getState().drafts[key]).toMatchObject({ dirty: true });
    expect(useDrafts.getState().drafts[key].state.sliceDoc()).toBe("// hi\nconst a = 1;\n");
  });

  it("keeps the undo history across a remount and follows a reload from the store", () => {
    open("x\n");
    const first = render(<FileEditor draftKey={key} />);
    act(() => viewOf(first.container).dispatch({ changes: { from: 0, insert: "y" } }));
    first.unmount();
    const { container } = render(<FileEditor draftKey={key} />);
    expect(viewOf(container).state.sliceDoc()).toBe("yx\n");
    act(() => open("from disk\n"));
    expect(viewOf(container).state.sliceDoc()).toBe("from disk\n");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run src/files/FileEditor.test.tsx`
Expected: FAIL, `./FileEditor` not found.

- [ ] **Step 3: Implement `FileEditor`**

Create the view with `new EditorView({ state: draft.state, parent, dispatchTransactions })`; `dispatchTransactions` applies them with `view.update(trs)` and then calls `useDrafts.getState().update(draftKey, view.state)`. Fill the language with `view.dispatch({ effects: languageSlot.reconfigure(support) })` when `languageSlot.get(view.state)` is still empty.

Theme in `styles.css`: `.files-editor { flex: 1; min-height: 0; display: flex; }`, `.files-editor .cm-editor { flex: 1; height: 100%; background: var(--surface-code); color: var(--fg); font-family: "JetBrains Mono", monospace; font-size: inherit; }`, `.cm-scroller { line-height: var(--files-line-h); }`, `.cm-gutters` using the TextView gutter colours (`.files-gutter`'s), `.cm-activeLine` using `var(--accent-soft)` at low strength, `.cm-searchMatch` / `.cm-searchMatch-selected` using `.files-match` / `.files-match.current`'s colours, and `.cm-panels` styled like `.files-find` (FindBar's container). Read those rules in `styles.css` and reuse their variables. No new colour values.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/files/FileEditor.test.tsx && pnpm typecheck`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/files/FileEditor.tsx src/files/FileEditor.test.tsx src/files/editorSetup.ts src/styles.css
git commit -m "feat(files): FileEditor edits a Draft with CodeMirror"
```

---

### Task 7: Unsaved-changes prompt and `settleDrafts`

**Files:**
- Create: `src/files/unsaved.tsx` (store, `askUnsaved`, `UnsavedDialog`)
- Create: `src/files/closeGuard.ts`
- Modify: `src/store/openItems.ts` (new `closingKeys`)
- Modify: `src/App.tsx` (render `<UnsavedDialog />` next to `<Toasts />`)
- Test: `src/files/closeGuard.test.tsx`, `src/store/openItems.test.ts` (add a case)

**Interfaces:**
- Consumes: `useDrafts`, `isDirty` (Task 4); `saveDraft` (Task 5); `Modal` (`src/sidebar/ContextMenu.tsx`).
- Produces:
  ```ts
  // unsaved.tsx
  export type UnsavedChoice = "save" | "discard" | "cancel";
  export function askUnsaved(names: string[]): Promise<UnsavedChoice>; // one pending ask at a time; a second ask while one is open resolves "cancel"
  export function UnsavedDialog(): JSX.Element | null;                // Modal title "Unsaved Changes"; buttons Cancel, Discard, Save (Save All when names.length > 1, autoFocus); Esc / backdrop = cancel
  // closeGuard.ts
  export async function settleDrafts(keys: string[]): Promise<boolean>; // true = go ahead; the Drafts of `keys` are dropped then
  export async function closeItemsGuarded(key: string, scope: "one" | CloseScope): Promise<void>;
  // openItems.ts
  export function closingKeys(s: OpenItems, scope: "one" | CloseScope, key: string): string[]; // keys closeItems(s, scope, key) would remove
  ```
  `settleDrafts`: with no dirty Draft among `keys`, drop those Drafts and resolve true. Otherwise ask with the dirty files' basenames. `cancel` → false. `discard` → drop all → true. `save` → `saveDraft(k, { force: false })` for each dirty key in order. If all succeed, drop all and resolve true. Otherwise resolve false, keeping every Draft (the failed one shows its banner or toast).

- [ ] **Step 1: Write the failing tests**

Add to `src/store/openItems.test.ts` (use the file's existing fixtures for two file items and one agent item if present; else build `OpenItems` literally with `openItem`):

```ts
it("lists the keys a close would remove", () => {
  let s = NO_ITEMS;
  for (const rel of ["a", "b", "c"]) s = openItem(s, { kind: "file", ws, root: "/r", rel }, { pin: true });
  const k = (rel: string) => itemKey({ kind: "file", ws, root: "/r", rel });
  expect(closingKeys(s, "one", k("b"))).toEqual([k("b")]);
  expect(closingKeys(s, "others", k("b"))).toEqual([k("a"), k("c")]);
  expect(closingKeys(s, "right", k("a"))).toEqual([k("b"), k("c")]);
  expect(closingKeys(s, "all", k("a"))).toEqual([k("a"), k("b"), k("c")]);
  expect(closingKeys(s, "one", "nope")).toEqual([]);
});
```

`src/files/closeGuard.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./save", () => ({ saveDraft: vi.fn(async () => true) }));
import { useApp } from "../store/app";
import { itemKey } from "../store/openItems";
import { closeItemsGuarded, settleDrafts } from "./closeGuard";
import { draftKey, useDrafts } from "./drafts";
import { saveDraft } from "./save";
import { filesKey } from "./store";
import { UnsavedDialog } from "./unsaved";

const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
const fk = filesKey(ws, "/r");
const openDraft = (rel: string, dirty: boolean) => {
  useDrafts.getState().open({ fk, machineId: "local", root: "/r", rel }, { text: "t", size: 1, mtime: 1, cksum: 1 });
  if (dirty) {
    const s = useDrafts.getState().drafts[draftKey(fk, rel)].state;
    useDrafts.getState().update(draftKey(fk, rel), s.update({ changes: { from: 0, insert: "!" } }).state);
  }
};

describe("settleDrafts", () => {
  beforeEach(() => {
    useDrafts.setState(useDrafts.getInitialState(), true);
    useApp.setState(useApp.getInitialState(), true);
    vi.mocked(saveDraft).mockClear();
    render(<UnsavedDialog />);
  });

  it("goes ahead without asking when nothing is dirty", async () => {
    openDraft("a.txt", false);
    expect(await settleDrafts([draftKey(fk, "a.txt")])).toBe(true);
    expect(useDrafts.getState().drafts).toEqual({});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks once, and Cancel keeps everything", async () => {
    openDraft("a.txt", true);
    const p = settleDrafts([draftKey(fk, "a.txt")]);
    expect(await screen.findByText('Save changes to "a.txt"?')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await p).toBe(false);
    expect(useDrafts.getState().drafts[draftKey(fk, "a.txt")]).toBeTruthy();
  });

  it("Discard drops the drafts; Save All saves each dirty one first", async () => {
    openDraft("a.txt", true);
    openDraft("b.txt", true);
    openDraft("c.txt", false);
    const keys = ["a.txt", "b.txt", "c.txt"].map((r) => draftKey(fk, r));
    let p = settleDrafts(keys);
    expect(await screen.findByText("Save changes to 2 files?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save All" }));
    expect(await p).toBe(true);
    expect(vi.mocked(saveDraft).mock.calls.map((c) => c[0])).toEqual(keys.slice(0, 2));
    expect(useDrafts.getState().drafts).toEqual({});
    openDraft("a.txt", true);
    p = settleDrafts([keys[0]]);
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(await p).toBe(true);
    expect(useDrafts.getState().drafts).toEqual({});
  });

  it("a failed save stops the close", async () => {
    openDraft("a.txt", true);
    vi.mocked(saveDraft).mockResolvedValueOnce(false);
    const p = settleDrafts([draftKey(fk, "a.txt")]);
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await p).toBe(false);
    expect(useDrafts.getState().drafts[draftKey(fk, "a.txt")]).toBeTruthy();
  });

  it("closeItemsGuarded closes only after the drafts are settled", async () => {
    useApp.getState().openFile(ws, "/r", "a.txt", { pin: true });
    openDraft("a.txt", true);
    const key = itemKey({ kind: "file", ws, root: "/r", rel: "a.txt" });
    const p = closeItemsGuarded(key, "one");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await act(() => p);
    expect(useApp.getState().openItems.items).toHaveLength(1);
    const q = closeItemsGuarded(key, "one");
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await act(() => q);
    expect(useApp.getState().openItems.items).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm vitest run src/files/closeGuard.test.tsx src/store/openItems.test.ts`
Expected: FAIL, modules or exports not found.

- [ ] **Step 3: Implement per the Interfaces block**

The dialog store is a small zustand store in `unsaved.tsx` holding `{ names, resolve } | null`. With one name, the message is `Save changes to "<name>"?`. With several, it is `Save changes to <n> files?` followed by a `<ul>` of the names. Buttons use the existing classes `btn` (Cancel, Discard) and `btn btn-primary` (Save / Save All). If `btn-primary` does not exist in `styles.css`, use the class the TextDialog's submit button uses. Mount `<UnsavedDialog />` in `App.tsx` right after `<Toasts />`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/files/closeGuard.test.tsx src/store/openItems.test.ts && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/files/unsaved.tsx src/files/closeGuard.ts src/files/closeGuard.test.tsx src/store/openItems.ts src/store/openItems.test.ts src/App.tsx
git commit -m "feat(files): ask Save / Discard / Cancel before unsaved Drafts are lost"
```

---

### Task 8: Edit mode in the File viewer

**Files:**
- Modify: `src/files/FileViewer.tsx`
- Modify: `src/styles.css` (`.files-crumbs` buttons `Edit` / `Save` / `Done` reuse `.files-mode button` look)
- Test: `src/files/FileViewer.edit.test.tsx` (new file with its own `invoke` mock)

**Interfaces:**
- Consumes: `canEdit`, `useDrafts`, `draftKey`, `diskVersion` (Task 4); `saveDraft` (Task 5); `FileEditor` (Task 6); `settleDrafts` (Task 7); `filesKey`.
- Produces: no new exports. Behaviour:
  - The Draft key is `itemKey(item)`. `const draft = useDrafts((s) => s.drafts[itemKey(item)])`.
  - When there is no Draft and `canEdit(shown)`: an `Edit` button (`aria-label="Edit"`). When `shown` is text with `editable && cksum !== null` but not `roundTrips`: a disabled `Edit` button with `title="Mixed line endings"`.
  - Edit → `useDrafts.getState().open({ fk: key, machineId, root, rel }, diskVersion(shown)!)`.
  - With a Draft: `Save` (disabled unless `draft.dirty`, label `Save`, plus `…` while `saving`) and `Done`. The Render/Source group, the Outline button and the FindBar are not rendered, and `.files-view` renders `<FileEditor draftKey={itemKey(item)} />`.
  - Done → `settleDrafts([itemKey(item)])`. A Draft that is still there afterwards means Cancel or a failed save.
  - Keys (window listener, existing `.overlay` guard kept): ⌘S with a Draft → `saveDraft(k, { force: false })`. If `draft.conflict` is set, it adds the class `flash` to the conflict banner for 600 ms instead (Task 9 renders the banner; until then the call is a no-op). ⌘⇧E → Edit when allowed, else Done when a Draft exists. Escape (no modifiers, `!e.defaultPrevented`) with a Draft → Done. ⌘F / ⌘G are ignored while a Draft exists. The existing early return `if (!e.metaKey || e.altKey || e.ctrlKey) return;` must let a plain Escape through.

- [ ] **Step 1: Write the failing test**

```tsx
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
const disk = vi.hoisted(() => ({ text: "one\n", cksum: 9, mtime: 1, editable: true }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { text?: string }) => {
    if (cmd === "files_read") return { kind: "text", text: disk.text, truncated: false, size: disk.text.length, mtime: disk.mtime, cksum: disk.cksum, editable: disk.editable };
    if (cmd === "files_write") return { size: args!.text!.length, mtime: 2, cksum: 10 };
    return [];
  }),
  Channel: class {},
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("../ui/Toast", () => ({ showToast: vi.fn(), showProgressToast: vi.fn(() => 1), updateToast: vi.fn() }));
import { useApp } from "../store/app";
import { itemKey } from "../store/openItems";
import { useFilesBus } from "./bus";
import { useDrafts } from "./drafts";
import { FileViewer } from "./FileViewer";
import { useFiles } from "./store";
import { UnsavedDialog } from "./unsaved";

const ws = { machine_id: "local", session: "default", workspace_id: "w1" };
const item = { kind: "file" as const, ws, root: "/r", rel: "a.txt" };
const key = itemKey(item);
const press = (k: string, extra: Partial<KeyboardEventInit> = {}) => act(() => void fireEvent.keyDown(window, { key: k, ...extra }));
const typeAtEnd = (s: string) => {
  const v = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
  act(() => v.dispatch({ changes: { from: v.state.doc.length, insert: s } }));
};
const writes = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_write");

describe("FileViewer edit mode", () => {
  beforeEach(() => {
    Object.assign(disk, { text: "one\n", cksum: 9, mtime: 1, editable: true });
    useFiles.setState(useFiles.getInitialState(), true);
    useFilesBus.setState(useFilesBus.getInitialState(), true);
    useApp.setState(useApp.getInitialState(), true);
    useDrafts.setState(useDrafts.getInitialState(), true);
    vi.mocked(invoke).mockClear();
  });

  it("Edit, type, ⌘S saves over the read version, Done leaves", async () => {
    render(<><FileViewer item={item} online /><UnsavedDialog /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(document.querySelector(".cm-editor")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    typeAtEnd("two\n");
    press("s", { metaKey: true });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][1]).toMatchObject({ rel: "a.txt", text: "one\ntwo\n", expected: { size: 4, mtime: 1, cksum: 9 } });
    await waitFor(() => expect(useDrafts.getState().drafts[key].dirty).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.querySelector(".cm-editor")).toBeNull());
    expect(useDrafts.getState().drafts[key]).toBeUndefined();
  });

  it("⌘⇧E enters, Esc with unsaved changes asks, Cancel stays", async () => {
    render(<><FileViewer item={item} online /><UnsavedDialog /></>);
    await screen.findByRole("button", { name: "Edit" });
    press("e", { metaKey: true, shiftKey: true });
    expect(document.querySelector(".cm-editor")).toBeTruthy();
    typeAtEnd("x");
    press("Escape");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector(".cm-editor")).toBeTruthy();
  });

  it("Esc that closes the editor's search panel does not leave Edit mode", async () => {
    render(<><FileViewer item={item} online /><UnsavedDialog /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // CodeMirror's search panel handles Esc first and prevents its default.
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ev.preventDefault();
    act(() => void window.dispatchEvent(ev));
    expect(document.querySelector(".cm-editor")).toBeTruthy();
  });

  it("offers no Edit for a file that cannot be edited and a disabled one for mixed line endings", async () => {
    disk.editable = false;
    const { unmount } = render(<FileViewer item={item} online />);
    await screen.findByText("one");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    unmount();
    Object.assign(disk, { editable: true, text: "a\r\nb\nc" });
    render(<FileViewer item={item} online />);
    const edit = (await screen.findByRole("button", { name: "Edit" })) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe("Mixed line endings");
  });

  it("keeps the draft when the viewer is remounted, as switching tabs does", async () => {
    const first = render(<FileViewer key="1" item={item} online />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    typeAtEnd("kept");
    first.unmount();
    render(<FileViewer key="2" item={item} online />);
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("onekept"));
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run src/files/FileViewer.edit.test.tsx`
Expected: FAIL, no button named "Edit".

- [ ] **Step 3: Implement the behaviour listed in Interfaces**

- [ ] **Step 4: Run the viewer tests**

Run: `pnpm vitest run src/files/FileViewer.edit.test.tsx src/files/FileViewer.test.tsx && pnpm typecheck`
Expected: all pass. The existing FileViewer tests are unchanged and still pass.

- [ ] **Step 5: Commit**

```bash
git add src/files/FileViewer.tsx src/files/FileViewer.edit.test.tsx src/styles.css
git commit -m "feat(files): Edit mode in the File viewer with Save and Done"
```

---

### Task 9: Files watch, conflicts and the conflict banner

**Files:**
- Modify: `src/files/FileViewer.tsx` (`load` and the removed handling, banner)
- Modify: `src/styles.css` (`.files-banner-conflict`, its buttons, `.flash`)
- Test: `src/files/FileViewer.edit.test.tsx` (more cases)

**Interfaces:**
- Consumes: `useDrafts` actions `rebase`, `setConflict`, `open`, `drop` (Task 4); `diskVersion`; `saveDraft` (Task 5); `useApp.getState().closeItems` (Close after a removal needs no guard: the user chose to close).
- Produces: behaviour only.
  - When a read resolves and a Draft exists for the item: `draft.saving` → ignore it for conflict purposes (still `setDoc`). Not dirty → `rebase(key, diskVersion(content))`, or `setConflict(key, "changed")` when `diskVersion` is null. Dirty → `content.cksum !== draft.base.cksum` → `setConflict(key, "changed")`. Equal → nothing.
  - When the file is removed (`own.removed`, or a `not_found` read) and a Draft exists → `setConflict(key, "removed")`. The plain "File removed" banner is not shown while a Draft exists.
  - Banner `<div className="files-banner files-banner-conflict" role="alert">`. For `changed`: text `File changed on disk`, buttons `Reload` → read the file, then `open(target, diskVersion(content))` (if `diskVersion` is null, drop the Draft), and `Overwrite` → `saveDraft(key, { force: true })`. For `removed`: text `File was deleted`, buttons `Save again` → `saveDraft(key, { force: true })`, and `Close` → `useDrafts.getState().drop(key)` then `useApp.getState().closeItems(key, "one")`.
  - ⌘S while `draft.conflict` is set adds `flash` to the banner for 600 ms and writes nothing.

- [ ] **Step 1: Write the failing tests** (append to the `describe` in `FileViewer.edit.test.tsx`)

```tsx
  const publish = (changes: { path: string; isDir: boolean; removed: boolean }[]) =>
    act(() => useFilesBus.getState().publish(itemKey(item).slice("file:".length, -"|a.txt".length), changes));
  const startEditing = async () => {
    render(<><FileViewer item={item} online /><UnsavedDialog /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  };

  it("a clean draft follows the agent's write", async () => {
    await startEditing();
    Object.assign(disk, { text: "agent\n", cksum: 20, mtime: 5 });
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("agent"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a dirty draft is never replaced; a real change raises the banner, a touch does not", async () => {
    await startEditing();
    typeAtEnd("mine");
    disk.mtime = 7; // touched only: same cksum
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_read").length).toBe(2));
    expect(screen.queryByText("File changed on disk")).toBeNull();
    Object.assign(disk, { text: "agent\n", cksum: 21 });
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    expect(await screen.findByText("File changed on disk")).toBeTruthy();
    expect(document.querySelector(".cm-content")?.textContent).toContain("one" + "mine");
    press("s", { metaKey: true });
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][1]).toMatchObject({ expected: null, text: "one\nmine" });
    await waitFor(() => expect(screen.queryByText("File changed on disk")).toBeNull());
  });

  it("Reload takes the disk version and drops the edits", async () => {
    await startEditing();
    typeAtEnd("mine");
    Object.assign(disk, { text: "agent\n", cksum: 22 });
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("agent"));
    expect(useDrafts.getState().drafts[key]).toMatchObject({ dirty: false, conflict: null, base: { cksum: 22 } });
  });

  it("the app's own save coming back from the watch raises nothing", async () => {
    await startEditing();
    typeAtEnd("two\n");
    let finish!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => (finish = r)));
    press("s", { metaKey: true });
    Object.assign(disk, { text: "one\ntwo\n", cksum: 10, mtime: 2 });
    publish([{ path: "a.txt", isDir: false, removed: false }]);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "files_read").length).toBe(2));
    await act(async () => finish({ size: 8, mtime: 2, cksum: 10 }));
    expect(screen.queryByText("File changed on disk")).toBeNull();
    expect(useDrafts.getState().drafts[key]).toMatchObject({ dirty: false, conflict: null });
  });

  it("a deleted file offers Save again and Close", async () => {
    await startEditing();
    typeAtEnd("mine");
    publish([{ path: "a.txt", isDir: false, removed: true }]);
    expect(await screen.findByText("File was deleted")).toBeTruthy();
    expect(screen.queryByText("File removed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save again" }));
    await waitFor(() => expect(writes()[0][1]).toMatchObject({ expected: null }));
  });
```

The `publish` helper's key must equal `filesKey(ws, "/r")`. Prefer importing `filesKey` from `./store` and calling `useFilesBus.getState().publish(filesKey(ws, "/r"), changes)` over slicing the item key. The slice above is only a fallback.

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm vitest run src/files/FileViewer.edit.test.tsx`
Expected: the new cases FAIL.

- [ ] **Step 3: Implement the behaviour listed in Interfaces**

`load` reads `useDrafts.getState()` at resolve time, not a captured value, so it sees `saving` and `dirty` as they are when the read lands.

- [ ] **Step 4: Run the viewer tests**

Run: `pnpm vitest run src/files/ && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/files/FileViewer.tsx src/files/FileViewer.edit.test.tsx src/styles.css
git commit -m "feat(files): a changed or deleted file never replaces a dirty Draft; Reload or Overwrite"
```

---

### Task 10: Guard closing items, the window and the app

**Files:**
- Modify: `src/main/OpenStrip.tsx` (close, Close Others, Close to the Right, Close All, middle click → `closeItemsGuarded`)
- Modify: `src/App.tsx` (⌘W → `closeItemsGuarded`; window close and quit listeners)
- Modify: `src-tauri/src/lib.rs` (`app_menu` replaces the predefined Quit; `on_menu_event`; register `app_quit`)
- Modify: `src-tauri/src/commands.rs` (new `app_quit`)
- Modify: `src-tauri/capabilities/default.json` (add `"core:window:allow-destroy"`)
- Modify: `src/lib/ipc.ts` (`appQuit`, `onQuitRequested`)
- Test: `src/main/OpenStrip.test.tsx` (add a case; create the file if absent, following `src/agents/AgentList.test.tsx`'s setup)

**Interfaces:**
- Consumes: `closeItemsGuarded`, `settleDrafts` (Task 7); `useDrafts` (Task 4).
- Produces:
  ```rust
  #[tauri::command] pub fn app_quit(app: tauri::AppHandle) { app.exit(0) }
  // menu: the App submenu's predefined "Quit …" item is replaced, at the same index, by
  // MenuItem::with_id(app, "quit", "Quit herdr-app", true, Some("CmdOrCtrl+Q"));
  // .on_menu_event(|app, e| if e.id() == "quit" { let _ = app.emit("app://quit-requested", ()); })
  ```
  ```ts
  export const appQuit = () => invoke<void>("app_quit");
  export const onQuitRequested = (fn: () => void) => listen("app://quit-requested", fn); // returns Promise<UnlistenFn>
  ```
  In `App.tsx`, one effect does two things. It registers `getCurrentWindow().onCloseRequested(async (e) => { e.preventDefault(); if (await settleDrafts(Object.keys(useDrafts.getState().drafts))) await getCurrentWindow().destroy(); })`. It also registers `onQuitRequested(async () => { if (await settleDrafts(allKeys)) await appQuit(); })`. Both unlisten on cleanup.

- [ ] **Step 1: Write the failing test** (OpenStrip)

```tsx
it("asks before closing a file with an unsaved draft", async () => {
  useApp.getState().openFile(ws, "/r", "a.txt", { pin: true });
  const fk = filesKey(ws, "/r");
  useDrafts.getState().open({ fk, machineId: "local", root: "/r", rel: "a.txt" }, { text: "t", size: 1, mtime: 1, cksum: 1 });
  const s = useDrafts.getState().drafts[draftKey(fk, "a.txt")].state;
  useDrafts.getState().update(draftKey(fk, "a.txt"), s.update({ changes: { from: 0, insert: "!" } }).state);
  render(<><OpenStrip /><UnsavedDialog /></>);
  fireEvent.click(screen.getByRole("button", { name: "Close a.txt" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(useApp.getState().openItems.items).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Close a.txt" }));
  fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
  await waitFor(() => expect(useApp.getState().openItems.items).toHaveLength(0));
});
```

`ws` is `{ machine_id: "local", session: "default", workspace_id: "w1" }`. OpenStrip shows a file's tab even when `machines` is empty. If it doesn't, seed `useApp`'s `machines` as the existing OpenStrip/AgentList tests do.

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run src/main/OpenStrip.test.tsx`
Expected: FAIL, the item closes without a dialog.

- [ ] **Step 3: Implement**

Swap every `closeItems(...)` call in `OpenStrip.tsx` and the ⌘W branch in `App.tsx` for `void closeItemsGuarded(...)`. Leave `filesMoved`'s internal close alone (Task 11 handles deletions). Add the Rust menu item, the command, the capability and the listeners.

- [ ] **Step 4: Run tests and the Rust build**

Run: `pnpm test && pnpm typecheck && cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/OpenStrip.tsx src/main/OpenStrip.test.tsx src/App.tsx src/lib/ipc.ts src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/capabilities/default.json
git commit -m "feat(files): closing a tab, the window or the app asks about unsaved Drafts"
```

---

### Task 11: Rename and Delete follow Drafts; ● on the Open strip

**Files:**
- Modify: `src/store/app.ts` (`filesMoved`: `useDrafts.getState().moveUnder(fk, from, to)` when renamed, `dropUnder(fk, from)` when deleted)
- Modify: `src/files/FileTree.tsx` (Delete confirm message)
- Modify: `src/main/OpenStrip.tsx` (dirty marker)
- Modify: `src/styles.css` (`.files-tab-item.dirty .files-tab-close` shows a dot until hover)
- Test: `src/store/app.test.ts` or the existing test that covers `filesMoved` (find it with `grep -rln filesMoved src --include=*.test.*`), `src/files/FileTree.test.tsx`, `src/main/OpenStrip.test.tsx`

**Interfaces:**
- Consumes: `useDrafts`, `dirtyUnder`, `isDirty` (Task 4).
- Produces: behaviour only.
  - `filesMoved(ws, root, from, to)` moves or drops Drafts under `from` in `filesKey(ws, root)`.
  - FileTree's Delete confirm appends ` Unsaved changes will be lost.` to its message when `dirtyUnder(filesKey, rel).length > 0` (`filesKey` is FileTree's prop of that name).
  - OpenStrip adds class `dirty` to a file item's `files-tab-item` when `isDirty(key)`, subscribed through `useDrafts((s) => …)`. The close button's `aria-label` becomes `Close <label> (unsaved)`.

- [ ] **Step 1: Write the failing tests**

In the `filesMoved` test file:

```ts
it("moves Drafts with a renamed folder and drops them with a deleted one", () => {
  const fk = filesKey(ws, "/r");
  useDrafts.getState().open({ fk, machineId: "local", root: "/r", rel: "src/a.txt" }, { text: "t", size: 1, mtime: 1, cksum: 1 });
  useApp.getState().filesMoved(ws, "/r", "src", "lib");
  expect(Object.keys(useDrafts.getState().drafts)).toEqual([draftKey(fk, "lib/a.txt")]);
  expect(useDrafts.getState().drafts[draftKey(fk, "lib/a.txt")].rel).toBe("lib/a.txt");
  useApp.getState().filesMoved(ws, "/r", "lib", null);
  expect(useDrafts.getState().drafts).toEqual({});
});
```

In `FileTree.test.tsx`, following how its existing Delete tests open the context menu:

```tsx
it("warns in the Delete confirm when a file under it has unsaved changes", async () => {
  // render the tree as the existing Delete test does, with filesKey FK and a file "a.txt"
  useDrafts.getState().open({ fk: FK, machineId: "local", root: ROOT, rel: "a.txt" }, { text: "t", size: 1, mtime: 1, cksum: 1 });
  const s = useDrafts.getState().drafts[draftKey(FK, "a.txt")].state;
  useDrafts.getState().update(draftKey(FK, "a.txt"), s.update({ changes: { from: 0, insert: "!" } }).state);
  // open the context menu on a.txt and choose Delete…, as the existing test does
  expect(await screen.findByText('Delete "a.txt"? This cannot be undone. Unsaved changes will be lost.')).toBeTruthy();
});
```

Replace `FK`, `ROOT` and the two comment lines with that file's own fixtures and steps. The assertion string is fixed.

In `OpenStrip.test.tsx`:

```tsx
it("marks a file with an unsaved draft", () => {
  useApp.getState().openFile(ws, "/r", "a.txt", { pin: true });
  const fk = filesKey(ws, "/r");
  useDrafts.getState().open({ fk, machineId: "local", root: "/r", rel: "a.txt" }, { text: "t", size: 1, mtime: 1, cksum: 1 });
  render(<OpenStrip />);
  expect(screen.getByRole("button", { name: "Close a.txt" })).toBeTruthy();
  const s = useDrafts.getState().drafts[draftKey(fk, "a.txt")].state;
  act(() => useDrafts.getState().update(draftKey(fk, "a.txt"), s.update({ changes: { from: 0, insert: "!" } }).state));
  expect(screen.getByRole("button", { name: "Close a.txt (unsaved)" })).toBeTruthy();
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm vitest run src/store src/files/FileTree.test.tsx src/main/OpenStrip.test.tsx`
Expected: the three new cases FAIL.

- [ ] **Step 3: Implement the behaviour listed in Interfaces**

- [ ] **Step 4: Run all tests**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/store/app.ts src/files/FileTree.tsx src/main/OpenStrip.tsx src/styles.css src/store src/files/FileTree.test.tsx src/main/OpenStrip.test.tsx
git commit -m "feat(files): Drafts follow Rename and Delete; unsaved tabs show a dot"
```

---

### Task 12: Real WKWebView check and docs

**Files:**
- Create: `tmp/edit-probe/` (ignored; copy `tmp/csp-probe/`'s `csp-probe.swift`, `bootstrap.ts`, `index.html`, `vite.config.ts`, `run.sh` and adapt)
- Modify: `README.md` (Files section: one paragraph on Edit mode and its shortcuts)
- Modify: `docs/superpowers/specs/2026-10-08-files-edit-design.md` (`Status: implemented`)

**Interfaces:**
- Consumes: `FileEditor`, `useDrafts`, `languageFor`.

- [ ] **Step 1: Build the probe app**

`tmp/edit-probe/probe-app.tsx` imports `../../src/fonts/fonts.css` and `../../src/styles.css`. It opens a Draft for `demo.ts` (a few lines of TypeScript) through `useDrafts`, renders `<FileEditor draftKey=…/>`, and waits for `languageFor("demo.ts")` plus one animation frame. Then it posts, through the probe's `__post` like `tmp/csp-probe/probe-app.tsx`, these values:
- `cm-mounted` `!!document.querySelector(".cm-editor .cm-content")`
- `lang-loaded` `document.querySelectorAll(".cm-content [class*='tok-'], .cm-content span[class^='ͼ']").length > 0`
- `font` `getComputedStyle(document.querySelector(".cm-content")!).fontFamily`
- `violations` `JSON.stringify(__violations)`

Build with `npx vite build --config tmp/edit-probe/vite.config.ts`, then run `tmp/edit-probe/run.sh` (production CSP from `src-tauri/tauri.conf.json`, as `csp-probe/run.sh` reads it).

- [ ] **Step 2: Check the output**

Expected in `run-B.out`: `cm-mounted true`, `lang-loaded true`, `font` starting with `"JetBrains Mono"`, `violations []`. If a CSP violation names a CodeMirror inline `<style>`, the existing `style-src 'unsafe-inline'` should already allow it. Report it rather than loosening the CSP.

- [ ] **Step 3: Docs**

README Files section: "Press **Edit** (⌘⇧E) on a text file to change it. ⌘S saves, Esc or **Done** leaves. If an Agent changed the file since you opened it, Save stops and offers **Reload** or **Overwrite**." Spec status line → `Status: implemented`.

- [ ] **Step 4: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm build && cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: everything passes, and the build has no new warnings beyond the existing chunk-size notice.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-10-08-files-edit-design.md
git commit -m "docs: Edit mode in the README; file editing spec implemented"
```
