# Chat lens loading: fast first Reset, parked tails, bounded webview

Date: 2026-10-03
Status: draft

## Purpose

Opening a Chat lens, and switching between Chat panes, should be fast for large Transcripts,
locally and over SSH. Today:

- **A.** The first `Reset` is decided by a timer: `tail.rs` treats the backlog as caught up 300 ms
  after spawn or after one quiet 50 ms tick. Over SSH this often fires with 0 items, and the
  whole backlog then streams to the webview as `Append` batches.
- **B.** The webview never trims. Each `Append` copies the whole item array, rebuilds every row
  (`buildRows`) and scrolls.
- **C.** Every open re-reads the Transcript from byte 0 (`tail -n +1 -F`), and the lens closes the
  tail on unmount. Switching panes re-downloads, re-parses and re-decodes images.
- **D.** Parsing runs on a tokio worker and holds the image store's `std::sync::Mutex` for a whole
  `push_line` (serde_json on lines up to 32 MiB, base64 decoding). `chat_image` waits on it.
- **E.** Tool-call `input` is never truncated. Only results are capped (16 KiB).
- **F.** The virtualizer has no `getItemKey`. Measured sizes stick to indexes, so after a prepend
  rows get the wrong heights and scroll jumps.
- **G.** `MermaidBlock` does not cache its SVG. A diagram re-renders, and its row changes height,
  every time the row scrolls back into view.

This is PR 2 of 5 from the performance and security review
(`tmp/handoffs/2026-10-03-perf-security-review.md`, items #3, #5, #10 and two P2 items).

## Scope

In: A–G above.

Out:

- The inline `onToggle` and the render cascade; the `find_pane` clone (PR 4).
- `chat_locate` probing; `locate_pane` still runs on every open (PR 5).
- Starting a Claude tail near the end of the file and reading older pages by byte range.

## Invariants kept

- JS items are always a suffix of the Rust `TailHandle.items`. Paging uses
  `before = total - items.length` and `chat_page` → `TailHandle::page`.
- Parsers may emit `Reset` mid-stream (pi branch change). The tail handles it as today.
- pi needs the whole file (tree from parent ids, TOO_LARGE limit). Every tail still reads from
  byte 0; only re-reads on reopen go away.
- The remote command kills `tail` when its stdin reaches EOF.
- The Edit/Write diff view keeps every field of a tool input.

## Design

### C. Parked tails

A **Parked tail** is the tail of a Chat lens that was closed: it keeps running and following the
Transcript, but sends no events. ADR [0004](../../adr/0004-park-chat-tails.md) records the
decision.

`ChatManager` keeps two maps: open tails by `PaneRef`, and parked tails by `PaneRef` in
least-recently-parked order.

- `chat_close` moves the Pane's tail from open to parked. If more than **3** are parked, the
  oldest is dropped, which kills its `tail` as today. Open tails do not count toward the 3.
- `chat_open` still runs `locate_pane`. If a parked tail exists for the same `PaneRef` **and** the
  same path, and its tasks are still running, it is reattached: it moves back to open and gets the
  new Channel as its sink (see "Reattach" below). Otherwise any parked tail of that Pane is
  dropped and a new tail is spawned.
- A parked tail whose process exited (ssh dropped, file gone) is found on reattach by its finished
  task, dropped, and replaced with a new one.
- `close_machine` drops parked tails of the Machine too.
- `chat_page` and `chat_image` look only at open tails, as today.

**Swappable sink.** `TailHandle` and the tail's `State` share an `Arc<Mutex<Option<Sink>>>`.
`None` while parked: events are dropped, but `items`, the image store and the parser (including
pi's branch tree) keep updating.

**Reattach.** Under the parse thread's state, in order:

1. drop queued `events` and `appended`;
2. set the new sink;
3. send `Reset` with the last 500 items and `total`;
4. reset `last_meta` to default and send `Meta` if the parser has one.

If the first `Reset` of this tail has not been sent yet (parked mid-backlog), the reattach does
nothing extra: the normal first-Reset rule (A) still sends it to the new sink. Reattach is a
message to the parse thread (`Msg::Attach(Sink)`), so it serialises with lines and ticks and needs
no extra lock on `State`.

**Image budget.** The open tail's store keeps 64 MiB. On park the store's budget drops to
**16 MiB**, evicting oldest images first, and stays there while parked. Reattach restores 64 MiB.
With one open lens the ceiling is 64 + 3 × 16 = 112 MiB. `ImageStore` gets `set_budget(usize)`,
which evicts down to the new budget.

**SSH cost.** Tails share the Machine's ControlMaster (ADR 0001), so a parked remote tail is one
`ssh` process, one channel on the existing connection and one remote `tail`; no new connection.

**Frontend.** No change for C. `revokeChatImages` on unmount stays; the reattach `Reset` bumps
`opened`, so thumbnails fetch again from the store.

### A. First Reset by byte count

The remote script prints the file size first:

```sh
wc -c < "$1" 2>/dev/null || echo 0; tail -c +1 -F "$1" & p=$!; cat >/dev/null; kill $p 2>/dev/null
```

- The reader reads the first stdout line as the header: trim (BSD `wc` pads with spaces), parse
  `u64`. A missing file prints `0`. An unparsable header counts as unknown size.
- After the header, the reader counts **raw bytes** read from stdout: newlines, `\r`, and lines
  dropped for exceeding `MAX_LINE` all count.
- The first `Reset` is sent at the first flush where `consumed >= size`, even mid-line. A last line
  that had no `\n` when `wc` ran arrives later as an `Append`.
- `size == 0` sends an empty `Reset` at the first flush.
- **Safety net:** if no byte has arrived for **2 s** (counted from spawn, or from the last byte),
  the first `Reset` is sent with what has been parsed. This covers a file truncated or replaced
  between `wc` and `tail`, a bad header, and a stalled ssh. It is inactivity-based, so a large file
  still downloading over ssh is not cut off.
- Bytes appended between `wc` and `tail` arrive as `Append`, as any live line.
- The 300 ms `INITIAL_CAP` and the "quiet tick" rule go away.

### D. Parsing off the tokio workers

The tail splits into two halves:

- **Reader** (tokio task): spawns the process, reads the header, splits lines, applies `MAX_LINE`,
  counts bytes, and owns the 50 ms interval. It sends
  `Msg::{Header(Option<u64>), Line(Vec<u8>), Bytes(usize), Tick, Eof}` over a bounded
  `tokio::sync::mpsc` channel (capacity 16; `send().await` gives backpressure).
- **Parse thread** (one `std::thread` per tail, named `chat-parse`): owns `State`, loops on
  `blocking_recv()`, runs `push_line`, `flush` and the sink. It also receives `Msg::Attach`.
  When the channel closes (the handle dropped and aborted the reader) the thread ends.
- `Eof` flushes and sends the existing "transcript tail exited" error.

`push_line` writes images into a local `Vec<(String, String, Vec<u8>)>` (the existing
`ImageSink` impl). The store is locked only to insert them. `chat_image` no longer waits for a
parse. The comment in `ChatManager::image` about the lock being held during a parse is updated.

`TailHandle` holds the reader's `JoinHandle` (aborted on drop, as today), the message sender
(for `Attach`), and the shared `items`, `images` and sink. "Still running" for reattach means the
reader task has not finished.

### B. Trimming in the webview

- `channel.onmessage` dispatches `append` with `atBottom: atBottom.current`. The reducer stays
  pure.
- In `reduce`, after appending: if `atBottom` and the item count exceeds **2000**, keep the last
  **1000**. One action, so `buildRows` runs once.
- `total` is unchanged, so `before = total - items.length` stays correct and paging still loads the
  trimmed items back.
- While the user reads older rows (`atBottom` false) nothing is trimmed.
- After a trim at the bottom the layout effect's `grew` may be false and `anchor` stays `null`;
  the `ResizeObserver` keeps the view pinned to the bottom.

### E. Capping tool input

`cap_input(serde_json::Value) -> Value` in `transcript/mod.rs` walks objects and arrays and
truncates every string longer than **64 KiB** on a char boundary with `"\n… (truncated)"`,
sharing the cut helper with `truncate_result`. No field is dropped, so `edits[].old_string`
and `new_string` are each capped. Claude (`claude.rs`) and pi (`pi.rs`) compute `input_summary`
from the full input first, then cap. TS types do not change.

### F. Stable row keys

`buildRows(items, offset)` takes `offset = total - items.length`. Each row gets a `key`:

- a work block: `block.id` (already stable by turn);
- an item row: `i:<absolute item index>`.

`useVirtualizer` gets `getItemKey: (i) => rows[i].key`. A prepend or a trim keeps every surviving
row's key, so measured sizes stay with their rows.

### G. Cached Mermaid SVG

A module-level LRU `Map` of 50 entries, keyed `theme + "\n" + source`, holds the SVG after
`stripImages`. On mount, a cached SVG initialises state directly: no timer, no render, no height
change. A fresh render stores its result.

## Error handling

- Header missing or garbage → unknown size; the 2 s inactivity rule sends the first `Reset`.
- Reader ends (process exit, ssh drop) → `Eof` → "transcript tail exited" error to the sink, or
  dropped if parked. A parked dead tail is replaced on the next open.
- Parse thread panics → the channel closes, the reader's `send` fails and the reader exits.

## Testing

Rust, driving a real `tail` through `LocalTransport` and a tempfile, like the existing tail tests:

- A file of N lines: the first event is a `Reset` with N items; no `Append` before it.
- A missing file: an empty `Reset` within 1 s; lines written later arrive as `Append`.
- A file without a trailing `\n`: `Reset`, then an `Append` once the line completes.
- A garbage header (unit test of header parsing and the 2 s rule with a fake clock or short
  constant): `Reset` arrives through the inactivity rule.
- D: a parser blocked on a barrier inside `push_line`; `images().try_lock()` succeeds meanwhile.
- C: close then open the same Pane and path → one `Reset` from the existing items, no new process;
  a different path → new tail; a fourth park evicts the oldest; `close_machine` drops parked
  tails; a parked tail whose task ended is replaced.
- `ImageStore::set_budget` evicts oldest first down to the budget.
- E: a Write with 1 MiB `content` is capped with the marker and its summary is unchanged; a
  multi-byte char at the cut; nested `edits`.

TypeScript (vitest):

- `reduce`: trim at the bottom over 2000 keeps the last 1000 and `total`; no trim when not at the
  bottom; `prepend` after a trim lines up.
- `buildRows`: keys survive a prepend and a trim.
- `MermaidBlock`: a second mount with the same source and theme does not call `mermaid.render`.

## Measurement

Before any code change, on `dev`, and again on this branch:

- `tmp/chat-bench/gen.py` generates a Claude and a pi Transcript, about 50 MB and 20k items
  each, with about 20 base64 images of ~500 KB and a few Write/Edit inputs of ~1 MB. Record
  shapes come from the parser test fixtures. No real Transcripts are read.
- A temporary `tracing` patch in `tail.rs`, not committed, logs: time from spawn to the first
  `Reset`, items in it, and `Append` events and items until 1 s of quiet; after the change also
  the time to reattach a parked tail.
- Run locally, then over the `devtuf` Machine with the files copied there (`scp`), opening them
  through the TranscriptPicker.

Done means `pnpm test`, `pnpm typecheck` and `cargo test` pass, the numbers above exist before and
after, and a manual check finds no regression in older paging, a pi branch switch, images, live
appends, Edit/Write diffs, and switching between four Chat panes.
