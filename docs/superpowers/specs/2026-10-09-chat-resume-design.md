# Chat resume: frozen tails read on from their offset, reading position kept

Date: 2026-10-09
Status: draft

## Purpose

Coming back to a Chat lens should feel instant and put the reader where they left off. Today:

- **A.** Only 3 tails stay parked (ADR [0004](../../adr/0004-park-chat-tails.md)). Visiting a fourth
  Chat pane drops the oldest, and reopening it reads the whole Transcript from byte 0 again,
  over SSH for a remote Machine.
- **B.** A tail whose process died (ssh drop) is dropped on reopen and replaced with one that
  reads from byte 0, although its items and parser state were fine up to where it stopped.
- **C.** Every `Reset` scrolls to the bottom (`forceBottom` in `ChatLens.tsx`), including the
  one sent when a parked tail is reattached. The place the user was reading is lost on every
  switch between panes.

## Scope

In: A–C.

Out:

- Keeping the Reading position across app restarts (memory only, by choice).
- Keeping images of a Frozen tail. Images older than its offset show "Image unavailable".
- Changing `PARKED_TAILS` (stays 3), the image budgets, or how a Transcript is located.
- A Transcript the Agent replaced with a new file (`/clear`, a new session): the new file is
  still read from byte 0. It is usually small.

## Invariants kept

- JS items are a suffix of the Rust tail's items; paging uses `before = total - items.length`.
- Parsers may emit `Reset` mid-stream (pi branch change), handled as today.
- pi needs every line of the file once, in order: a resumed parser has seen bytes `[0, offset)`
  and is fed `[offset, …)`, so this holds.
- The remote command kills `tail` when its stdin reaches EOF.
- `close_machine` (explicit disconnect or removal) forgets every tail of the Machine.

## Design

### 1. Frozen tails (backend)

A **Frozen tail** is what remains of a tail that stopped: its path, parser, items and offset,
with no process, no channel and no images.

**Offset.** The parse thread counts the bytes of **complete lines** it was given: each line's
raw length plus its `\n`, lines dropped for exceeding `MAX_LINE` included. A line still being
read when the tail stops is not counted, so it is read again whole on resume.

`Msg::Line` carries the raw byte count of the line (with `\r` and `\n`), and a dropped line is
sent as `Msg::Skipped(len)` so the parse thread counts it without parsing it.

**Getting the state back.** `parse_loop` owns `State` today and drops it on exit. It now ends
by moving `parser`, the items and the offset into a slot shared with `TailHandle`:

```rust
pub struct Frozen { path: String, agent: String, located: Option<Located>, parser: Box<dyn Parser>, items: Vec<ChatItem>, offset: u64 }
// TailHandle gets: frozen: Arc<Mutex<Option<Frozen>>>, plus a Condvar to wait on it.
```

The parse thread exits on `Eof` (process died, ssh dropped) and when its channel closes (the
handle dropped and aborted the reader). Both fill the slot. A panic leaves it empty.

`TailHandle::freeze(self) -> Option<Frozen>` aborts the reader and waits up to **500 ms** for the
slot. `None` past that (a long line still parsing): the tail is lost and the next open reads
from byte 0, as today.

**ChatManager.** It gets a third list, `frozen: VecDeque<(PaneRef, Frozen)>`, oldest first,
capped at **`FROZEN_TAILS = 8`**. Entries are keyed by Pane and path: one Pane can have a frozen
tail for each Transcript it showed.

- A parked tail pushed out past `PARKED_TAILS` is frozen instead of dropped.
- `insert` freezes the Pane's previous tail when its path differs, instead of dropping it.
- `reattach` finding a tail of the right path that is not running freezes it and returns false;
  `chat_open` then resumes.
- `chat_open`, when nothing live can be reattached, takes the frozen entry for `(pane, path)`
  if there is one and calls `spawn_tail(…, resume: Some(frozen))`.
- `reattach_cached` also matches a frozen entry whose `located` was found (not pending), so a
  resume skips `locate_pane` the way a reattach does; the lens then locates again off the open's
  path, as it already does after a cached reattach.
- `close_machine` removes frozen entries of the Machine too.

**Reading on.** The remote script takes the offset as `$2`:

```sh
s=$(wc -c < "$1" 2>/dev/null || echo 0)
if [ "$s" -ge "$2" ]; then o=$2; else o=0; fi
echo "$s $o"
tail -c +$((o+1)) -F "$1" & p=$!; cat >/dev/null; kill $p 2>/dev/null
```

- The header is now `size start`. A fresh tail passes `0`, so it behaves as today.
- `start == offset`: the parser and items carry on. The backlog for the first `Reset` is
  `size - start` bytes, so `caught_up` compares `consumed >= size - start`.
- `start == 0` while `offset > 0`: the file shrank (truncated or replaced). The items are
  cleared and the parser is replaced by a fresh `parser_for(agent)`; reading goes on from byte 0.
  `spawn_tail` therefore takes the agent, not a built parser, when resuming.
- A header that does not parse as two numbers counts as unknown size and `start = 0`, and a
  resumed tail then reads from byte 0 with a fresh parser, as for a shrunk file.

The first `Reset` after a resume holds every kept item plus the backlog, sent by the same rule
as a fresh tail's first `Reset`. The image store starts empty with the open budget.

**Memory.** Frozen items are text, with results capped at 16 KiB and tool inputs at 64 KiB per
string. Eight Transcripts of a few thousand items each come to tens of MiB, and no images.

### 2. Reading position (frontend)

A **Reading position** is where the user was in a Chat lens's Transcript when it closed.

`src/chat/readingPosition.ts` keeps a module-level map, like `rememberedTranscript`:

```ts
interface ReadingPosition { atBottom: boolean; item: number; delta: number; total: number }
// key: `${paneKey(pane)}\n${path}`, at most 50 entries, oldest dropped first.
```

- `item`: the absolute index of the first item of the top visible row. An item row's key is
  `i:<abs>`; a work row uses `block.start`, already absolute.
- `delta`: pixels from that row's top to the viewport's top (≥ 0).
- `total`: `state.total` when saved.

**Save.** In the `[key]` effect's cleanup, before `handle.current?.close()`, and in `open()`
before it switches to another path, when a path was loaded and at least one `Reset` arrived.

**Restore.** Only at the first `Reset` of an open for which a position is saved:

```ts
type Restore =
  | { kind: "bottom" }
  | { kind: "row"; item: number; delta: number; unseen: boolean }
  | { kind: "page"; before: number };   // load older items, then decide again
function restoreTarget(saved: ReadingPosition | undefined, total: number, windowStart: number): Restore
```

- No position, `atBottom`, or `item >= total` (pi switched branch, the file was replaced):
  `bottom`, as today.
- `item >= windowStart`: `row`. `unseen` is `total > saved.total`.
- `item < windowStart`: `page` with `before = windowStart`. After the prepend, decide again. At
  most **10** pages (5000 items); past that, `row` at `windowStart`.

For `row`, `ChatLens` clears `forceBottom`, sets `atBottom.current = false`, scrolls the row's
index to `align: "start"`, adds `delta` to `scrollTop`, and repeats once on the next animation
frame after the virtualizer measured the rows. `unseen` shows the existing jump-to-bottom button.

Later `Reset`s of the same open (pi branch switches) scroll to the bottom as today. A failed
`chatPage` during restore stops at what is loaded and logs as `onScroll` does.

## Error handling

- The parse thread did not fill the slot within 500 ms, or panicked: spawn from byte 0.
- A Frozen tail's resume fails to spawn: the error reaches the lens as today; the frozen entry
  is gone (taken), so the next open starts from byte 0.
- The frozen entry's Machine reconnected under a new transport: resume uses the current
  `mgr.transport(machine_id)`, as a fresh spawn does.

## Testing

Rust (`transcript/mod.rs`, `transcript/tail.rs`, local transport, temp files):

- A fourth park freezes the oldest; reopening it resumes from its offset (the script is run with
  that offset), and the first `Reset` holds the old items and the bytes appended meanwhile.
- A tail whose process died is resumed on reopen with its items intact.
- A line half-written when the tail stopped is read whole on resume, not doubled.
- A file truncated below the offset resumes as a fresh read: the `Reset` holds only new items.
- More than `FROZEN_TAILS` frozen: the oldest goes. `close_machine` clears frozen entries.
- pi: an entry appended after a resume attaches to its parent from before the freeze.
- `insert` with another path freezes the previous tail; returning to the first path resumes it.

Frontend (vitest):

- `restoreTarget`: every branch above, including the 10-page limit.
- `ChatLens`: switch away and back; the first `Reset` restores the saved row instead of the
  bottom, and the jump-to-bottom button shows when items were added meanwhile.

## Documentation

- ADR [0008](../../adr/0008-freeze-dropped-chat-tails.md): freeze dropped tails and read on from
  the offset, accepting that their older images are gone.
- ADR 0003 and 0004: an Update section pointing to 0008.
- `CONTEXT.md`: **Frozen tail**, **Reading position**.
