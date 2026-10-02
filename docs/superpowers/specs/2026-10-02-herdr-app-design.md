# herdr-app: Tauri desktop client for herdr — design

> Date: 2026-10-02 · Status: approved design, pending spec review

A macOS desktop app, built with Tauri v2, that rewrites the idea of [herdr-web-ui](https://github.com/devswha/herdr-web-ui) (MIT) as a native client. It shows every herdr **Session** and **Workspace** on the local Mac and on remote **Machines** in a left sidebar, and lets the user view each **Pane** through a **Terminal lens** or a **Chat lens**. Vocabulary is defined in [CONTEXT.md](../../../CONTEXT.md).

## Goals

- Sidebar tree: Machine → Session → Workspace → Tab → Pane, with live Agent status.
- Remote herdr over SSH, with nothing installed on the remote except herdr ([ADR 0001](../../adr/0001-system-ssh-transport.md)).
- Terminal lens: the real herdr terminal, attached through `herdr terminal attach`.
- Chat lens for **Claude Code** and **pi**: read the Agent's Transcript, render it as a conversation, send prompts and keys.
- Basic control: create/close/rename Workspace, Tab, Pane; start/stop a Session; start an Agent.

## Non-goals (v1)

- Linux/Windows builds (macOS only; remote Machines may be Linux or macOS).
- Chat lens for Codex, omp, omo, gjc or other agents.
- Parsing approval prompts into structured cards (v1 shows the live screen plus quick keys instead).
- Image attachments, @-file mentions, held/queued messages in the composer.
- File browser/viewer, push notifications to phones, PWA, self-updater, usage stats.
- Rendering herdr's split layout; the main area shows one Pane at a time.
- Multiple windows viewing the same Terminal.

## Verified facts about herdr 0.9.3 (protocol 22)

These were checked against the running herdr on this Mac and on `devtuf` before writing this spec.

- The socket speaks JSON lines: `{"id", "method", "params"}` → `{"id", "result"}` or an error. 128 methods/events are listed by `herdr api schema --json`; the ones this app uses are named in each section below.
- `events.subscribe` keeps the connection open and streams subscription events. Agent status enum: `idle`, `working`, `blocked`, `done`, `unknown`.
- There is no socket method to attach to a terminal. Attach is the CLI `herdr [--session X] terminal attach [--takeover] <terminal_id>`, which must run inside a PTY with a non-zero size (`terminal reported a zero-sized grid` otherwise).
- Attach is exclusive: a second attach fails with `terminal attach failed: terminal <id> already has an attached client; retry with --takeover`.
- On attach, herdr repaints the whole screen, so a re-attach needs no replay buffer.
- `herdr session list` prints a table: `name status directory socket`. A stopped Session starts headless with `herdr --session <name> server`; its socket answered within ~0.6 s.
- `agent.get` does not always return `agent_session` (absent for this Mac's Claude pane), so Transcript discovery needs a fallback.
- On `devtuf`, `herdr` lives in `~/.local/bin`, which is on the PATH only for interactive shells: `ssh devtuf herdr` and `ssh devtuf $SHELL -lc 'command -v herdr'` both fail.

## 1. Architecture

Tauri v2. The **Rust core owns all I/O** (herdr sockets, SSH, PTYs, Transcript files). The **React + TypeScript + xterm.js** frontend is a pure view.

- Rust → UI terminal bytes and Chat items: `tauri::ipc::Channel` (one per open Pane lens). Events are too slow for bursty terminal output.
- Rust → UI sidebar state: Tauri event `sidebar://update` carrying coalesced diffs, throttled to ~100 ms.
- UI → Rust: `invoke` commands.

Rust modules (`src-tauri/src/`):

| Module | Responsibility |
|---|---|
| `herdr/rpc.rs` | JSON-lines client: request/response with 10 s timeout, and a long-lived subscription stream |
| `herdr/model.rs` | `SessionModel`: Workspaces/Tabs/Panes/Agents built from `session.snapshot`, updated by events |
| `herdr/events.rs` | Typed subscription events and how each one applies to `SessionModel` |
| `transport/{mod,local,ssh}.rs` | `Transport` trait and its Local and Ssh implementations |
| `machines.rs` | Machine registry, persistence, connection state machine, Session discovery |
| `attach.rs` | Attach Manager: one PTY attach per Terminal, flow control, idle detach |
| `transcript/{mod,claude,pi,tail}.rs` | Transcript discovery, parsers, tailing |
| `commands.rs` | Tauri commands exposed to the UI |

Frontend (`src/`): `sidebar/`, `terminal/`, `chat/`, `store/` (Zustand), `App.tsx`. Package manager pnpm, bundler Vite.

## 2. Transport

```rust
trait Transport {
    async fn connect_socket(&self, session: &SessionRef) -> Result<UnixStream>;
    fn spawn_pty(&self, argv: &[String], cols: u16, rows: u16) -> Result<PtyHandle>;
    async fn exec(&self, argv: &[String]) -> Result<Output>;
    fn tail_file(&self, path: &str) -> Result<LineStream>;
    async fn list_files(&self, dir: &str, pattern: &str) -> Result<Vec<FileEntry>>; // name, mtime
}
```

**Local.** Socket paths come from `herdr session list`. PTYs use `portable-pty`. Tails use `notify` (kqueue) plus reading appended bytes.

**Ssh** (system `ssh`, see ADR 0001):

- Control socket: `<appdata>/ssh/<machine-id>.ctl`, master started with `ssh -M -S <ctl> -o ControlPersist=10m -N <target>`. Every other call uses `-S <ctl> -o BatchMode=yes`.
- First authentication, or any time the master is gone and `BatchMode` fails: the master runs inside a PTY shown in a **Connect dialog** (a small xterm), so the user answers host-key, passphrase and OTP prompts directly. Nothing is stored.
- Socket: `ssh -S <ctl> -O forward -L <appdata>/fwd/<machine-id>-<session>.sock:<remote socket> <target>`; stale local socket files are removed before forwarding. RPC code then treats it as a local Unix socket.
- PTY: `ssh -S <ctl> -tt <target> <herdr> --session <name> terminal attach <id>`. Resize reaches the remote through ssh's SIGWINCH forwarding.
- Tail: `ssh -S <ctl> <target> tail -n +1 -F <path>`. File listing: `ssh … find <dir> -maxdepth 1 -name <pattern> -printf …` (Linux) with a `stat`-based fallback for macOS remotes.
- **herdr path discovery** on connect, first hit wins, cached per Machine: (1) `herdr_path` from Machine config; (2) `$SHELL -lc 'command -v herdr'`; (3) `$SHELL -ic 'command -v herdr'`; (4) probe `~/.local/bin/herdr`, `~/.cargo/bin/herdr`, `/opt/homebrew/bin/herdr`, `/usr/local/bin/herdr`.

**Machine registry.** `<appdata>/machines.json`: `{ id, label, ssh_target, herdr_path?, enabled }`. `local` always exists and is not stored. The "Add machine" dialog asks for an SSH target and suggests `Host` entries parsed from `~/.ssh/config` (non-wildcard only).

**Machine states:** `disconnected → authenticating → probing → connected | incompatible | error`.

- Probing runs `herdr --version` and `herdr api schema` (reads `protocol:`). Protocol ≠ 22 → `incompatible`, shown with the remote version, no controls.
- Connected → `herdr session list`, then one RPC connection and one subscription per running Session.
- Disconnect: Machine greys out, keeps its last snapshot, controls disabled, retries with backoff 1 s → 60 s. If `BatchMode` reports an auth failure, retrying stops and a **Reconnect** button reopens the Connect dialog. Other Machines are unaffected.
- Stopped Session: shown dimmed; clicking it asks "Start session?", then `exec` of `herdr --session <name> server` (detached: `nohup … >/dev/null 2>&1 &` on remote), then polls the socket for up to 10 s. Stop uses `server.stop` over the socket.

## 3. Terminal lens

**Attach Manager.** Key: `(machine_id, session, terminal_id)`. One attach = one PTY process running `herdr … terminal attach <id>`. In v1 each attach has exactly one consumer, the Pane's xterm instance.

- Lifecycle: attach when a Pane is shown in the Terminal lens; when the user moves away, keep it **15 s**, then detach (kill the PTY child). Attach is exclusive, so holding it longer would block other clients.
- The frontend caches live xterm instances so switching back does not flash; it disposes one when Rust reports the detach.

**Data path.**

- Output: Rust reads the PTY in chunks of up to 64 KiB and sends them on a `Channel<Vec<u8>>`. The frontend calls `term.write(chunk, cb)` and, in `cb`, invokes `term_ack(bytes)`.
- Backpressure: when unacknowledged bytes exceed **1 MiB**, Rust stops reading the PTY until acks bring it below 512 KiB. The kernel buffer fills and herdr slows down; the UI never drowns.
- Input: `term.onData` → `invoke("term_write")`, coalesced per animation frame; large pastes are chunked to 16 KiB.
- Resize: FitAddon, debounced ~50 ms → `invoke("term_resize", {cols, rows})` → PTY resize.
- Scroll: herdr owns scrollback and enables mouse reporting; wheel events go to herdr. xterm keeps a small local scrollback. **Assumption to verify first in the plan**: wheel scrolling through `terminal attach` scrolls herdr's scrollback.
- Rendering: xterm.js with the WebGL addon and a bundled monospace font. `Cmd+…` shortcuts belong to the app; every other key goes to the terminal.

**Errors and states.**

- Attach held elsewhere (stderr matches `already has an attached client`): banner in the Pane with **Take over**, which re-runs with `--takeover`. The app never takes over on its own.
- `pane.exited` / `pane.closed`: Pane shows "Process exited"; the sidebar updates from the event.
- SSH drops during an attach: Pane shows "Disconnected"; when the Machine reconnects, the visible Pane re-attaches.
- Pane operations from the UI go over the socket: `pane.split`, `pane.close`, `pane.rename`, `tab.create`, `tab.close`, `tab.rename`, `workspace.create` (with `cwd`), `workspace.close`, `workspace.rename`, `agent.start`.

## 4. Sidebar and state

For each running Session (Rust):

1. `session.snapshot` builds the `SessionModel`.
2. A second, long-lived connection runs `events.subscribe` for: `pane.agent_status_changed`, `pane.created`, `pane.closed`, `pane.exited`, `pane.moved`, `pane.updated`, `tab.created`, `tab.closed`, `tab.renamed`, `tab.moved`, `workspace.created`, `workspace.closed`, `workspace.renamed`, `workspace.reordered`, `workspace.updated`.
3. Events apply to the model. An unknown event, a parse failure, or a subscription reconnect triggers a fresh `session.snapshot` instead of patching.
4. Model changes are sent to the UI as coalesced diffs on `sidebar://update`, at most every ~100 ms.

Session lists come from `herdr session list` on connect and on a manual refresh; herdr has no event for Sessions starting or stopping. Only running Sessions get sockets and subscriptions.

Tree:

```
▾ local                                ● 2 working
  ▾ default                             running
    ▾ herdr-app (w5)                    ◑ working
        1 · claude  "Herdr web UI…"     ◑ working
    ▸ api-server (w2)                   ○ idle
  ▸ ai-radar                            stopped
▾ devtuf                                ● connected
  ▸ default                             ⚠ 1 blocked
+ Add machine
```

- Panes are leaves grouped by Tab; the Tab level is hidden when a Workspace has one Tab.
- A parent shows its most urgent descendant status: `blocked` > `working` > `done` > `idle` > `unknown`. `blocked` is highlighted.
- Actions: click a Pane to open it; context menu for rename/close/new tab/split; "New workspace" (cwd picker, optional `claude`/`pi` start); Start/Stop Session.
- Command palette `Cmd+K`: fuzzy search Panes by title, Agent, cwd, across all Machines.
- macOS notification (Tauri notification plugin) when an Agent becomes `blocked` or `done` and its Pane is not the one on screen; clicking it focuses that Pane. Toggle in Settings.

Main area: header with breadcrumb Machine › Session › Workspace › Pane, a **Terminal | Chat** switch, and the Agent status. The default Lens is Chat when the Pane's Agent is `claude` or `pi` and a Transcript is found, Terminal otherwise. The chosen Lens is remembered per Pane (`localStorage` keyed by machine + session + pane).

## 5. Chat lens

**Transcript discovery** for a Pane:

1. `agent.get <pane_id>`. If `agent_session.value` is present, use it as the session id:
   - Claude Code: `~/.claude/projects/<encoded cwd>/<session_id>.jsonl`, where the encoding replaces every non-alphanumeric character of `cwd` with `-`.
   - pi: `$PI_CODING_AGENT_SESSION_DIR` or `~/.pi/agent/sessions`, directory `--<encoded cwd>--`, file whose name contains the id.
2. Fallback: newest `.jsonl` in that directory. If more than one Pane on the same Session runs the same Agent in the same `cwd`, the Chat lens shows a "may be the wrong conversation" notice and a picker of recent Transcripts; the choice is remembered per Pane. Settings suggests `herdr integration install` to make the binding exact.
3. On a remote Machine the same logic runs through `Transport::list_files` and `exec`.

**Parsing (Rust).** `Transport::tail_file` reads the whole file, then follows appended lines. One parser per Agent maps records to a shared model:

```rust
enum ChatItem {
    User { text: String },
    AssistantText { markdown: String },
    Thinking { text: String },
    ToolCall { id: String, name: String, input_summary: String, input: serde_json::Value },
    ToolResult { call_id: String, output: String /* truncated to 16 KiB */, is_error: bool },
    System { text: String },
}
```

- **Claude Code** is a linear log. Records `type: "user" | "assistant"` with `message.content` either a string or blocks `text`, `thinking`, `tool_use`, `tool_result`. Records with `isMeta`, `isSidechain` or `isCompactSummary`, and all other record types, are skipped.
- **pi** is an append-only **tree**: entries link by `id`/`parentId`, and pi's `/tree` moves the leaf back without rewriting the file, so later appends grow a side branch. The conversation to show is the path from the **last entry written** back to the root; parents always precede children, so one forward pass indexes it. Only `type: "message"` entries with `display !== false` are shown; `message.role` is `user` / `assistant` / `toolResult`, content blocks are `text`, `thinking`, `toolCall` (`toolName`/`name`, `toolCallId`/`id`, `arguments`/`input`) and `toolResult`. When an appended entry's parent is not the current leaf, the branch changed: Rust recomputes the path and sends a **reset** to the UI instead of an append. Branches larger than 64 MiB are not loaded; the Chat lens falls back to the Terminal lens.

Parsers are written in Rust, using upstream's TypeScript (`server/conversation.ts`, `server/transcript-records.ts`, `server/pi-tree.ts`) as reference (MIT, credited in `THIRD_PARTY_NOTICES.md`). Malformed lines and unknown records are skipped and logged. Items stream to the UI on a `Channel<ChatEvent>` where `ChatEvent = Reset(Vec<ChatItem>) | Append(Vec<ChatItem>)`: the initial Reset carries the last 500 items, older pages are fetched on scroll-up.

**Rendering (React).** Virtualised list (`@tanstack/react-virtual`); Markdown with `react-markdown` and code highlighting; tool calls collapsed to name + summary, expandable to the result; Edit/Write tool calls render as a diff. Stick to the bottom when the user is at the bottom, otherwise show "↓ new messages".

**Sending.** Composer: Enter sends, Shift+Enter is a newline; sends with `agent.prompt`. Sending while the Agent is `working` is allowed (the Agent queues it as if typed). Quick keys **Esc**, **Ctrl+C**, **Shift+Tab** go through `agent.send_keys`.

**Blocked Agents.** When status is `blocked`, a pinned **"Needs your answer"** panel shows the Pane's current screen from `pane.read` (ansi format, rendered in a small read-only xterm, refreshed on status/`pane.updated` events) with quick keys `1` `2` `3` `Enter` `Esc` `↑` `↓` and an "Open Terminal lens" button.

## 6. Errors, logging, testing

| Situation | Behaviour |
|---|---|
| Local herdr missing or no running Session | Empty state with instructions and "Start default session" |
| Remote protocol ≠ 22 | Machine `incompatible`, shows remote version, no controls |
| herdr not found on remote | "herdr not found", prompt to set `herdr_path` |
| SSH needs re-authentication | Reconnect button → Connect dialog |
| sshd forbids stream-local forwarding | Specific error naming `AllowStreamLocalForwarding` |
| Attach held by another client | Banner + Take over |
| Transcript missing or ambiguous | Chat lens falls back to Terminal, or shows the picker |
| RPC timeout (10 s) | Toast with method name; subscriptions reconnect with backoff |

Logging: `tracing` to `<appdata>/logs/`, rotated, 5 files kept.

**Testing.**

- Rust unit: RPC codec; `SessionModel` event application (snapshot + event-sequence fixtures); Claude and pi parsers (redacted real `.jsonl` fixtures); cwd encoding; `herdr session list` parsing; herdr path discovery order; Attach Manager flow control with a fake PTY.
- Rust integration against an isolated Session (`herdr --session herdrapp-test server`, deleted afterwards): snapshot, subscribe, `workspace.create`, attach, `pane.send_text` then read back, held-attach detection.
- Ssh integration: against `localhost` via macOS Remote Login, gated by an env var. Manual end-to-end against `devtuf` (herdr 0.9.3, protocol 22, binary in `~/.local/bin`).
- Frontend: Vitest for store reducers; component tests for Chat items and the sidebar tree.

## Repository layout

```
herdr-app/
├── CONTEXT.md
├── THIRD_PARTY_NOTICES.md
├── docs/adr/0001-system-ssh-transport.md
├── docs/superpowers/specs/2026-10-02-herdr-app-design.md
├── src-tauri/
│   ├── Cargo.toml  tauri.conf.json
│   └── src/ main.rs lib.rs commands.rs machines.rs attach.rs
│            herdr/ transport/ transcript/
├── src/  App.tsx main.tsx sidebar/ terminal/ chat/ store/
└── package.json  vite.config.ts  tsconfig.json
```
