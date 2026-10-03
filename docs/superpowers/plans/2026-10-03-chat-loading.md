# Chat lens loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make opening and switching Chat lenses fast for large Transcripts, locally and over SSH: one complete first `Reset`, parsing off tokio, capped tool inputs, a bounded webview, stable row keys, cached Mermaid SVGs and parked tails.

**Architecture:** The tail script prints the file size before streaming, so Rust knows when the backlog has been read. A tokio reader task feeds a per-tail parse thread over a bounded channel. `ChatManager` parks closed tails (up to 3) and reattaches them on reopen. The webview trims to the last 1000 items while at the bottom, and keys virtual rows by stable ids.

**Tech Stack:** Rust (tokio, serde_json), Tauri 2 channels, React 19 + TypeScript, `@tanstack/react-virtual`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-chat-loading-design.md`

## Global Constraints

- Work in `.worktrees/chat-loading` on branch `chat-loading` (from `dev`). Before any pnpm command: `export PATH="$HOME/.local/share/mise/installs/pnpm/11.18.0:$HOME/.local/share/mise/installs/node/24.14.0/bin:$PATH"`, then `pnpm install --frozen-lockfile` once.
- Rust commands run in `src-tauri/`: `cargo test --lib <filter>`. TS: `pnpm test -- <file>` and `pnpm typecheck` at the repo root.
- Conventional Commits, scope `chat` (e.g. `fix(chat): ...`, `perf(chat): ...`). No attribution lines.
- Values the spec pins: `RESET_ITEMS` 500 (unchanged); first-Reset inactivity limit `QUIET` = 2 s (1 s under `cfg!(test)`, longer than the old 300 ms cap so tests tell them apart); webview trims to 1000 items once over 2000; tool-input strings capped at 64 KiB; Mermaid cache 50 entries; 3 parked tails; parked image budget 16 MiB; open image budget 64 MiB (`IMAGE_BUDGET`, unchanged).
- Truncation marker is the existing `"\n… (truncated)"` for both results and inputs, made by one shared helper.
- Never lock the image store while parsing. Never hold `ChatManager`'s map lock while locking a tail's image store (which `attach`/`detach` do) or while dropping a `TailHandle`: take the entry out of the map, act on it, then put it back.
- Do not commit anything under `tmp/` or the benchmark harness (`src-tauri/src/transcript/bench.rs`).
- Comments follow the repo: short, saying why, not what.

## Review Focus

- Close then reopen within one tick (50 ms): the reopened lens must still get exactly one `Reset` from the kept items. Test in Task 7.
- A lens reopened while its parked tail is still mid-backlog: no duplicate `Reset`, and the normal first-Reset rule still fires. Test in Task 7.
- A pi branch switch (`Reset` from the parser) while parked: the reattach `Reset` shows the new branch. Test in Task 7.
- The Machine drops while a tail is parked: the next open spawns a new tail instead of reattaching a dead one. Test in Task 7.
- A trimmed webview scrolled up: older pages still line up with `before = total - items.length`. Test in Task 2.

---

### Task 1: First `Reset` by byte count (A)

**Files:**
- Modify: `src-tauri/src/transcript/tail.rs` (constants at 13-16, `State`, `flush` at 98-123, `run` at 168-226, tests)

**Interfaces:**
- Produces: `fn parse_header(line: &[u8]) -> Option<u64>` (private, in `tail.rs`); `const QUIET: Duration`. `State` gains `size: Option<u64>`, `consumed: u64`, `last_byte: Option<Instant>` (None until the first byte). `ever_got_bytes`, `got_bytes`, `started` and `INITIAL_CAP` are removed.

- [ ] **Step 1: Write the failing tests** in `tail.rs` `mod tests`:

```rust
    /// Starts the command only after `delay`, like a slow ssh: nothing arrives at first.
    struct Slow(&'static str);
    #[async_trait::async_trait]
    impl crate::transport::Transport for Slow {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let mut v: Vec<String> = vec!["sh".into(), "-c".into(), format!("sleep {}; exec \"$@\"", self.0), "sh".into()];
            v.extend(argv.iter().cloned());
            v
        }
        async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
        async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
    }
    /// Prints a junk first line before the command: the size header is unreadable.
    struct Junk;
    #[async_trait::async_trait]
    impl crate::transport::Transport for Junk {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let mut v: Vec<String> = vec!["sh".into(), "-c".into(), "echo ' junk'; exec \"$@\"".into(), "sh".into()];
            v.extend(argv.iter().cloned());
            v
        }
        async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
        async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
    }
    fn collect(t: Arc<dyn crate::transport::Transport>, p: &std::path::Path) -> (TailHandle, Arc<Mutex<Vec<ChatEvent>>>) {
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = spawn_tail(t, p.to_string_lossy().into(), Box::new(Lines), Arc::new(move |e| g.lock().unwrap().push(e)));
        (h, got)
    }

    #[test]
    fn reads_the_size_header() {
        assert_eq!(parse_header(b"   1234"), Some(1234));
        assert_eq!(parse_header(b"0"), Some(0));
        assert_eq!(parse_header(b" junk"), None);
    }

    #[tokio::test]
    async fn a_slow_start_still_sends_the_whole_backlog_as_one_reset() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, (0..50).map(|i| format!("m{i}\n")).collect::<String>()).unwrap();
        // Slower than QUIET (1 s in tests): the quiet clock must not run before the first byte.
        let (_h, got) = collect(Arc::new(Slow("1.3")), &p);
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { total: 50, .. }), "{ev:?}");
        assert!(!ev.iter().any(|e| matches!(e, ChatEvent::Append { .. })), "{ev:?}");
    }

    #[tokio::test]
    async fn a_last_line_without_newline_follows_the_reset() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nb").unwrap();
        let (_h, got) = collect(Arc::new(crate::transport::local::LocalTransport), &p);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(matches!(&got.lock().unwrap()[0], ChatEvent::Reset { total: 1, .. }));
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"\n").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let ev = got.lock().unwrap();
        assert!(ev.iter().any(|e| matches!(e, ChatEvent::Append { items } if items.len() == 1)), "{ev:?}");
    }

    #[tokio::test]
    async fn an_unreadable_header_falls_back_to_quiet() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let (_h, got) = collect(Arc::new(Junk), &p);
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        assert!(got.lock().unwrap().is_empty(), "sent before QUIET");
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        // The real size line becomes an item: only the quiet rule could have sent this Reset.
        assert!(matches!(&got.lock().unwrap()[0], ChatEvent::Reset { total: 2, .. }));
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --lib transcript::tail`
Expected: compile error, because `parse_header` is not defined. Once a stub returning `None` is added: `a_slow_start_...` fails (Reset at 300 ms with `total: 0`, then an Append), and `an_unreadable_header_...` fails (it sends before QUIET).

- [ ] **Step 3: Implement**

- The script becomes `wc -c < "$1" 2>/dev/null || echo 0; tail -c +1 -F "$1" & p=$!; cat >/dev/null; kill $p 2>/dev/null`. Keep the stdin-EOF comment.
- `parse_header` trims ASCII whitespace and parses `u64`.
- In `run`, the first complete stdout line is the header. It is not passed to `st.line`, and it sets `st.size`. Raw byte counts after the header, including newlines, `\r` and bytes dropped past `MAX_LINE`, add to `st.consumed` and set `st.last_byte = Some(Instant::now())`. Every byte, including the header's, sets `last_byte`.
- In `flush` before the first Reset: `caught_up = st.size.is_some_and(|s| st.consumed >= s) || st.last_byte.is_some_and(|t| t.elapsed() >= QUIET)`. Before the first byte, nothing is sent. A process that never talks ends in `Eof` and the existing error.
- `const QUIET: Duration = if cfg!(test) { Duration::from_secs(1) } else { Duration::from_secs(2) };`

- [ ] **Step 4: Run the tail tests**

Run: `cargo test --lib transcript`
Expected: all pass, the existing tail and `ChatManager` tests included. `empty_and_missing_files_still_reset` must still pass; both the empty and the missing file report size 0.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transcript/tail.rs
git commit -m "fix(chat): send the first Reset once the backlog's bytes are read"
```

### Task 2: Trim the webview's items while at the bottom (B)

**Files:**
- Modify: `src/chat/chatStore.ts`, `src/chat/ChatLens.tsx:20-21` (reducer) and `:58-66` (`channel.onmessage`)
- Test: `src/chat/chatStore.test.ts`

**Interfaces:**
- Produces: `export const TRIM_AT = 2000; export const TRIM_TO = 1000;` and `reduce(state: ChatState, ev: ChatEvent, atBottom?: boolean): ChatState` in `chatStore.ts`. In `ChatLens.tsx` the action type becomes `(ChatEvent & { atBottom?: boolean }) | { type: "prepend"; items: ChatItem[] }`.

- [ ] **Step 1: Write the failing tests** (append to the `describe` in `chatStore.test.ts`; also import `TRIM_AT, TRIM_TO`):

```ts
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => u(`m${from + i}`));
  it("trims to the newest items when an append at the bottom passes the cap", () => {
    let s = reduce(emptyChat, { type: "reset", items: many(500, 4500), total: 5000 });
    s = reduce(s, { type: "append", items: many(TRIM_AT - 500 + 1, 5000) }, true);
    expect(s.items.length).toBe(TRIM_TO);
    expect(s.total).toBe(5000 + TRIM_AT - 500 + 1);
    expect((s.items[TRIM_TO - 1] as any).text).toBe(`m${s.total - 1}`);
    // Older pages still line up: the item before the first kept one is total - length - 1.
    const before = s.total - s.items.length;
    s = prepend(s, [u(`m${before - 1}`)]);
    expect((s.items[0] as any).text).toBe(`m${before - 1}`);
    expect((s.items[1] as any).text).toBe(`m${before}`);
  });
  it("does not trim while the user reads older rows", () => {
    let s = reduce(emptyChat, { type: "reset", items: many(500), total: 500 });
    s = reduce(s, { type: "append", items: many(TRIM_AT, 500) }, false);
    expect(s.items.length).toBe(TRIM_AT + 500);
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm test -- src/chat/chatStore.test.ts`
Expected: FAIL. `TRIM_AT` is undefined and the length is 2501, not 1000.

- [ ] **Step 3: Implement**

- In `reduce`, `append` concatenates as today. When `atBottom` is true and the result is longer than `TRIM_AT`, keep the last `TRIM_TO`. `total` is unchanged by the trim.
- In `ChatLens`, `onmessage` dispatches `ev.type === "append" ? { ...ev, atBottom: atBottom.current } : ev`, and the local reducer passes `a.atBottom` to `reduce`.
- Add a one-line comment at the trim saying the JS items stay a suffix of the tail's, so paging still works.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test -- src/chat && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/chat/chatStore.ts src/chat/chatStore.test.ts src/chat/ChatLens.tsx
git commit -m "perf(chat): keep the newest 1000 items while following the bottom"
```

### Task 3: Parse on a thread of its own (D)

**Files:**
- Modify: `src-tauri/src/transcript/tail.rs`; `src-tauri/src/transcript/mod.rs:201-202`. In `ChatManager::image`, replace the comment about the tail holding the store lock during a parse with: the store is locked only briefly by the tail, but `handles` must still not be held while locking it.

**Interfaces:**
- Consumes: Task 1's `State` fields and `parse_header`.
- Produces: `enum Msg { Header(Option<u64>), Line(Vec<u8>), Bytes(usize), Tick, Eof }` (private). `TailHandle` keeps `page`, `images` and its `Drop`, and its field `task` is still the reader's `JoinHandle<()>`. `State` runs on a `std::thread` named `chat-parse`.

- [ ] **Step 1: Write the failing test** in `tail.rs` tests:

```rust
    /// Blocks inside `push_line` until released, reporting when it got there.
    struct Stuck {
        entered: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    }
    impl Parser for Stuck {
        fn push_line(&mut self, _: &str, images: &mut dyn ImageSink) -> ParserOutput {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            images.put("r".into(), "image/png".into(), vec![1]);
            ParserOutput::None
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_image_store_is_free_while_a_line_parses() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let (entered_tx, entered) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(Stuck { entered: entered_tx, release: release_rx }),
            Arc::new(|_| {}),
        );
        let store = h.images();
        tokio::task::spawn_blocking(move || entered.recv_timeout(std::time::Duration::from_secs(3)))
            .await.unwrap().expect("parser never ran");
        assert!(store.try_lock().is_ok(), "the store is locked during the parse");
        release.send(()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(store.lock().unwrap().get("r"), Some(("image/png".to_string(), vec![1])));
    }
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cargo test --lib transcript::tail::tests::the_image_store_is_free_while_a_line_parses`
Expected: FAIL on the `try_lock` assertion ("the store is locked during the parse").

- [ ] **Step 3: Implement**

- `spawn_tail` creates `tokio::sync::mpsc::channel::<Msg>(16)`, starts the `chat-parse` thread (it owns `State` and loops `while let Some(m) = rx.blocking_recv()`), and `tokio::spawn`s the reader. The reader takes the `run` body minus parsing: it sends `Header`, `Line` (bytes without the `\n`/`\r`), `Bytes` (after the chunk's lines) and `Tick`, and `Eof` when stdout ends. If `send` fails it returns.
- On `Eof` the thread flushes and sends the existing "transcript tail exited" error.
- `State::line` parses into a local `Vec<(String, String, Vec<u8>)>` and then locks the store only to `put` each image.
- `String::from_utf8_lossy` and the `\r` strip stay with the line. Move them into the thread.

- [ ] **Step 4: Run all transcript tests**

Run: `cargo test --lib transcript`
Expected: all pass, including `dropping_the_handle_ends_tail`. Dropping the handle aborts the reader, which closes the channel, which ends the thread.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transcript/tail.rs src-tauri/src/transcript/mod.rs
git commit -m "perf(chat): parse transcript lines off the tokio workers"
```

### Task 4: Cap tool-call input (E)

**Files:**
- Modify: `src-tauri/src/transcript/mod.rs:150-163`, `src-tauri/src/transcript/claude.rs:170-186`, `src-tauri/src/transcript/pi.rs:217-230`

**Interfaces:**
- Produces: `pub(crate) const MAX_INPUT_STRING_BYTES: usize = 64 * 1024;` and `pub(crate) fn cap_input(v: serde_json::Value) -> serde_json::Value` in `mod.rs`. `truncate_result` and `cap_input` share one private `fn cut(s: String, max: usize) -> String`, which cuts on a char boundary and appends `"\n… (truncated)"`.

- [ ] **Step 1: Write the failing tests**

In `mod.rs` tests:
```rust
    #[test]
    fn caps_each_input_string_and_keeps_every_field() {
        let big = format!("a{}", "é".repeat(40 * 1024)); // 80 KiB; the leading byte makes a 2-byte char straddle the cut
        let v = serde_json::json!({"file_path": "/a", "edits": [{"old_string": big, "new_string": "x"}], "n": 3});
        let out = cap_input(v);
        let old = out["edits"][0]["old_string"].as_str().unwrap();
        assert!(old.ends_with("\n… (truncated)"));
        assert!(old.len() <= MAX_INPUT_STRING_BYTES + "\n… (truncated)".len());
        assert_eq!(out["edits"][0]["new_string"], "x");
        assert_eq!(out["file_path"], "/a");
        assert_eq!(out["n"], 3);
    }
```
In `claude.rs` tests:
```rust
    #[test]
    fn caps_a_huge_write_but_summarises_the_whole_input() {
        let content = "x".repeat(1024 * 1024);
        let line = serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Write","input":{"file_path":"/src/a.rs","content":content}}]}}).to_string();
        let full = input_summary("Write", &serde_json::json!({"file_path":"/src/a.rs","content":content}));
        match ClaudeParser::default().push_line(&line, &mut Vec::<(String, String, Vec<u8>)>::new()) {
            ParserOutput::Append(v) => match &v[0] {
                ChatItem::ToolCall { input, input_summary, .. } => {
                    assert!(input["content"].as_str().unwrap().len() < 70 * 1024);
                    assert_eq!(input_summary, &full);
                }
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
    }
```
In `pi.rs` tests, the same test with the pi record `{"type":"message","id":"a","parentId":null,"message":{"role":"assistant","content":[{"type":"toolCall","id":"t","name":"write","arguments":{"path":"/src/a.rs","content":content}}]}}`, `PiParser::default()`, and `input_summary("write", ...)`. If pi's `push_line` returns `Reset` for a first record, match `ParserOutput::Append(v) | ParserOutput::Reset(v)`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --lib transcript`
Expected: compile error, because `cap_input` is not defined. With a stub, the length assertions fail.

- [ ] **Step 3: Implement**

`cap_input` recurses through objects and arrays and passes `cut(s, MAX_INPUT_STRING_BYTES)` over each string longer than the limit. Claude and pi compute `input_summary(&name, &input)` first, then store `cap_input(input)`.

- [ ] **Step 4: Run tests**

Run: `cargo test --lib transcript`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transcript/mod.rs src-tauri/src/transcript/claude.rs src-tauri/src/transcript/pi.rs
git commit -m "perf(chat): cap each tool input string at 64 KiB"
```

### Task 5: Stable virtual row keys (F)

**Files:**
- Modify: `src/chat/workBlocks.ts` (`ChatRow`, `buildRows`), `src/chat/ChatLens.tsx:117` (the `buildRows` call) and `:120-125` (`useVirtualizer`)
- Test: `src/chat/workBlocks.test.ts`

**Interfaces:**
- Produces: `ChatRow` variants each gain `key: string`: work rows `w:<block.id>`, item rows `i:<offset + index of the item in items>`. Signature: `buildRows(items: ChatItem[], offset = 0)`.

- [ ] **Step 1: Write the failing test** (append to `describe("buildRows")`):

```ts
  it("keys rows by block id or absolute item index, stable across a prepend", () => {
    const newer = [user("2", "t2"), call("b"), say("y")];
    const after = buildRows(newer, 10).rows.map((r) => r.key);
    const before = buildRows([user("1", "t1"), say("x"), ...newer], 8).rows.map((r) => r.key);
    expect(after).toEqual(["i:10", "w:turn:t2", "i:12"]);
    expect(before.slice(-3)).toEqual(after);
  });
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test -- src/chat/workBlocks.test.ts`
Expected: FAIL. `key` is undefined.

- [ ] **Step 3: Implement**

- `buildRows` tracks each item's index while iterating, and sets `key` on every pushed row.
- `ChatLens` calls `buildRows(state.items, state.total - state.items.length)`.
- `useVirtualizer` gets `getItemKey: (i) => rows[i].key`, with `rows` passed through a ref or kept in the closure so it is current. TanStack re-reads options every render.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm test -- src/chat && pnpm typecheck`
Expected: all pass. Fix any test that builds `ChatRow` literals by adding `key`.

- [ ] **Step 5: Commit**

```bash
git add src/chat/workBlocks.ts src/chat/workBlocks.test.ts src/chat/ChatLens.tsx
git commit -m "fix(chat): key virtual rows by block id and item index"
```

### Task 6: Cache rendered Mermaid SVGs (G)

**Files:**
- Modify: `src/chat/MermaidBlock.tsx`
- Test: `src/chat/MermaidBlock.test.tsx`

**Interfaces:**
- Produces: a module-level `const svgCache = new Map<string, string>()` (LRU, max 50, key `` `${theme}\n${source}` ``), and `export function clearMermaidCache(): void` for tests.

- [ ] **Step 1: Write the failing test** (add to `describe("mermaid blocks")`; import `clearMermaidCache` from `./MermaidBlock` and call it in `beforeEach`):

```tsx
  it("shows a cached diagram on remount without rendering again", async () => {
    const item = { kind: "assistant_text" as const, markdown: md("graph TD; C-->D") };
    const first = render(<ChatItemView item={item} />);
    await waitFor(() => expect(first.container.querySelector(".chat-mermaid svg")).not.toBeNull());
    first.unmount();
    const second = render(<ChatItemView item={item} />);
    expect(second.container.querySelector(".chat-mermaid svg")).not.toBeNull();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test -- src/chat/MermaidBlock.test.tsx`
Expected: FAIL. `clearMermaidCache` is not exported. Once exported, the svg is null on the second mount.

- [ ] **Step 3: Implement**

- `useState` initialises `svg` from the cache.
- The effect returns early when the cache has the key, and sets `svg` from it. That way a theme or source change still picks up the right entry.
- A successful render stores the `stripImages` result.
- On a hit, delete and re-set the key to refresh its LRU position. Above 50 entries, delete the first key.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- src/chat && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/chat/MermaidBlock.tsx src/chat/MermaidBlock.test.tsx
git commit -m "perf(chat): cache rendered mermaid diagrams"
```

### Task 7: Park closed tails and reattach them (C)

**Files:**
- Modify: `src-tauri/src/transcript/tail.rs` (`TailHandle`, `State`), `src-tauri/src/transcript/images.rs` (`ImageStore`), `src-tauri/src/transcript/mod.rs` (`ChatManager`, its tests, exports), `src-tauri/src/commands.rs:496-530` (`chat_open`)

**Interfaces:**
- Consumes: Task 3's parse thread and `Msg::Tick` (a tick arrives every 50 ms, which bounds how long an attach waits).
- Produces:
  - `pub type Sink = Arc<dyn Fn(ChatEvent) + Send + Sync>`, re-exported from `transcript`.
  - `TailHandle::attach(&self, sink: Sink)`, `TailHandle::detach(&self)` and `TailHandle::is_running(&self) -> bool` (the reader task has not finished).
  - `pub const PARKED_IMAGE_BUDGET: usize = 16 * 1024 * 1024;` and `ImageStore::set_budget(&mut self, budget: usize)`, which evicts oldest first down to the budget.
  - `pub const PARKED_TAILS: usize = 3;`
  - `ChatManager::insert(&self, pane: PaneRef, path: String, handle: TailHandle)`, `ChatManager::reattach(&self, pane: &PaneRef, path: &str, sink: Sink) -> bool` and `ChatManager::close(&self, pane: &PaneRef)` (now parks).
  - `page`, `image` and `close_machine` keep their signatures. `page` and `image` see open tails only. `close_machine` drops open and parked tails.
- Design note: attach goes through a slot, not through the bounded channel, so a sync `attach` never blocks while the backlog fills the channel. The 50 ms `Tick` guarantees the parse thread drains the slot.

- [ ] **Step 1: Write the failing tests**

In `images.rs` tests:
```rust
    #[test]
    fn shrinking_the_budget_evicts_oldest_first() {
        let mut s = ImageStore::new(10);
        s.put("a".into(), "image/png".into(), vec![0; 4]);
        s.put("b".into(), "image/png".into(), vec![1; 4]);
        s.set_budget(5);
        assert_eq!(s.get("a"), None);
        assert!(s.get("b").is_some());
        s.set_budget(10);
        s.put("c".into(), "image/png".into(), vec![2; 4]);
        assert!(s.get("b").is_some() && s.get("c").is_some());
    }
```
In `mod.rs` tests (update the existing tests' `chats.insert(pane, h)` calls to `chats.insert(pane, path, h)`):
```rust
    struct Echo;
    impl Parser for Echo {
        fn push_line(&mut self, line: &str, _: &mut dyn ImageSink) -> ParserOutput {
            let item = ChatItem::User { ts: None, text: line.into(), images: vec![], skills: vec![] };
            if line == "RESET" { ParserOutput::Reset(vec![item]) } else { ParserOutput::Append(vec![item]) }
        }
    }
    fn pane(id: &str) -> PaneRef {
        PaneRef { machine_id: "a".into(), session: "default".into(), pane_id: id.into() }
    }
    fn recorder() -> (Sink, Arc<std::sync::Mutex<Vec<ChatEvent>>>) {
        let got: Arc<std::sync::Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        (Arc::new(move |e| g.lock().unwrap().push(e)), got)
    }
    fn open(chats: &ChatManager, p: &PaneRef, path: &std::path::Path) -> Arc<std::sync::Mutex<Vec<ChatEvent>>> {
        let (sink, got) = recorder();
        let path: String = path.to_string_lossy().into();
        if !chats.reattach(p, &path, sink.clone()) {
            chats.insert(p.clone(), path.clone(), spawn_tail(Arc::new(crate::transport::local::LocalTransport), path, Box::new(Echo), sink));
        }
        got
    }

    #[tokio::test]
    async fn reopening_a_parked_tail_resets_from_kept_items() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        let chats = ChatManager::default();
        let first = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        chats.close(&pane("p1"));
        assert!(chats.page(&pane("p1"), 2, 10).is_none(), "a parked tail is not open");
        use std::io::Write;
        // A pi-style branch switch while parked.
        std::fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(b"RESET\n").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let second = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let ev = second.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { items, total: 1 } if items.len() == 1), "{ev:?}");
        assert_eq!(ev.iter().filter(|e| matches!(e, ChatEvent::Reset { .. })).count(), 1);
        assert!(!first.lock().unwrap().iter().any(|e| matches!(e, ChatEvent::Reset { total: 1, .. })), "the closed lens got events");
    }

    #[tokio::test]
    async fn close_then_open_within_a_tick_still_resets_once() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        chats.close(&pane("p1"));
        let again = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let ev = again.lock().unwrap();
        assert_eq!(ev.iter().filter(|e| matches!(e, ChatEvent::Reset { total: 1, .. })).count(), 1, "{ev:?}");
    }

    #[tokio::test]
    async fn a_parked_tail_mid_backlog_sends_its_first_reset_once() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.close(&pane("p1")); // before any Reset was sent
        let again = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let ev = again.lock().unwrap();
        assert_eq!(ev.iter().filter(|e| matches!(e, ChatEvent::Reset { .. })).count(), 1, "{ev:?}");
    }

    #[tokio::test]
    async fn a_fourth_park_drops_the_oldest_and_other_paths_start_fresh() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        let g = d.path().join("u.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        std::fs::write(&g, "z\n").unwrap();
        let chats = ChatManager::default();
        for id in ["p1", "p2", "p3", "p4"] {
            open(&chats, &pane(id), &f);
            chats.close(&pane(id));
        }
        let (sink, _) = recorder();
        assert!(!chats.reattach(&pane("p1"), &f.to_string_lossy(), sink.clone()), "p1 should have been dropped");
        assert!(!chats.reattach(&pane("p4"), &g.to_string_lossy(), sink.clone()), "another path must not reattach");
        assert!(chats.reattach(&pane("p3"), &f.to_string_lossy(), sink));
    }

    #[tokio::test]
    async fn a_dead_parked_tail_is_not_reattached() {
        struct Gone;
        #[async_trait::async_trait]
        impl crate::transport::Transport for Gone {
            fn wrap(&self, _: &[String], _: bool) -> Vec<String> { vec!["true".into()] }
            async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
            async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
        }
        let chats = ChatManager::default();
        let (sink, _) = recorder();
        chats.insert(pane("p1"), "/x".into(), spawn_tail(Arc::new(Gone), "/x".into(), Box::new(Echo), sink.clone()));
        chats.close(&pane("p1"));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!chats.reattach(&pane("p1"), "/x", sink));
    }

    #[tokio::test]
    async fn close_machine_drops_parked_tails() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.close(&pane("p1"));
        chats.close_machine("a");
        let (sink, _) = recorder();
        assert!(!chats.reattach(&pane("p1"), &f.to_string_lossy(), sink));
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cargo test --lib transcript`
Expected: compile errors: `set_budget`, `reattach` and `Sink` are missing, and `insert` takes 2 arguments.

- [ ] **Step 3: Implement**

`images.rs`: `set_budget` sets the budget and runs the same eviction loop as `put` (extract it as a private `fn evict(&mut self)`).

`tail.rs`:
- `TailHandle` and `State` share `Arc<Mutex<Link>>` with `struct Link { sink: Option<Sink>, pending: Option<Sink> }`. `spawn_tail` starts with `sink: Some(sink)`.
- `detach`: `sink = None`, `pending = None`, then `images.lock().set_budget(PARKED_IMAGE_BUDGET)`.
- `attach(s)`: `images.lock().set_budget(IMAGE_BUDGET)`, then `pending = Some(s)`.
- `State` emits through `link.sink`. Clone the `Arc` out of the lock before calling it.
- The parse thread checks `pending` before handling each message. If set, it clears `events` and `appended` and moves `pending` into `sink`. If `sent_first`, it sends `reset_event(items)`, sets `last_meta = ChatMeta::default()` and calls `send_meta_if_changed()`. If not `sent_first`, it does nothing more: the first-Reset rule will send to the new sink.

`mod.rs`:
- `ChatManager { tails: Mutex<Tails> }` with `struct Tails { open: HashMap<PaneRef, Entry>, parked: VecDeque<(PaneRef, Entry)> }` and `struct Entry { path: String, handle: TailHandle }`.
- `reattach` takes the Pane's open entry, or failing that its parked entry. If its path matches and `is_running()`, it calls `attach(sink)`, puts it in `open` and returns true. Otherwise it drops that entry, outside the lock, and returns false.
- `close` moves open → parked (`detach()`) and drops parked entries beyond `PARKED_TAILS`, oldest first, outside the lock.
- `insert` drops any open or parked entry of the Pane.
- Update the comment on `ChatManager` to say "One live transcript tail per open Pane, plus up to 3 parked ones."

`commands.rs` `chat_open`: build `sink`. If `!chats.reattach(&pane_ref, &located.path, sink.clone())`, `insert(pane_ref, located.path.clone(), spawn_tail(...))`.

- [ ] **Step 4: Run all Rust tests**

Run: `cargo test --lib`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transcript src-tauri/src/commands.rs
git commit -m "perf(chat): park closed chat tails and reattach them on reopen"
```

### Task 8: Verify, measure and record

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-chat-loading-design.md` (append an "After" table under "Baseline")

- [ ] **Step 1: Full checks**

Run: `pnpm test && pnpm typecheck` at the root and `cargo test` in `src-tauri/`.
Expected: all pass.

- [ ] **Step 2: Re-measure with the same harness**

The harness lives in `tmp/chat-bench/` in this worktree. `tmp/` ignores itself. It holds `gen.py`, `run.sh`, `bench.rs` and the baseline outputs.

- Generate the local files with `python3 tmp/chat-bench/gen.py`. The devtuf copies are already in `~/chat-bench/` there.
- Copy `tmp/chat-bench/bench.rs` to `src-tauri/src/transcript/bench.rs`. Add `#[cfg(test)] mod bench;` after `mod skill_prompt;` in `transcript/mod.rs`. Adjust the call if `spawn_tail`'s signature changed.
- Add a reattach timing:
  1. Insert the tail into a `ChatManager` and wait until it settles.
  2. Call `close`, then `reattach` with a new recording sink.
  3. Print `reattach_ms`, the time until the first `Reset` reaches that sink.
- From `src-tauri/`, run `sh ../tmp/chat-bench/run.sh after-local` and `sh ../tmp/chat-bench/run.sh after-devtuf devtuf`. The harness uses its own ControlMaster (`chatbench.ctl`), not the app's.
- Remove the harness: delete `bench.rs` and revert `mod.rs`. Only the spec may show as changed afterwards.

Expected: in every run the first `Reset` holds `total` equal to the whole file's items (57000 Claude, 42000 pi). `Append` items before settling are 0. Reattach takes under 100 ms.

- [ ] **Step 3: Record the "After" table in the spec and commit**

```bash
git add docs/superpowers/specs/2026-10-03-chat-loading-design.md
git commit -m "docs(chat): record chat loading results"
```

- [ ] **Step 4: Report what was not exercised**

Do not launch `pnpm tauri dev`. It shares app data and ssh masters with the user's installed herdr-app, and quitting it disconnects them. The tests and the harness cover the Rust side, the reducer, row keys and the Mermaid cache.

In the final report, list what still needs one look in the real app:
- scroll position while paging older rows after a trim;
- a pi branch switch;
- images after a park and a reattach;
- live appends while at the bottom and while scrolled up;
- Edit/Write diffs on a capped input (marker visible);
- switching between four Chat panes.

Ask the user to open the app once for these.
