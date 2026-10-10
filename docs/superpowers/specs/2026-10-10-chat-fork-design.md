# Chat fork: a new Agent from before a user message

Date: 2026-10-10
Status: draft

## Purpose

In the Chat lens, the user wants to try a different turn from an earlier point of the
conversation without losing the current one. Each user message gets a **Fork** button: it
starts a new Agent in a new Tab whose Transcript is the original cut just before that message,
and puts the message's text in the new Agent's Composer to edit and send. The original Agent is
not touched.

## Scope

In:

- Claude Code and pi Agents, on the local Machine and on remote ones.
- Forking at any user message the Chat lens shows with an entry id.

Out:

- Codex and other agents.
- Carrying the message's images or skill chips into the new Composer (text only).
- Forking the whole conversation at its latest point (pi `/clone`, `claude --fork-session`).
- Removing a fork's Transcript file when the Tab or Agent fails to start (it is a valid session
  the user can resume by hand).

## Why the app writes the Transcript

- `claude --resume-session-at <uuid>` would cut a resume at a message, but Claude ignores it
  outside print mode, and herdr runs Claude interactively.
- `pi --fork <file>` copies a whole session; pi's `/fork` picks the message in a TUI menu the
  Chat lens cannot drive (the same reason `/tree` is left out of the completions).
- Driving Claude's rewind menu with key presses is as fragile.

So the app writes a cut copy of the Transcript as a new session next to the original and starts
the Agent on it: `claude --resume <id>` or `pi --session <path>`. herdr's `agent.start` takes
`args`.

Prompt cache: the new Agent sends the same messages the original sent, unchanged, so a fork
made while the cache is alive can read it. A new process may build a different system prompt
(git status, date, tools), which costs the cache from that point; this holds for any way of
forking, including Claude's own.

## Design

### 1. Entry ids on user items (backend)

`ChatItem::User` gains `id: Option<String>`, serialized only when present: the line's `uuid`
for Claude (`claude.rs` already reads it for images), the entry's `id` for pi (`pi.rs` reads it
for the tree). The TS `ChatItem` type follows.

### 2. Cutting a Transcript (backend, `transcript/fork.rs`)

Pure functions, one per agent, over the Transcript's text:

```rust
pub struct Cut { pub id: String, pub file_name: String, pub text: String, pub cwd: Option<String> }
/// None: the message has no conversation before it (no file is written).
pub fn cut_claude(text: &str, entry_id: &str, new_id: &str) -> AppResult<Option<Cut>>;
pub fn cut_pi(text: &str, entry_id: &str, new_id: &str, now: &str) -> AppResult<Option<Cut>>;
```

- **By parent chain, not by file position.** Both formats are trees in an append-only file:
  rewinds (Claude) and `/fork`/`/tree` (pi) leave abandoned branches in it. Starting at the
  entry's parent (`parentUuid` / `parentId`), walk to the root and keep exactly those lines,
  in file order. Claude's chain ends at a `compact_boundary` (its `parentUuid` is null); Claude
  itself resumes from there, so nothing behind it is needed.
- Lines outside the chain are dropped, including Claude lines without a `uuid` (`summary`).
  pi's `session` header line is always kept.
- **No conversation before it** (the chain holds no Claude `user`/`assistant` line, or no pi
  `message` entry): `Ok(None)`.
- `entry_id` not found: `not_found` error. A parent id that points nowhere ends the walk.
- **Identity.** Claude: every kept line's `sessionId` becomes `new_id`; file `<new_id>.jsonl`.
  pi: the header's `id` becomes `new_id` and its `timestamp` `now`; file
  `<now with : and . as ->_<new_id>.jsonl`, like pi's own names. Lines are re-serialized only
  where a field changes; the others are copied byte for byte.
- **cwd**: the `cwd` of the last kept Claude line, or of pi's header. Not the Pane's cwd, which
  can differ from where the Agent started; Claude finds `--resume <id>` only in the project dir
  of the cwd it runs in.

### 3. `chat_fork` command

```rust
#[tauri::command]
pub async fn chat_fork(mgr, machine_id: String, agent: String, path: String, entry_id: String)
    -> Result<Forked, AppError>;
pub struct Forked { pub id: Option<String>, pub path: Option<String>, pub cwd: Option<String> }
```

1. Read `path` on the Machine through its Transport (`cat`).
2. Cut it with a new UUID (`cut_claude` / `cut_pi`; another agent is `invalid`).
3. `None`: return `{ id: None, path: None, cwd: None }`.
4. Write the text into the original file's directory the way `save_image_in` writes:
   `sh -c 'umask 077; set -C; cat > "$1/$2"'` with the text on stdin. `set -C` makes a name
   collision fail instead of overwriting a real session.
5. Return the new id, the new path and the cwd.

### 4. The Fork button (frontend)

`ChatItemView` shows a Fork button beside `CopyButton` on a user message (same hover reveal),
only when:

- the Pane's Agent is `claude` or `pi`,
- the item has an `id`,
- the located Transcript is neither `pending` nor `ambiguous` (a guessed file could fork
  another pane's conversation).

A user message with only images has no button, as it has no copy button.

### 5. `forkChat` (frontend, `src/chat/forkChat.ts`)

1. `chat_fork` for the Pane's Machine, agent, Transcript path and the item's id.
2. `tab.create` in the Pane's Workspace, at `cwd` from the fork (else the Pane's cwd), labelled
   with the agent.
3. `writeDraft(paneKey(newPane), item.text)` right after the Tab exists, so the Composer finds it
   when it mounts.
4. Hold the Chat lens on the new Pane (a lens override), whatever `newAgentOnTerminal()` says:
   the filled Composer is the point. Select the new Pane.
5. `launchAgent` with `args`: `["--resume", id]` for Claude, `["--session", path]` for pi; none
   when the fork has no id.

`openAgentTab`, `launchAgent` and `startAgent` take optional `args` (passed to `agent.start`);
their callers today are unchanged.

Any failure shows `showToast("Could not fork: …")`.

## Testing

Rust (`transcript/fork.rs`):

- Claude and pi cuts over `tests/fixtures/{claude,pi}.jsonl` and built lines: the kept lines
  are the parent chain in file order; an abandoned branch between them is dropped.
- `sessionId` rewritten on every kept Claude line; pi header `id` and `timestamp` rewritten;
  untouched lines byte-identical.
- Forking at the first message gives `None`; an unknown entry id is `not_found`.
- `chat_fork`'s write through `LocalTransport` in a temp dir refuses an existing file.

Frontend (vitest):

- The Fork button shows only for claude/pi, an item with an id, and a Transcript neither
  pending nor ambiguous.
- `forkChat` calls `chat_fork`, `tab.create` with the fork's cwd, writes the draft, then
  `agent.start` with the right `args`; no `args` without an id; a failure toasts.

Headless probe (no herdr-app launch), in `tmp/`:

- Cut a real Claude and a real pi Transcript, run `claude --resume <id>` and
  `pi --session <path>` from the CLI, send a short message: the history ends before the chosen
  message, and the first reply's `usage.cache_read_input_tokens` shows whether the cache was
  read.
