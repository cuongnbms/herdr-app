# 0004: Park closed chat tails instead of killing them, accepting idle remote processes

> Status: Accepted · Date: 2026-10-03

## Context

Closing a Chat lens killed its tail, and opening it again ran `tail -n +1 -F` from byte 0. For a
large Transcript, switching between Chat panes therefore re-downloaded the whole file over SSH,
re-parsed it and re-decoded its images every time.

Starting near the end of the file would avoid the download for Claude, but pi rebuilds a tree from
parent ids and needs the whole file, and older pages would then need byte-range reads.

Source: [design spec](../superpowers/specs/2026-10-03-chat-loading-design.md)

## Decision

A closed Chat lens parks its tail: the tail keeps following the Transcript and keeps its items,
parser state and images, but sends no events. Up to 3 tails stay parked per app, the oldest dropped
first. Opening the same Pane and Transcript again reattaches the parked tail and sends one `Reset`
from what it already holds.

Parking makes a switch back instant for both Claude and pi without changing how a tail reads, which
start-near-end could only do for Claude.

## Consequences

- Up to 3 extra `tail` processes run per app. A remote one also keeps an `ssh` process and a channel
  on the Machine's ControlMaster open after its lens closed.
- A parked tail's image store shrinks to 16 MiB (ADR [0003](./0003-chat-images-kept-from-the-tail.md)).
  With one open lens, images use at most 112 MiB.
- A parked tail whose process died (ssh drop) is replaced by a new tail on the next open.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| Start Claude tails near the end of the file | Does not help pi, and older pages would need byte-range reads on the Machine. |
| Keep killing tails, rely on a faster first Reset | Every switch still re-downloads and re-parses the whole Transcript. |
| Park 5 tails | More idle ssh channels and remote processes, and more image memory, for switches between more than 3 panes, which are rare. |
