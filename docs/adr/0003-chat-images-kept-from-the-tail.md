# 0003: Keep Transcript images in memory from the tail instead of re-reading them on the Machine

> Status: Accepted · Date: 2026-10-03

## Context

The Chat lens shows images that the Transcript stores inline as base64:

- the screenshots a user pasted;
- the pictures a pi tool read.

The Transcript lives on the Pane's Machine, local or remote over SSH.

herdr-web-ui sends only an image ref with the conversation. It serves the bytes on request by
re-reading the Transcript and finding the record again.

This app is different: it already streams every Transcript line to this Mac with `tail -F`
through the transport and parses it here. So each image's bytes have already passed through
the parser by the time the image is shown.

Source: [design spec](../superpowers/specs/2026-10-03-chat-transcript-extras-design.md)

## Decision

The parser decodes each image as its line arrives and keeps the bytes in a per-tail store with
a budget of 64 MiB, evicting the oldest images first. Chat items carry only a ref and a media
type. The webview asks for the bytes by ref with a `chat_image` command, and the store is freed
with the tail.

## Consequences

- An image appears without a second round trip to a remote Machine.
- Memory grows with the images of each open chat, up to the budget.
- An image evicted from the store shows as "Image unavailable" until the chat is reopened.
- The tail's line limit had to rise from 8 MiB to 32 MiB, because a pasted screenshot sits
  inside one JSONL line.

## Alternatives considered

| Alternative | Why not chosen |
|-------------|----------------|
| Re-read the Transcript on the Machine per image (herdr-web-ui) | It costs one remote command per image over SSH and re-parses the record. pi also needs the branch rebuilt to know which images are visible. |
| Send the base64 inside the chat items | A `Reset` carries up to 500 items, and pages carry more. Megabytes of images would cross IPC on every reopen and scroll-back. |

## Updates

### 2026-10-03: Tails outlive their lens

Closed tails are now parked rather than killed (ADR [0004](./0004-park-chat-tails.md)), so the store
is no longer freed when the lens closes. A parked tail's budget drops to 16 MiB, evicting oldest
images first, and returns to 64 MiB when the lens reopens. Reopening no longer re-reads the
Transcript, so an evicted image stays unavailable until the tail is dropped and a new one starts.

### 2026-10-09: Frozen tails keep no images

A Frozen tail (ADR [0008](./0008-freeze-dropped-chat-tails.md)) keeps no image store. After it
resumes, images older than its offset show "Image unavailable"; images from the offset on are
decoded again as their lines arrive.
