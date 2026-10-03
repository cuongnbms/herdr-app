# Cached xterm leaked when its attach exited or was held

**Symptom**: A terminal pane's xterm (5000-line scrollback, plus font and theme watchers
that keep calling `clearTextureAtlas` on every theme change) stayed in `termCache` forever
when its process exited, or its attach was held, while the pane was hidden or unmounted.
Found in a code review, not seen in the app.

**Root Cause**: `TerminalLens` freed the cached xterm only on the `detached` event. The
backend never sends `detached` after a child exit: the exit watcher removes the entry and
emits `Exited`, so the later `term_release` finds no entry and `detach()` returns early
because `closed` is already set. A held attach whose child then exits ends the same way,
with no event at all. Only ssh exit 255 was safe, because `ChannelSink` maps it to
`Detached`.

**Fix**: Every event except `attached` ends the open that received it
(`endsOpen`/`disposesOnEvent` in `src/terminal/lensState.ts`). A hidden pane frees the
xterm at once. A visible one keeps it for its banner, and the effect cleanup frees it if
the latest open has ended. Two traps showed up while fixing it:

- **The cleanup cannot tell Reattach from unmount.** A Reattach bumps `lens.generation`,
  which runs the old effect's cleanup first, while the open has already ended. Disposing
  there synchronously would throw away the scrollback Reattach is meant to keep. The
  dispose is deferred with `setTimeout(0)` and goes through `disposeIf(cacheKey, token)`.
  React runs the new effect's setup in the same flush, and its `claim()` changes the
  token, so the deferred dispose does nothing.
- **`held` arrives before the output that carries it.** The reader emits `Held` as soon
  as it sees the marker, then sends the chunk that contains it. Dropping output once the
  open "ended" would hide the refusal message. Only `detached` drops output.

Tests: `src/terminal/TerminalLens.test.tsx` covers exit or held while hidden, exit then
hide, Reattach, Take over, and output after held.

**Lesson**: When the backend can end an attach in several ways, list every way it ends
and check that the frontend frees resources on each. Do not rely on one terminal event.
In a React effect, a cleanup that frees a shared cached resource must allow for the same
effect being set up again in the same flush.
