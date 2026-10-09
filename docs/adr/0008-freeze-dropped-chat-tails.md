# 0008: Freeze dropped chat tails and read on from their offset, accepting that older images are gone

> Status: Accepted · Date: 2026-10-09

## Context

Parked tails (ADR [0004](./0004-park-chat-tails.md)) make a switch back instant for the last 3
Chat lenses. A fourth one drops the oldest, and an ssh drop kills every tail of the Machine. In
both cases the next open reads the whole Transcript from byte 0 again, although the dropped tail
had parsed it correctly up to where it stopped.

Source: [design spec](../superpowers/specs/2026-10-09-chat-resume-design.md)

## Decision

A tail that stops keeps its path, parser, items and the byte offset of the last complete line it
parsed, as a Frozen tail, with no process and no images. Up to 8 are kept, oldest dropped first.
Opening that Pane and Transcript again starts `tail -c +<offset+1>` and feeds the same parser,
or reads from byte 0 with a fresh parser when the file is now shorter than the offset.

This removes the full re-read for both Claude and pi, after eviction and after an ssh drop alike,
without the idle processes and ssh channels that more parked tails would hold.

## Consequences

- Images older than a Frozen tail's offset show "Image unavailable" after a resume; only images
  from the offset on are decoded again.
- Frozen items cost memory (text only, tens of MiB for 8 large Transcripts).
- A file rewritten in place to the same or a greater length is not detected; Agents only append.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| Raise `PARKED_TAILS` | Each parked tail keeps a remote `tail`, an `ssh` process and a channel; an ssh drop still re-reads everything. |
| Keep the images of Frozen tails | 8 × 16 MiB more memory for pictures in scrolled-past history. |
| Cache parsed Transcripts on disk | Not needed while positions are kept for the app's run only; adds invalidation against a file on another Machine. |
