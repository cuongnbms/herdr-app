# Chat side questions (btw)

Date: 2026-10-10
Status: draft

## Purpose

While a Claude Code Agent works, the user wants to ask a quick question about the conversation
(why it chose X, what a file does) without adding it to the Agent's Transcript. Claude Code's
own `/btw` does this inside its TUI, but its answer is drawn as an overlay the Chat lens cannot
show. So the app asks a **Side question** itself: a separate `claude -p` process resumes a fork
of the Transcript, answers, and streams the answer into a card above the Composer. The Agent and
its Transcript are never written to.

## Scope

In:

- Claude Code Agents, on the local Machine and on remote ones.
- One question, then optional follow-ups in the same thread ("Hỏi tiếp"); closing the card
  deletes the thread's fork.
- Asking while the Agent is idle, working or blocked.

Out:

- pi and other agents.
- Images, `/` and `@` completions in btw mode.
- Opening a Side question thread as a new Agent.
- Restricting tools: the process runs with the Agent's default tools and permission settings
  (print mode denies anything that would prompt). The user steers tool use in the question. A
  tool the answer used is noted in the card.
- Deleting forks left behind when the app quits with a card open (they are valid Transcripts
  the user can resume by hand, as with Fork).

## Prompt cache

The cache matches the request prefix exactly: tools, then system prompt, then messages, for one
model. The process keeps the Agent's tools and passes the Transcript's model, so its prefix is
the Agent's own conversation and a question asked while the cache is alive should read it.
Passing `--tools ""` would change the first part of the prefix and miss the whole cache, so the
design does not. Whether print mode builds the same system prompt as the TUI is checked by the
probe (Testing), through `usage.cache_read_input_tokens`.

## Design

### 1. Running a question (backend, `src-tauri/src/transcript/btw.rs`)

The first question of a thread:

```
claude -p --resume <transcript id> --fork-session --model <model>
       --output-format stream-json --include-partial-messages --verbose
```

A follow-up: the same, with `--resume <fork id>` and no `--fork-session`; it appends to the
fork's own file.

- `<transcript id>` is the Transcript file's stem; `<model>` the `message.model` of its last
  assistant line (none found: no `--model`).
- Runs in the `cwd` of the Transcript's last line (as `chat_fork` finds it), since Claude finds
  `--resume <id>` only in the project dir of the cwd it runs in. None: `not_found`.
- The question goes on stdin.
- Run through a login shell, `$SHELL -lc 'cd "$1" && exec claude "$@"'`, so `claude` is found on
  a remote Machine whose non-login PATH lacks it (`~/.local/bin`). The argv is passed as
  positional arguments, never spliced into the script.
- Remote: wrapped with a tty (`Transport::wrap(argv, true)`), so dropping the ssh client hangs
  up the remote process on cancel.

Pure parts, tested without a process:

```rust
pub fn btw_argv(transcript_id: &str, fork_id: Option<&str>, model: Option<&str>, cwd: &str) -> Vec<String>;
pub fn last_model(text: &str) -> Option<String>;
/// One stream-json line to zero or more events.
pub fn parse_line(line: &str) -> Vec<BtwEvent>;
```

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BtwEvent {
    Delta { text: String },            // stream_event content_block_delta / text_delta
    Tool { name: String },             // assistant tool_use block
    Done { fork_id: String, cache_read: u64, input: u64 }, // result line
    Error { message: String },         // result with is_error, or a failed process
}
```

`fork_id` is the `session_id` of the `result` line (with `--fork-session`, the new id).

### 2. Streaming a process (`transport/mod.rs`)

`exec` returns all output at the end. A new helper reads stdout line by line:

```rust
pub async fn spawn_lines(t: &dyn Transport, argv: &[String], input: Option<&[u8]>, tty: bool)
    -> AppResult<LineChild>; // next_line().await, kill().await, stderr tail on exit
```

### 3. Commands

```rust
#[tauri::command]
pub async fn chat_btw_ask(mgr, machine_id: String, path: String, question: String,
    fork_id: Option<String>, ask_id: String, events: Channel<BtwEvent>) -> Result<(), AppError>;
#[tauri::command]
pub async fn chat_btw_cancel(mgr, ask_id: String) -> Result<(), AppError>;
#[tauri::command]
pub async fn chat_btw_discard(mgr, machine_id: String, path: String, fork_id: String) -> Result<(), AppError>;
```

- `ask`: reads the Transcript (`cat`), finds cwd, model and id, spawns, forwards events until
  the process exits. A non-zero exit without a `result` line sends `Error` with the stderr tail.
  Running children are kept by `ask_id` for `cancel`.
- `cancel`: kills the child; `ask` then ends without `Done`.
- `discard`: removes `<dir of path>/<fork_id>.jsonl` only when `fork_id` is a UUID and is not
  the Transcript's own id. A missing file is not an error.

### 4. btw mode in the Composer (frontend)

- A **btw** button in `composer-bar`, and **Cmd+B** while the Composer has focus, toggle btw
  mode. Shown only when `canFork(agent, located)` holds and the agent is `claude`.
- In btw mode the box gets a distinct border and the placeholder
  "Hỏi bên lề (không vào Transcript)…"; Enter calls `askSide` instead of typing into the Pane;
  image paste and completions are off. Esc or Cmd+B leaves btw mode.
- btw mode keeps its own Draft (`btw:` + paneKey), so a half-written prompt survives a switch.
- Sending keeps btw mode on.

### 5. The card (`src/chat/BtwCard.tsx`) and its state (`src/chat/btw.ts`)

Between `PromptPanel` and `Composer`. Per paneKey, a zustand store holds
`{ forkId?: string, turns: { q, a, tools, running, error? }[], askId?: string }`, so a Tab switch
keeps the card.

- Each turn shows its question and its answer, rendered by `markdown.tsx` as it streams, with a
  line `⚙ <tool>` per tool used. Max height about 40% of the lens, scrolled.
- Buttons: **Dừng** while running (`chat_btw_cancel`), **Hỏi tiếp** (focuses the Composer in btw
  mode), **Đóng** (`chat_btw_discard` when there is a forkId, then clears the card).
- While the card is open, every btw send continues its thread (`forkId`). Sending is disabled
  while a turn runs, so a follow-up always has the fork id of the turn before it.
- Errors show in the turn, not as toasts.
- When the Pane's located Transcript changes, the card is discarded as if closed.

## Testing

Rust:

- `btw_argv`: first question has `--resume <transcript id> --fork-session`; a follow-up has
  `--resume <fork id>` without it; `--model` only when known; the question is not in argv.
- `last_model` over `tests/fixtures/claude.jsonl`.
- `parse_line` over recorded stream-json lines: text deltas, a tool_use, a result (fork id,
  cache tokens), an error result, unrelated lines give nothing.
- `discard` through `LocalTransport` in a temp dir: removes the fork; refuses a non-UUID id and
  the Transcript's own id; a missing file is fine.
- `spawn_lines` through `LocalTransport` with a script that prints lines slowly; `kill` stops it.

Frontend (vitest):

- The btw button shows only for a forkable Claude Transcript; button and Cmd+B toggle the mode.
- Enter in btw mode calls `chat_btw_ask` and never `pane.send_text`; the main Draft is untouched.
- The card shows deltas, a tool line, `Done`, an error; Hỏi tiếp sends with `forkId`; Đóng calls
  `chat_btw_discard`; a changed Transcript discards.

Headless probe (no herdr-app launch), in `tmp/btw-probe/`, before the backend is written:

1. Ask a Side question of a real idle Transcript: the fork file lands next to it, the original
   file's bytes are unchanged, and `cache_read_input_tokens` of the first answer is reported.
2. The same while that Agent is mid-turn (a tool_use without its result at the end). If
   `--resume` fails, the design changes to: cut the Transcript to its last complete point with
   `fork.rs`'s chain walk into a temporary Transcript, and resume that instead.
3. A follow-up with `--resume <fork id>` sees the first question and answer.
