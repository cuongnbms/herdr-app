# Render/emit (PR 4 of the perf/security review)

Goal: a status or structure update for one Machine re-renders only what changed; an unchanged
view is neither emitted nor serialized. Behaviour is unchanged.

Branch `render-emit` (worktree `.worktrees/render-emit`) from `dev` at `d5ee5ca`; merges back
into `dev`. PR 5 (Connection) may run in parallel: do not edit the supervise loop body, keep
`find_pane`'s signature, leave `useTranscriptProbe`'s internals alone.

## Decisions (settled with the user)

- Structural sharing: a small generic in-repo helper `shareEqual(prev, next)`, no dependency.
- Rust dedupe in two layers: the watcher skips a refetched `View` equal to the last one it sent;
  `emit_now` skips a `MachineView` equal to the last one emitted for that Machine (entry dropped
  on remove). The frontend loads with `machines_list`, so a reload never depends on a re-emit.
- `writeDraft` debounced 300 ms, flushed on unmount, on pane-key change and on `pagehide`.

## Measurement (before and after, same script)

- Rust: `emits_only_changed_views` in `machines.rs` tests. Connect `local` over `FakeHerdr`,
  settle, then 5 × `pane.rename` (each refetches an unchanged snapshot, spaced past the 150 ms
  watcher debounce and the 100 ms throttle), then one real status change. Count
  `UiEvent::Machine`.
- Frontend: `src/renders.test.tsx`. Render `App` with tauri mocked; count renders of App (via
  the mocked `useTranscriptProbe`, called once per App render), Sidebar, AgentList and ChatLens
  (module mocks that wrap the real component and keep its `memo`). Script of `upsertMachine`
  calls: 3 × identical view (fresh objects), 1 × other pane's status, 1 × selected pane's
  status, 1 × new tab.

## Tasks (TDD each)

1. Measurement tests on unchanged code; record baseline below.
2. A. `watcher.rs` refetch dedupe; `emit_now` last-emitted dedupe (+ clear in `remove`).
   Note: the supervise loop resets `attempt` on each `View`; the first view after a (re)connect
   is always sent, so backoff reset is unaffected.
3. B. `src/store/share.ts` `shareEqual`; `upsertMachine` stores `shareEqual(prev, v)`.
4. C. App reads a narrow selection (ids + selected pane), `ref` via `useMemo` on the three ids;
   `memo` on Sidebar, AgentList, Settings, Header.
5. D. `WorkBlockView` gets `id`/`open` and calls `onToggle(id, open)`; ChatLens passes `toggle`.
6. E. `pruneFolders` returns early when the workspace-id set equals `previous`'s (first
   snapshot still prunes).
7. F. `find_pane` looks the pane up inside the manager lock without cloning every view.
8. G. `rankFiles` in `useMemo`; `writeDraft` debounced with flushes.
9. Re-measure; `pnpm test`, `pnpm typecheck`, `cargo test`, `pnpm tauri build --debug --no-bundle`.

## Results

Both scripts are deterministic (same numbers on repeated runs).

Rust, `emits_only_changed_views` (5 unchanged refetches, then 1 status change):

| Measure | Before | After |
|---|---|---|
| `UiEvent::Machine` emits | 6 | 1 |

Frontend, `src/renders.test.tsx`, renders per step as App / Sidebar / AgentList / ChatLens:

| Step | Before | After |
|---|---|---|
| identical view (×3, per step) | 1 / 1 / 1 / 1 | 0 / 0 / 0 / 0 |
| other pane's status | 1 / 1 / 1 / 1 | 0 / 1 / 1 / 0 |
| selected pane's status | 1 / 1 / 1 / 1 | 1 / 1 / 1 / 1 |
| new tab elsewhere | 1 / 1 / 1 / 1 | 0 / 1 / 1 / 0 |
| total over the script | 24 | 8 |

Not measured: how often herdr fires these events in practice, and the renders below ChatLens
(work blocks keep their `memo` now that `onToggle` is stable; covered by the `WorkBlockView`
test, not counted). Header still re-renders on any change to the selected Machine (it reads
labels from every level); it is no longer re-rendered by App.

Deviation from the agreed design: an emptied draft (just sent) is removed at once rather than
after the debounce, so a send followed by a quit never brings the sent text back.
