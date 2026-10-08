# File editing

Date: 2026-10-08
Status: implemented

## Purpose

Quick edits without leaving the app: fix a config value, tweak a README, correct a line an
Agent got wrong. It works the same on the local Machine and on ssh Machines. It is not an
IDE. Agents write to the same folders at the same time, so a save must never silently
overwrite a file that changed on disk after it was opened.

## Scope

In:

- An **Edit mode** in the File viewer, entered with an **Edit** button (⌘⇧E; ⌘E already
  focuses the tree), backed by
  CodeMirror 6: line numbers, undo/redo, search and replace, bracket matching, Tab indent,
  syntax highlighting by file extension.
- **Save** (⌘S) with a check that the file on disk is still the version the edit started
  from (size, mtime, POSIX `cksum`), written atomically (temp file, then `mv`).
- A conflict banner offering **Reload** or **Overwrite** when the file changed, or **Save
  again** or **Close** when it was removed.
- **Drafts** that survive switching Open items, a ● on the Open strip tab of an unsaved
  file, and Save / Discard / Cancel prompts before closing items or the window loses one.

Out:

- Multi-cursor, autocomplete, folding, minimap, LSP, format on save.
- Creating files through the editor (New File already exists) and editing images, binary
  files, files cut at 2 MB, or files that are not valid UTF-8.
- Persisting Drafts across app restarts.
- Auto-save.

## Backend

### Read (`src-tauri/src/files/read.rs`)

`FileContent` gains:

- `cksum: Option<u32>`: POSIX `cksum` CRC of the bytes read, computed in Rust (no gap
  between reading and hashing). `Some` only for untruncated text.
- `editable: bool`: true only for text that is not truncated **and** decodes as valid UTF-8.
  Today the text is decoded with `from_utf8_lossy`, so saving a file with invalid bytes would
  silently replace them with U+FFFD.

The CRC lives in a small `cksum.rs` (the POSIX polynomial `0x04C11DB7`, with the length
appended), so the value matches the `cksum` binary on both GNU and BSD.

### Write (`src-tauri/src/files/edit.rs`, command `files_write`)

```
files_write(machine_id, root, rel, text, expected: { size, mtime, cksum } | null)
  -> { size, mtime, cksum }
```

The text goes through stdin with `exec_input`, the same path for the local Machine and
ssh Machines. Rust checks `check_rel(rel)` and refuses text over `MAX_TEXT_BYTES` with
`invalid`. The shell script, run in `root`:

1. Resolves `./rel`. If it is a symlink, it writes to the link's target (`readlink`, followed
   until it is not a link) so the link stays.
2. With `expected`: the file must exist as a regular file (else exit 3 → `not_found`); its
   `stat` size and mtime (GNU `stat -c`, BSD `stat -f` as the fallback) and its `cksum` must
   equal `expected` (else exit 6 → `conflict`). Without `expected` (Overwrite, or Save again
   after a removal) the file may be missing; its folder must exist.
3. Writes stdin to `.<name>.herdr-$$.tmp` in the same folder.
4. Copies the original's mode to the temp file when the original exists (mode from `stat`,
   applied with `chmod`); a new file gets the default umask mode.
5. `mv -f` the temp file over the target: atomic, so an Agent never reads half a file.
   A `trap` removes the temp file when any step fails.
6. Prints the new `stat`. Rust computes the new `cksum` from `text` itself.

Accepted gaps, recorded in ADR-0007:

- An Agent writing between the check (step 2) and the `mv` (step 5), a few milliseconds,
  is overwritten.
- `mv` creates a new inode: a process holding the old file open keeps the old content. Owner
  and group are those of the user the app runs as.

`files_write` runs with the default 30 s exec timeout.

## Frontend

### Drafts (`src/files/drafts.ts`)

A zustand store keyed by `itemKey`:

```ts
interface Draft {
  state: EditorState;                 // CodeMirror state, undo history included
  base: { text: string; size: number; mtime: number; cksum: number }; // the disk version it starts from
  dirty: boolean;                     // !state.doc.eq(base text); undoing back to base clears it
  conflict: "changed" | "removed" | null;
  saving: boolean;
}
```

Actions: `open(key, content)`, `update(key, state)`, `rebase(key, content)` (a newer disk
version while not dirty), `saved(key, version, text)`, `setConflict`, `move(from, to)`
(rename), `drop(key)`. A Draft exists from the moment Edit is pressed.

### Editor (`src/files/FileEditor.tsx`)

Wraps an `EditorView` created from the Draft's `state` and writes every transaction's state
back to the Draft. Extensions: `lineNumbers`, `history`, `search` (its panel styled like the
FindBar, replace included), `keymap` with `indentWithTab`, `bracketMatching`, and the
language for the extension through `@codemirror/language-data` (lazy dynamic imports, served
from `'self'`, so the current CSP holds). The theme uses the existing CSS variables
(JetBrains Mono, `--files-line-h`, colours).

A file whose text contains `\r\n` gets `EditorState.lineSeparator.of("\r\n")`, so saving does
not turn it into LF. The trailing newline is kept as it is. A file whose text does not come
back byte for byte from the editor (mixed LF and CRLF, or a lone `\r`) is not editable: the
Edit button is replaced by a disabled one titled "Mixed line endings".

### Save (`src/files/save.ts`)

`saveDraft(key, { force })` calls `files_write` with `expected = base` (`null` when forced):

- ok → `saved`: `base` becomes the saved text and version, `dirty = false`, `conflict = null`
- `conflict` → `conflict = "changed"`
- `not_found` → `conflict = "removed"`
- other errors → toast "Cannot save <name>: <message>", the Draft is kept

While `conflict` is set, ⌘S does not write. It flashes the banner instead.

### File viewer (`src/files/FileViewer.tsx`)

- **Edit** in the breadcrumbs when the file can be edited (⌘⇧E toggles Edit / Done).
- With a Draft: **Save** (⌘S, disabled when not dirty) and **Done** (Esc) replace the
  Render/Source switch. Outline and the viewer's FindBar are hidden, and `FileEditor` takes
  the view.
- Done with nothing unsaved drops the Draft and returns to the previous mode. With unsaved
  changes it asks "Save changes to <name>?" with **Save / Discard / Cancel**.

### Files watch and ⌘R

When the bus reports the open file changed:

- No Draft, or a Draft that is not dirty: read again as today. A clean Draft is rebased onto
  the new content, so Edit with no typing still follows an Agent's writes.
- A dirty Draft: never replaced. The file is read and its `cksum` compared with `base`.
  If it differs → `conflict = "changed"`. If it is gone → `conflict = "removed"`. A `touch`
  alone raises nothing. The app's own save comes back from the watch with the new `cksum`
  already in `base`, so it is ignored.

### Conflict banner

- `changed`: "File changed on disk" with **Reload** (drop the Draft's edits, take the disk
  version) and **Overwrite** (`saveDraft(key, { force: true })`).
- `removed`: "File was deleted" with **Save again** (forced write, which recreates it) and
  **Close**.

### Guards against losing a Draft

- `closeItems` (one, Others, to the Right, All, and ⌘W): if any item being closed has a
  dirty Draft, a dialog lists those files with **Save All / Discard / Cancel**. A closed
  item's Draft is dropped.
- Window close: Tauri `onCloseRequested`. ⌘Q: the menu's predefined Quit is replaced by a
  custom "Quit <app name>" item (⌘Q; e.g. "Quit Herdr") that asks the page first, then exits through an
  `app_quit` command. With dirty Drafts, the same dialog asks first. Quit from the Dock
  bypasses the menu and is not guarded.
- Switching Workspace or Session: nothing to guard. Open items span all of them and Drafts
  live in the store.
- Rename in the tree moves the Draft to the new key, next to the existing follow code
  (`src/store/app.ts`). Delete of a file with a dirty Draft adds "Unsaved changes will be
  lost" to the Delete confirm, then drops the Draft.
- An ssh Machine going offline keeps the Draft. Save fails with a toast and can be retried.

### Open strip

A file item with a dirty Draft shows ● in place of × until hovered.

## Testing

TDD throughout.

- Rust (`edit.rs`, `read.rs`, `cksum.rs`, on `tempfile` with the local transport): write
  succeeds and keeps the mode; a mismatched `expected` → `conflict`, file untouched; forced
  write succeeds, also on a removed file; a symlink stays a symlink; CRLF bytes come back
  unchanged; text over 2 MB → `invalid`; no temp file is left after a failure; `editable` is
  false for invalid UTF-8 and for truncated text; the Rust `cksum` equals the `cksum`
  binary's output.
- Vitest: `drafts.ts` (dirty, undo to base, rebase, move, drop); `save.ts` with mocked ipc
  (ok, conflict, not_found, other); `FileViewer` flow (Edit, type, ⌘S, Done, Save/Discard
  prompt, conflict banner, watch never replaces a dirty Draft); the `closeItems` guard; ●
  on the Open strip.
- Real WKWebView: a headless probe (as `tmp/csp-probe`) confirms CodeMirror mounts under
  the production CSP, a language loads lazily, and the editor font renders. The app itself
  is not launched for this.

## Documentation

- ADR-0007 supersedes ADR-0006's "Editing a file's content stays out".
- `CONTEXT.md`: the Files panel definition stops saying it never edits a file's content;
  new terms **Edit mode** and **Draft**.
