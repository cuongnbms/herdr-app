# Terminal lifecycle (PR 3 of the perf/security review)

Source: `tmp/handoffs/2026-10-03-terminal-lifecycle.md`. Approved decisions: dispose at once
when hidden, a per-key open lock, `connect_ack`, and no change to `ACK_THRESHOLD`.

## A. Free a cached xterm when its open ends (`src/terminal/TerminalLens.tsx`)
- Each `open()` sets `latest = { closed, token }`. `exited`/`held`/`detached` mark it closed.
- On an ending event: dispose now via `disposeIf(cacheKey, token)` if the effect is no longer
  live, or always for `detached`. If the pane is visible, keep the xterm for the banner.
- On effect cleanup: if `latest.closed`, run `disposeIf` in a `setTimeout(0)`. A Reattach
  (generation bump) re-claims the key in the same React flush, so the deferred dispose is a
  no-op and the scrollback survives. A real hide or unmount disposes.
- The decision is a pure function in `src/terminal/lensState.ts`.
- Tests: unit tests for the decision. A TerminalLens component test (mocked ipc + xterm)
  covers four cases:
  - exit while hidden → cache size back to baseline
  - held while hidden → back to baseline
  - exit then Reattach → same xterm
  - held then Take over → same xterm

## B. Do openpty/spawn outside the global `entries` lock (`src-tauri/src/attach.rs`)
- `opening: Mutex<HashMap<AttachKey, Arc<Mutex<()>>>>`. `open`, `release`, `close` and
  `write` hold the key's lock, so same-key operations keep today's order. `ack`, `resize`
  and other keys never wait on a spawn.
- `open_async`, `release_async`, `close_async` run on `spawn_blocking`. `term_open`,
  `connect_open`, `term_release` and `connect_close` await them.
- Tests (real PTYs):
  - while key X's lock is held, `write`/`ack` on Y still return
  - concurrent opens of one key spawn once
  - a release queued behind an in-flight open still detaches

## C. Ack the Connect dialog's output
- `connect_ack(machine_id, bytes)` → `att.ack(master_key)`; register it in `lib.rs`.
- Add `connectAck` in `src/lib/ipc.ts`. `ConnectDialog` acks through `createAckBatcher` in
  `term.write`'s callback.
- Test: ConnectDialog component test asserts output gets acked.

## D. Dropped
`ACK_THRESHOLD` stays at 64 KiB.

## Verify
`pnpm test`, `pnpm typecheck`, `cargo test` (src-tauri), `pnpm tauri build --debug --no-bundle`.
Do not launch the app. Ask the user to check by hand: exit while hidden, reattach after an
exit, take over a held pane.
