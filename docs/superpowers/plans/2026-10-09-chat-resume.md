# Chat Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chat lens that comes back reads on from where its tail stopped instead of from byte 0, and puts the user back at the row they were reading.

**Architecture:** A tail that stops (pushed out of the parked tails, cut by an ssh drop, or replaced by another Transcript on its Pane) hands its parser, items and the byte offset of its last whole line to a `FrozenSlot`; `ChatManager` keeps up to 8 of them and `chat_open` resumes one with `tail -c +<offset+1>`. The webview keeps a Reading position per Pane and Transcript in memory and restores it at the first `Reset` of an open, paging older items in when needed.

**Tech Stack:** Rust (tokio, std threads) in `src-tauri/src/transcript/`, React + `@tanstack/react-virtual` + vitest in `src/chat/`.

**Spec:** `docs/superpowers/specs/2026-10-09-chat-resume-design.md`

## Global Constraints

- Work on `main` (the user's choice); one commit per task, Conventional Commits, scope `chat`.
- `PARKED_TAILS` stays 3. `FROZEN_TAILS = 8`. `FREEZE_WAIT = 500 ms` (how long a resume waits for a slot). Reading positions: at most 50. Restore pages: at most `RESTORE_PAGES = 10` `chat_page` calls (200 items each).
- Never drop, freeze or abort a `TailHandle` while holding `ChatManager`'s `tails` lock: collect the entries under the lock, act on them after it (the existing pattern in `insert`/`close`).
- A Frozen tail keeps no images: `Kept` has no image store, a resumed tail starts with an empty store at `IMAGE_BUDGET`.
- The offset counts complete lines only: each line's raw bytes including its `\r` and `\n`, lines dropped for exceeding `MAX_LINE` included. Header bytes never count.
- Rust formatting: run `rustfmt --edition 2021 <file>` on the files you edited only; never bare `cargo fmt` (it reformats unrelated files).
- Frontend commands run with `pnpm` from the repo root; Rust tests with `cargo test` from `src-tauri/`.
- Comments match the surrounding density: one-line doc comments on new items, no narration.

## Review Focus

- A line half-written when a tail stops must come back whole, once, never doubled or cut (Task 2 test `a_half_line_is_read_whole_after_a_resume`).
- A Transcript truncated or replaced below the offset must not be read on from the middle with the old parser (Task 2 test `a_shrunk_file_resumes_as_a_fresh_read`).
- A resume whose slot never fills (parse thread busy, panicked) must fall back to a read from byte 0, never hang `chat_open` (Task 4 test `an_empty_slot_falls_back_to_a_fresh_tail`).
- A Reading position past the new `total` (pi switched branch while away) must land at the bottom, not at a wrong row (Task 5 `restoreTarget` test).
- The `Reset` may reach the lens before `chat_open` resolves with the path: the restore must wait for both (Task 6 test with the Reset sent before `opened` resolves).

---

### Task 1: The tail counts its offset and leaves its state in a FrozenSlot when it stops

**Files:**
- Modify: `src-tauri/src/transcript/tail.rs` (`Msg`, `State`, `parse_loop`, `read`, `TailHandle`, `spawn_tail`, tests)
- Modify: `src-tauri/src/transcript/mod.rs:19` (re-export)

**Interfaces:**
- Produces (in `tail.rs`, re-exported from `transcript`):
  - `pub struct Kept { pub parser: Box<dyn Parser>, pub items: Vec<ChatItem>, pub offset: u64 }`
  - `#[derive(Clone, Default)] pub struct FrozenSlot(Arc<(Mutex<Option<Kept>>, Condvar)>)` with `fn put(&self, k: Kept)` (fills and notifies) and `pub fn take(&self, wait: Duration) -> Option<Kept>` (waits up to `wait` for the slot, then takes it)
  - `impl TailHandle { pub fn freeze(self) -> FrozenSlot }`: clones the slot out, then drops `self` (which aborts the reader as today)
  - `Msg::Line(Vec<u8>, usize)` (line without its newline, raw length with `\r\n`/`\n`) and `Msg::Skipped(usize)` (a line dropped for `MAX_LINE`, raw length)
  - `State` gets `offset: u64` and `kept: FrozenSlot`; `TailHandle` gets `kept: FrozenSlot`

- [ ] **Step 1: Write the failing tests** in `tail.rs`'s `mod tests`

Update the `state()` helper to set `offset: 0` and `kept: FrozenSlot::default()` (and `fresh: None` once Task 2 adds it), and the literal `TailHandle { … }` in `a_done_tail_is_not_running_while_its_reader_lingers` to add `kept: FrozenSlot::default()`. Then add:

```rust
    #[test]
    fn skipped_lines_count_toward_the_offset() {
        let st = state(Box::new(Lines));
        let slot = st.kept.clone();
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        tx.blocking_send(Msg::Line(b"a".to_vec(), 2)).unwrap();
        tx.blocking_send(Msg::Skipped(40)).unwrap();
        tx.blocking_send(Msg::Line(b"b".to_vec(), 3)).unwrap();
        drop(tx);
        parse_loop(st, rx);
        let kept = slot.take(Duration::from_millis(10)).expect("the slot is filled when the channel closes");
        assert_eq!(kept.offset, 45);
        assert_eq!(kept.items.len(), 2);
    }

    #[test]
    fn an_eof_fills_the_slot_too() {
        let st = state(Box::new(Lines));
        let slot = st.kept.clone();
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        tx.blocking_send(Msg::Line(b"a".to_vec(), 2)).unwrap();
        tx.blocking_send(Msg::Eof).unwrap();
        parse_loop(st, rx);
        assert_eq!(slot.take(Duration::from_millis(10)).map(|k| k.offset), Some(2));
    }

    #[test]
    fn an_empty_slot_gives_up_after_the_wait() {
        let start = Instant::now();
        assert!(FrozenSlot::default().take(Duration::from_millis(50)).is_none());
        assert!(start.elapsed() >= Duration::from_millis(50));
    }

    #[tokio::test]
    async fn a_frozen_tail_keeps_its_items_and_the_offset_of_its_last_whole_line() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nbb\r\nhalf").unwrap();
        let (h, _got) = collect(Arc::new(crate::transport::local::LocalTransport), &p);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let kept = h.freeze().take(Duration::from_millis(500)).expect("kept");
        assert_eq!(kept.offset, 6, "a\\n and bb\\r\\n; the half line is not counted");
        assert_eq!(kept.items.len(), 2);
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd src-tauri && cargo test --lib transcript::tail 2>&1 | tail -20`
Expected: compile errors (`FrozenSlot`, `Msg::Skipped`, `freeze` not found).

- [ ] **Step 3: Implement**

- `read`: send `Msg::Line(buf, raw_len)` where `raw_len` is the bytes of the whole line as read (all parts of a line split across chunks, plus its `\n`); a line that hit `MAX_LINE` sends `Msg::Skipped(raw_len)` when its `\n` arrives instead of nothing. `Msg::Bytes` stays as is.
- `parse_loop`: `Line(_, n)` and `Skipped(n)` add `n` to `st.offset` after the line is parsed. On every exit (Eof after its flush and error event, or channel closed) put `Kept { parser, items: take of st.items, offset }` into `st.kept` before `State` drops. Restructure as `let st = loop { … }; st.kept.clone().put(…)` or similar; `DoneOnDrop` must still fire after the put.
- `spawn_tail` creates the slot and shares it between `State` and `TailHandle`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib transcript 2>&1 | tail -5`
Expected: all `transcript` tests pass, including the four new ones.

- [ ] **Step 5: Format and commit**

```bash
rustfmt --edition 2021 src-tauri/src/transcript/tail.rs src-tauri/src/transcript/mod.rs
git add src-tauri/src/transcript/tail.rs src-tauri/src/transcript/mod.rs
git commit -m "feat(chat): a stopped tail leaves its parser, items and offset in a frozen slot"
```

### Task 2: A tail resumes from a Kept state at its offset

**Files:**
- Modify: `src-tauri/src/transcript/tail.rs` (script, `parse_header`, `Msg::Header`, `State`, new `resume_tail`, tests)
- Modify: `src-tauri/src/transcript/mod.rs:19` (re-export `resume_tail`)

**Interfaces:**
- Consumes: `Kept`, `FrozenSlot` (Task 1).
- Produces:
  - `pub fn resume_tail(t: Arc<dyn Transport>, path: String, kept: Kept, fresh: Box<dyn Parser>, sink: Sink) -> TailHandle`: starts reading at `kept.offset` with `kept.parser` and `kept.items`; `fresh` replaces them when the file is now shorter than the offset.
  - `spawn_tail` keeps its signature (offset 0, no fresh parser).
  - `fn parse_header(line: &[u8]) -> Option<(u64, u64)>`: `(size, start)`, two whitespace-separated `u64`s, else `None`.
  - `Msg::Header(Option<(u64, u64)>)`; `State` gets `fresh: Option<Box<dyn Parser>>`.

- [ ] **Step 1: Write the failing tests**

Replace `reads_the_size_header` with:

```rust
    #[test]
    fn reads_the_size_and_start_header() {
        assert_eq!(parse_header(b"1234 0"), Some((1234, 0)));
        assert_eq!(parse_header(b"  77 12"), Some((77, 12)));
        assert_eq!(parse_header(b"1234"), None);
        assert_eq!(parse_header(b" junk"), None);
    }
```

Add a helper and three tests:

```rust
    fn texts(ev: &ChatEvent) -> Vec<String> {
        match ev {
            ChatEvent::Reset { items, .. } => items
                .iter()
                .map(|i| match i {
                    ChatItem::User { text, .. } => text.clone(),
                    other => format!("{other:?}"),
                })
                .collect(),
            other => panic!("not a reset: {other:?}"),
        }
    }

    async fn frozen(p: &std::path::Path) -> Kept {
        let (h, _) = collect(Arc::new(crate::transport::local::LocalTransport), p);
        tokio::time::sleep(Duration::from_millis(400)).await;
        h.freeze().take(Duration::from_millis(500)).expect("kept")
    }

    fn resume(p: &std::path::Path, kept: Kept) -> (TailHandle, Arc<Mutex<Vec<ChatEvent>>>) {
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = resume_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            kept,
            Box::new(Lines),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        (h, got)
    }

    #[tokio::test]
    async fn a_resumed_tail_reads_on_from_its_offset() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nb\n").unwrap();
        let kept = frozen(&p).await;
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"c\n").unwrap();
        let (_h, got) = resume(&p, kept);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { total: 3, .. }), "{ev:?}");
        assert_eq!(texts(&ev[0]), ["a", "b", "c"]);
        assert!(!ev.iter().any(|e| matches!(e, ChatEvent::Append { .. })), "{ev:?}");
    }

    #[tokio::test]
    async fn a_half_line_is_read_whole_after_a_resume() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nhal").unwrap();
        let kept = frozen(&p).await;
        assert_eq!((kept.offset, kept.items.len()), (2, 1));
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"f\n").unwrap();
        let (_h, got) = resume(&p, kept);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(texts(&got.lock().unwrap()[0]), ["a", "half"]);
    }

    #[tokio::test]
    async fn a_shrunk_file_resumes_as_a_fresh_read() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nb\nc\n").unwrap();
        let kept = frozen(&p).await;
        std::fs::write(&p, "x\n").unwrap();
        let (_h, got) = resume(&p, kept);
        tokio::time::sleep(Duration::from_millis(400)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { total: 1, .. }), "{ev:?}");
        assert_eq!(texts(&ev[0]), ["x"]);
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd src-tauri && cargo test --lib transcript::tail 2>&1 | tail -20`
Expected: compile errors (`resume_tail` not found, `parse_header` returns `Option<u64>`).

- [ ] **Step 3: Implement**

- The script, run as `sh -c <script> sh <path> <offset>`:

```sh
s=$(wc -c < "$1" 2>/dev/null | tr -d ' '); [ -n "$s" ] || s=0
if [ "$s" -ge "$2" ]; then o=$2; else o=0; fi
echo "$s $o"; tail -c +$((o+1)) -F "$1" & p=$!; cat >/dev/null; kill $p 2>/dev/null
```

- `read` takes the offset and passes it as the last argv.
- `State` on `Header(h)`:
  - `Some((size, start))` with `start < st.offset`, or `None` with `st.offset > 0`: the file is not the one the parser saw. Replace `st.parser` with `st.fresh.take()` (when present), clear `st.items`, set `st.offset = 0`.
  - `st.size = h.map(|(size, start)| size - start)`: the first-Reset rule compares `consumed` with the bytes left to read, unchanged otherwise.
- `spawn_tail` and `resume_tail` share one private starter taking `(parser, items, offset, fresh)`. `resume_tail` puts `kept.items` into the shared `items` before the parse thread starts.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib transcript 2>&1 | tail -5`
Expected: all pass, including `an_unreadable_header_falls_back_to_quiet` (its junk line still makes `total: 2`).

- [ ] **Step 5: Format and commit**

```bash
rustfmt --edition 2021 src-tauri/src/transcript/tail.rs src-tauri/src/transcript/mod.rs
git add src-tauri/src/transcript/tail.rs src-tauri/src/transcript/mod.rs
git commit -m "feat(chat): a frozen tail reads on from its offset, or from the start when the file shrank"
```

### Task 3: ChatManager keeps up to 8 Frozen tails

**Files:**
- Modify: `src-tauri/src/transcript/mod.rs` (`Tails`, `ChatManager`, tests)

**Interfaces:**
- Consumes: `TailHandle::freeze`, `FrozenSlot` (Task 1).
- Produces:
  - `pub const FROZEN_TAILS: usize = 8;`
  - `Tails.frozen: VecDeque<(PaneRef, Frozen)>`, oldest first, with `struct Frozen { path: String, located: Option<Located>, slot: FrozenSlot }`; at most one entry per `(pane, path)`.
  - `pub fn take_frozen(&self, pane: &PaneRef, path: &str) -> Option<FrozenSlot>` (removes it)
  - `pub fn frozen_located(&self, pane: &PaneRef, path: Option<&str>) -> Option<Located>`: the newest frozen entry of the Pane whose `located` is found (not pending) and, when `path` is given, equals it.
- Behaviour changes:
  - `close`: parked tails pushed out past `PARKED_TAILS` are frozen, not dropped.
  - `insert`: a previous open or parked tail of the Pane with **another** path is frozen; one with the same path is dropped as today. A frozen entry for the inserted `(pane, path)` is removed.
  - `reattach`: an entry for another path, or for this path whose tail is not running, is frozen (with its `located`) instead of dropped; it still returns false.
  - `close_machine`: removes the Machine's frozen entries too.

- [ ] **Step 1: Write the failing tests** in `mod.rs`'s `mod tests` (they use the existing `Echo`, `pane`, `recorder`, `open`, `located` helpers)

```rust
    /// Its stdin closes after 0.3 s, so the script kills `tail`, as an ssh drop ends it.
    struct Dies;
    #[async_trait::async_trait]
    impl crate::transport::Transport for Dies {
        fn wrap(&self, argv: &[String], _: bool) -> Vec<String> {
            let mut v: Vec<String> = vec!["sh".into(), "-c".into(), "sleep 0.3 | \"$@\"".into(), "sh".into()];
            v.extend(argv.iter().cloned());
            v
        }
        async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
        async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
    }
    const WAIT: std::time::Duration = std::time::Duration::from_millis(500);

    #[tokio::test]
    async fn a_fourth_park_freezes_the_oldest() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        let path: String = f.to_string_lossy().into();
        let chats = ChatManager::default();
        for id in ["p1", "p2", "p3", "p4"] {
            open(&chats, &pane(id), &f);
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            chats.close(&pane(id));
        }
        assert!(chats.take_frozen(&pane("p2"), &path).is_none(), "p2 is still parked");
        let kept = chats.take_frozen(&pane("p1"), &path).expect("p1 frozen").take(WAIT).expect("kept");
        assert_eq!((kept.offset, kept.items.len()), (4, 2));
        assert!(chats.take_frozen(&pane("p1"), &path).is_none(), "taken once");
    }

    #[tokio::test]
    async fn a_dead_tail_is_frozen_when_reopened() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        let path: String = f.to_string_lossy().into();
        let chats = ChatManager::default();
        let (sink, _) = recorder();
        chats.insert(pane("p1"), path.clone(), spawn_tail(Arc::new(Dies), path.clone(), Box::new(Echo), sink.clone()));
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        assert!(!chats.reattach(&pane("p1"), &path, sink));
        let kept = chats.take_frozen(&pane("p1"), &path).expect("frozen").take(WAIT).expect("kept");
        assert_eq!((kept.offset, kept.items.len()), (4, 2));
    }

    #[tokio::test]
    async fn another_transcript_on_the_pane_freezes_the_first_with_where_it_was_found() {
        let d = tempfile::tempdir().unwrap();
        let (f, g) = (d.path().join("f.jsonl"), d.path().join("g.jsonl"));
        std::fs::write(&f, "a\n").unwrap();
        std::fs::write(&g, "b\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.set_located(&pane("p1"), &located(&f, false));
        open(&chats, &pane("p1"), &g);
        let fp: String = f.to_string_lossy().into();
        assert_eq!(chats.frozen_located(&pane("p1"), Some(&fp)), Some(located(&f, false)));
        assert_eq!(chats.frozen_located(&pane("p1"), None), Some(located(&f, false)));
        assert_eq!(chats.frozen_located(&pane("p1"), Some("/other.jsonl")), None);
        assert_eq!(chats.frozen_located(&pane("p2"), None), None);
        assert!(chats.take_frozen(&pane("p1"), &fp).is_some());
    }

    #[tokio::test]
    async fn a_pending_location_is_not_reused_from_a_frozen_tail() {
        let d = tempfile::tempdir().unwrap();
        let (f, g) = (d.path().join("f.jsonl"), d.path().join("g.jsonl"));
        std::fs::write(&f, "").unwrap();
        std::fs::write(&g, "").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.set_located(&pane("p1"), &located(&f, true));
        open(&chats, &pane("p1"), &g);
        assert_eq!(chats.frozen_located(&pane("p1"), None), None);
    }

    #[tokio::test]
    async fn frozen_tails_past_eight_drop_the_oldest_and_go_with_their_machine() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let path: String = f.to_string_lossy().into();
        let chats = ChatManager::default();
        // 12 closes: 3 stay parked, 9 freeze, the first of them is dropped.
        for i in 0..12 {
            let p = pane(&format!("p{i}"));
            open(&chats, &p, &f);
            chats.close(&p);
        }
        assert!(chats.take_frozen(&pane("p0"), &path).is_none());
        assert!(chats.take_frozen(&pane("p1"), &path).is_some());
        chats.close_machine("a");
        assert!(chats.take_frozen(&pane("p2"), &path).is_none(), "close_machine clears frozen tails");
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd src-tauri && cargo test --lib transcript::tests 2>&1 | tail -20`
Expected: compile errors (`take_frozen`, `frozen_located` not found).

- [ ] **Step 3: Implement the methods and behaviour changes listed under Interfaces**

One private helper on `ChatManager`, `fn freeze_all(&self, gone: Vec<(PaneRef, Entry)>)`, freezes the entries (outside the lock), then pushes them under the lock, replacing any entry with the same `(pane, path)` and dropping the oldest past `FROZEN_TAILS`. `close`, `insert` and `reattach` route what they used to drop through it, except an `insert` of the same path.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd src-tauri && cargo test --lib transcript 2>&1 | tail -5`
Expected: all pass, including the existing parked-tail tests (`a_fourth_park_drops_the_oldest_and_other_paths_start_fresh` still holds: `reattach` never looks at frozen tails).

- [ ] **Step 5: Format and commit**

```bash
rustfmt --edition 2021 src-tauri/src/transcript/mod.rs
git add src-tauri/src/transcript/mod.rs
git commit -m "feat(chat): tails pushed out, cut off or replaced are kept frozen, up to 8"
```

### Task 4: chat_open resumes a Frozen tail and skips locating it

**Files:**
- Modify: `src-tauri/src/transcript/mod.rs` (new `ChatManager::open_tail`, tests)
- Modify: `src-tauri/src/commands.rs:556-596` (`chat_open`)

**Interfaces:**
- Consumes: `take_frozen`, `frozen_located` (Task 3); `resume_tail`, `spawn_tail` (Task 2); `FrozenSlot::take` (Task 1).
- Produces:
  - `pub const FREEZE_WAIT: Duration = Duration::from_millis(500);`
  - `pub async fn open_tail(&self, pane: &PaneRef, path: &str, t: Arc<dyn Transport>, parser: Box<dyn Parser>, sink: Sink)`: reattach when it can; else take the frozen slot for `(pane, path)`, wait for it with `FREEZE_WAIT` inside `tokio::task::spawn_blocking`, and `resume_tail` with `parser` as the fresh parser; else (no slot, or it stayed empty) `spawn_tail` with `parser`. Then `insert`.

- [ ] **Step 1: Write the failing tests** in `mod.rs`'s `mod tests`

```rust
    async fn open_via(chats: &ChatManager, p: &PaneRef, path: &std::path::Path) -> Arc<std::sync::Mutex<Vec<ChatEvent>>> {
        let (sink, got) = recorder();
        let t: Arc<dyn crate::transport::Transport> = Arc::new(crate::transport::local::LocalTransport);
        chats.open_tail(p, &path.to_string_lossy(), t, Box::new(Echo), sink).await;
        got
    }

    #[tokio::test]
    async fn reopening_a_frozen_tail_reads_only_what_was_added() {
        let d = tempfile::tempdir().unwrap();
        let (f, g) = (d.path().join("f.jsonl"), d.path().join("g.jsonl"));
        std::fs::write(&f, "a\nb\n").unwrap();
        std::fs::write(&g, "").unwrap();
        let chats = ChatManager::default();
        open_via(&chats, &pane("p1"), &f).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        open_via(&chats, &pane("p1"), &g).await; // freezes f
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(b"c\n").unwrap();
        let got = open_via(&chats, &pane("p1"), &f).await;
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { total: 3, .. }), "{ev:?}");
    }

    #[tokio::test]
    async fn an_empty_slot_falls_back_to_a_fresh_tail() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("f.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        let chats = ChatManager::default();
        let path: String = f.to_string_lossy().into();
        // A slot nobody fills: its parse thread panicked.
        chats.tails.lock().unwrap().frozen.push_back((pane("p1"), Frozen { path: path.clone(), located: None, slot: FrozenSlot::default() }));
        let start = std::time::Instant::now();
        let got = open_via(&chats, &pane("p1"), &f).await;
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert!(matches!(&got.lock().unwrap()[0], ChatEvent::Reset { total: 2, .. }));
    }
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd src-tauri && cargo test --lib transcript::tests 2>&1 | tail -20`
Expected: compile error (`open_tail` not found).

- [ ] **Step 3: Implement `open_tail`, then use it in `chat_open`**

`chat_open` after `reattach_cached` returned None:

```rust
    let (located, cached) = match chats.frozen_located(&pane_ref, path.as_deref()) {
        Some(l) => (l, true),
        None => (locate_pane(&mgr, &pane_ref, path).await?, false),
    };
```

then the transport and parser as today, `chats.open_tail(&pane_ref, &located.path, transport, parser, sink).await`, `chats.set_located(&pane_ref, &located)`, and `Ok(Located { cached, ..located })`. `cached: true` makes the lens locate again off the open's path, as after a cached reattach.

- [ ] **Step 4: Run all Rust tests and a build**

Run: `cd src-tauri && cargo test 2>&1 | tail -5 && cargo build 2>&1 | tail -2`
Expected: all tests pass, build finishes without warnings from the edited files.

- [ ] **Step 5: Format and commit**

```bash
rustfmt --edition 2021 src-tauri/src/transcript/mod.rs src-tauri/src/commands.rs
git add src-tauri/src/transcript/mod.rs src-tauri/src/commands.rs
git commit -m "feat(chat): reopening a chat resumes its frozen tail without locating it again"
```

### Task 5: Rows carry their first item's index; Reading positions and the restore rule

**Files:**
- Modify: `src/chat/workBlocks.ts` (`ChatRow`, `buildRows`)
- Modify: `src/chat/workBlocks.test.ts`
- Create: `src/chat/readingPosition.ts`
- Create: `src/chat/readingPosition.test.ts`

**Interfaces:**
- Produces:
  - `ChatRow` variants both get `at: number`: the absolute index of the row's first item (an item row: its item; a work row: its first work item).
  - In `readingPosition.ts`:
    - `export interface ReadingPosition { atBottom: boolean; item: number; delta: number; total: number }`
    - `export const READING_POSITIONS = 50;` `export const RESTORE_PAGES = 10;`
    - `export function savePosition(paneKey: string, path: string, p: ReadingPosition): void` (module-level `Map`, key `${paneKey}\n${path}`, re-inserted on save so the oldest is dropped past 50)
    - `export function savedPosition(paneKey: string, path: string): ReadingPosition | undefined`
    - `export type Restore = { kind: "bottom" } | { kind: "row"; item: number; delta: number; unseen: boolean } | { kind: "page"; before: number }`
    - `export function restoreTarget(saved: ReadingPosition | undefined, total: number, windowStart: number, pages: number): Restore`
    - `export function rowForItem(rows: readonly { at: number }[], item: number): number`: the last row whose `at <= item`, 0 when none.
    - `export function topVisible(rows: readonly { at: number }[], shown: readonly { index: number; start: number; end: number }[], scrollTop: number): { item: number; delta: number } | null`: the first virtual item with `end > scrollTop`; `delta = scrollTop - start`.

- [ ] **Step 1: Write the failing tests**

In `workBlocks.test.ts`, inside `describe("buildRows")`:

```ts
  it("gives each row the absolute index of its first item", () => {
    const rows = buildRows([user("1", "t1"), think("hm"), call("a"), say("done")], 5).rows;
    expect(rows.map((r) => [r.key, r.at])).toEqual([["i:5", 5], ["w:turn:t1", 6], ["i:8", 8]]);
  });
```

`src/chat/readingPosition.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { READING_POSITIONS, restoreTarget, rowForItem, savedPosition, savePosition, topVisible } from "./readingPosition";

const at = (item: number, total = 1000, delta = 0) => ({ atBottom: false, item, delta, total });

describe("restoreTarget", () => {
  it("goes to the bottom with nothing saved, when the user was at the bottom, or past the new end", () => {
    expect(restoreTarget(undefined, 1000, 500, 0)).toEqual({ kind: "bottom" });
    expect(restoreTarget({ ...at(600), atBottom: true }, 1000, 500, 0)).toEqual({ kind: "bottom" });
    expect(restoreTarget(at(1000), 1000, 500, 0)).toEqual({ kind: "bottom" });
  });

  it("goes to the saved row when it is loaded, flagging what arrived meanwhile", () => {
    expect(restoreTarget(at(600, 1000, 12), 1000, 500, 0)).toEqual({ kind: "row", item: 600, delta: 12, unseen: false });
    expect(restoreTarget(at(600, 900, 12), 1000, 500, 0)).toEqual({ kind: "row", item: 600, delta: 12, unseen: true });
  });

  it("pages older items in until the row is loaded, at most RESTORE_PAGES times", () => {
    expect(restoreTarget(at(100), 1000, 500, 0)).toEqual({ kind: "page", before: 500 });
    expect(restoreTarget(at(100), 1000, 300, 9)).toEqual({ kind: "page", before: 300 });
    expect(restoreTarget(at(100), 1000, 300, 10)).toEqual({ kind: "row", item: 300, delta: 0, unseen: false });
  });
});

describe("rowForItem", () => {
  it("finds the row holding the item", () => {
    const rows = [{ at: 5 }, { at: 6 }, { at: 9 }];
    expect(rowForItem(rows, 7)).toBe(1);
    expect(rowForItem(rows, 9)).toBe(2);
    expect(rowForItem(rows, 2)).toBe(0);
  });
});

describe("topVisible", () => {
  it("gives the first row reaching into the viewport and how far it is scrolled past", () => {
    const rows = [{ at: 5 }, { at: 6 }, { at: 9 }];
    const shown = [{ index: 0, start: 0, end: 100 }, { index: 1, start: 100, end: 250 }, { index: 2, start: 250, end: 300 }];
    expect(topVisible(rows, shown, 130)).toEqual({ item: 6, delta: 30 });
    expect(topVisible(rows, [], 0)).toBeNull();
  });
});

describe("savedPosition", () => {
  it("keeps one position per pane and transcript, dropping the oldest past the cap", () => {
    savePosition("k0", "/a", at(1));
    savePosition("k0", "/b", at(2));
    expect(savedPosition("k0", "/a")?.item).toBe(1);
    expect(savedPosition("k0", "/b")?.item).toBe(2);
    for (let i = 1; i <= READING_POSITIONS; i++) savePosition(`k${i}`, "/a", at(i));
    expect(savedPosition("k0", "/a")).toBeUndefined();
    expect(savedPosition(`k${READING_POSITIONS}`, "/a")?.item).toBe(READING_POSITIONS);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm vitest run src/chat/workBlocks.test.ts src/chat/readingPosition.test.ts`
Expected: FAIL (`readingPosition` module missing, `at` undefined).

- [ ] **Step 3: Add `at` in `buildRows` and write `readingPosition.ts` to the signatures above**

`restoreTarget` order: no saved or `atBottom` or `item >= total` → bottom; `item >= windowStart` → row (`unseen: total > saved.total`); `pages < RESTORE_PAGES` → page `{ before: windowStart }`; else row at `windowStart`, delta 0, `unseen` as above.

- [ ] **Step 4: Run the tests and the type check**

Run: `pnpm vitest run src/chat && pnpm typecheck`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/chat/workBlocks.ts src/chat/workBlocks.test.ts src/chat/readingPosition.ts src/chat/readingPosition.test.ts
git commit -m "feat(chat): reading positions per pane and transcript, and where to restore them"
```

### Task 6: The Chat lens saves and restores the Reading position

**Files:**
- Modify: `src/chat/ChatLens.tsx`
- Modify: `src/chat/ChatLens.test.tsx`

**Interfaces:**
- Consumes: `savePosition`, `savedPosition`, `restoreTarget`, `rowForItem`, `topVisible` (Task 5); `ChatRow.at` (Task 5); `chatPage` from `../lib/ipc`.

- [ ] **Step 1: Write the failing tests** in `ChatLens.test.tsx`, a new `describe("the reading position")` block (imports `chatPage` from `../lib/ipc`, `paneKey` from `../lib/types`, `savePosition`, `savedPosition` from `./readingPosition`)

```ts
  describe("the reading position", () => {
    const at = { agent: "claude", path: "/h/a.jsonl", ambiguous: false, candidates: ["/h/a.jsonl"], pending: false };
    const window = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ kind: "user", text: `m${from + i}` }));
    const reset = (from: number, total: number) =>
      act(() => channels[channels.length - 1].onmessage({ type: "reset", items: window(from, total), total }));
    beforeEach(() => vi.mocked(chatPage).mockClear());

    it("pages older items in to reach a row read before the window", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: false, item: 100, delta: 0, total: 1000 });
      opened = Promise.resolve(at);
      render(<ChatLens pane={pane} view={idlePi} />);
      reset(500, 1000);
      await waitFor(() => expect(chatPage).toHaveBeenCalledWith(pane, 500));
    });

    it("waits for the path when the reset comes first", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: false, item: 100, delta: 0, total: 1000 });
      let resolve!: (l: unknown) => void;
      opened = new Promise((r) => (resolve = r));
      render(<ChatLens pane={pane} view={idlePi} />);
      reset(500, 1000);
      expect(chatPage).not.toHaveBeenCalled();
      await act(async () => resolve(at));
      await waitFor(() => expect(chatPage).toHaveBeenCalledWith(pane, 500));
    });

    it("says there are new messages when the transcript grew while away", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: false, item: 600, delta: 0, total: 900 });
      opened = Promise.resolve(at);
      render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => {});
      reset(500, 1000);
      expect(await screen.findByText("New messages")).toBeTruthy();
      expect(chatPage).not.toHaveBeenCalled();
    });

    it("stays at the bottom for a reader who left from there, and remembers that on leaving", async () => {
      savePosition(paneKey(pane), at.path, { atBottom: true, item: 0, delta: 0, total: 900 });
      opened = Promise.resolve(at);
      const { unmount } = render(<ChatLens pane={pane} view={idlePi} />);
      await act(async () => {});
      reset(500, 1000);
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByText("New messages")).toBeNull();
      expect(chatPage).not.toHaveBeenCalled();
      unmount();
      expect(savedPosition(paneKey(pane), at.path)).toMatchObject({ atBottom: true, total: 1000 });
    });
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm vitest run src/chat/ChatLens.test.tsx`
Expected: the four new tests FAIL (no `chatPage` call, no "New messages", nothing saved).

- [ ] **Step 3: Implement in `ChatLens.tsx`**

- Refs: `pathRef` (the open's Transcript path: set from `(known ?? l).path` when `opened` resolves, null at each `open()`), `restoreArmed` (true at each `open()`), `restorePages` (0 at each `open()`).
- `saveReading()`: when `pathRef.current` and `loaded`, save `{ atBottom: true, item: 0, delta: 0, total }` if `atBottom.current`, else `{ atBottom: false, ...topVisible(rows, virt.getVirtualItems(), scrollTop), total }` (skip when `topVisible` is null). Call it in the `[key]` effect's cleanup before `handle.current?.close()`, and at the start of `open()` (it switches transcript); read `rows`/`state` through refs so the cleanup sees current values.
- Restore: a `useLayoutEffect` declared after the existing scroll effect, on `[loaded, located?.path, rows.length]`. It acts when `restoreArmed` and `loaded` and `pathRef.current` and `!located?.pending`:
  - `bottom`: disarm.
  - `page`: unless `loadingOlder` is set, set it, `chatPage(pane, before)`, dispatch `prepend` **without** setting `anchor`, `restorePages++`, clear `loadingOlder`; the effect runs again when `rows.length` changes. An empty or failed page disarms (a failure logs like `onScroll`).
  - `row`: disarm, `forceBottom.current = false`, `atBottom.current = false`, `virt.scrollToIndex(rowForItem(rows, item), { align: "start" })`, then `scrollTop += delta`; repeat both once in `requestAnimationFrame`. `setUnseen(true)` when `unseen`.
- Later `reset`s of the same open keep today's scroll-to-bottom.

- [ ] **Step 4: Run the whole frontend suite and the type check**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/chat/ChatLens.tsx src/chat/ChatLens.test.tsx
git commit -m "feat(chat): reopening a chat returns to where it was being read"
```
