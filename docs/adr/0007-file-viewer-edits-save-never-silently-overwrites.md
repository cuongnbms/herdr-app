# 0007: The File viewer edits a file's content; Save never silently overwrites

> Status: Accepted · Date: 2026-10-08

## Context

[0006](./0006-files-tree-creates-renames-deletes-delete-is-permanent.md) let the tree create,
rename and delete items, but said "Editing a file's content stays out". Users now want quick
edits in the app (a config value, a README line, a line an Agent got wrong) on the local
Machine and on ssh Machines. A save replaces a file's content, and Agents write to the same
files at the same time. Losing an Agent's write without anyone noticing is the failure 0005
and 0006 were written to prevent.

Source: [design spec](../superpowers/specs/2026-10-08-files-edit-design.md).

## Decision

- The File viewer gains an **Edit mode** (CodeMirror 6). It is offered only for untruncated,
  valid UTF-8 text.
- **Save checks before it writes.** The edit remembers the version it started from (size,
  mtime, POSIX `cksum`). Save writes only if the file on disk still matches. Otherwise it
  writes nothing and shows **Reload** / **Overwrite**. Overwrite is the only way to replace
  a file that changed, and it is always a deliberate click.
- **The write is atomic:** a temp file in the same folder, the original's mode copied, then
  `mv -f` over the file (through a symlink to its target). An Agent never reads half a file.
- A dirty Draft is never replaced by the Files watch. A change on disk raises the conflict
  banner instead.
- 0006's rules for New, Rename and Delete, and 0005's for Upload and Download, are unchanged.

`cksum` joins size and mtime because mtime has one-second resolution. An Agent rewriting a
file within the second it was opened, at the same size, would otherwise pass the check.

## Consequences

- An Agent writing in the few milliseconds between the check and the `mv` is overwritten.
  Closing that gap needs locking that Agents don't take part in.
- `mv` gives the file a new inode, and owner and group become the app user's. A process
  holding the old file open keeps the old content. This is how most editors save.
- Each save reads the file once more on the Machine to compute its `cksum` (at most 2 MB).
- CodeMirror's highlighting can differ slightly in colour from the viewer's (lowlight).

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| Save always overwrites | Silently loses an Agent's write made while the file was open. |
| Lock editing while an Agent in the Workspace is `working` | The Agent may not touch that file at all, and its status says nothing about which files it writes. |
| Check size and mtime only | Same-second, same-size rewrites pass. |
| Write in place (`cat > file`) | An Agent can read a half-written file, and a failed write leaves it truncated. |
| Monaco | Several MB, needs web workers that `script-src 'self'` blocks. |
| A transparent textarea over the highlighted view | No virtualization (slow on long files), caret and highlight drift, poor undo. |
