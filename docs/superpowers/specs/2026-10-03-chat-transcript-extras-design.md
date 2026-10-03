# Images, Model label and Skill chips in the Chat lens

Date: 2026-10-03
Status: draft

## Purpose

The Chat lens reads the Agent's Transcript but drops three things the terminal shows or the
Transcript records:

- the images the user pasted, and the images a pi tool read;
- which Model the Agent runs and at what Reasoning effort;
- which Skill a turn used. A pi skill call even floods the user's bubble with the whole SKILL.md.

This design adds all three.

Reference: herdr-web-ui (MIT, https://github.com/devswha/herdr-web-ui):
- `server/conversation.ts` (image refs and serving);
- `server/conversation-metadata.ts` (Model and effort);
- `server/skill-activity.ts` and `src/lib/skillActivity.ts` (Skill chips);
- `src/components/ChatView.tsx` and `Composer.tsx` (rendering).

There is one deliberate difference. herdr-web-ui re-reads the Transcript for each image. This
app keeps the bytes that already came through the tail (ADR 0003).

## Scope

In:

- Images:
  - in Claude user turns;
  - in pi user turns;
  - in pi tool results.
- The Model and Reasoning effort label in the Composer, for claude and pi.
- Skill chips:
  - Claude, from `Skill` tool calls;
  - pi, from the skill-invocation prompt pi records.

Out:

- Images in Claude tool results. A `Read` of a PNG keeps showing only its text.
- Thumbnails for `@path` image mentions in user text.
- `[Image #n]` placeholders: they stay in the text as typed.
- Any guess at which Skill is "active".
- Skill detection from pi tool reads of a SKILL.md.
- Context-window usage, which herdr-web-ui computes alongside the Model.
- Agents other than claude and pi.

## 1. Images

### Transcript shapes

| Source | Block | Media type field |
|--------|-------|------------------|
| Claude user record (`type: "user"`, `message.content[]`) | `{type: "image", source: {type: "base64", media_type, data}}` | `source.media_type` |
| pi user message (`role: "user"`) | `{type: "image", data, mimeType}` | `mimeType`, else `media_type` |
| pi tool result (`role: "toolResult"`) | same as pi user | same |

Only `image/png`, `image/jpeg`, `image/gif` and `image/webp` are kept. Any other type is
skipped and takes no number. Data that fails base64 decoding is skipped too.

### Refs

An image is named by an opaque ref that stays the same for the life of the Transcript:

- Claude: `<record uuid>:<block index>`. A record without a `uuid` gets no images.
- pi: `<entry id>:<n>`, where `n` counts the kept images of that entry from 0.

A pi branch rebuild (`ParserOutput::Reset`) re-emits items that carry the same refs, so the
images stay available.

### ChatItem

```rust
pub struct ImageRef { pub r#ref: String, pub media_type: String }
```

- `ChatItem::User` and `ChatItem::ToolResult` gain `images: Vec<ImageRef>`. The field is not
  serialized when empty, so existing payloads are unchanged.
- In TypeScript the field is `images?: { ref: string; media_type: string }[]`.
- Claude: a record's images attach to its first `User` item. A record with images and no text
  emits `User { text: "", images }`.
- pi: the images of a user message attach to its first `User` item, or form an empty-text one.
  A tool result's images attach to its `ToolResult`.

### ImageStore

- Each tail owns an `ImageStore`: `ref → (media_type, bytes)`, in insertion order.
- Its budget is 64 MiB of decoded bytes. Past it, the oldest images are evicted until the
  store fits again. An image larger than the whole budget is not stored.
- `TailHandle` owns the store as `Arc<Mutex<ImageStore>>`, and the parser writes into it.
  The `Parser` trait becomes:
  ```rust
  fn push_line(&mut self, line: &str, images: &mut dyn ImageSink) -> ParserOutput;
  ```
  `ImageSink` has one method, `put(ref, media_type, bytes)`. Tests pass a `Vec`-backed sink.
- The store is freed with its tail: on `chat_close`, on `close_machine`, and when another
  `chat_open` replaces the tail.

### Command

`chat_image(machine_id, session, pane_id, ref) -> Response` returns the raw bytes
(`tauri::ipc::Response`). It fails with:

- `not_found` "no open chat for this pane" when the Pane has no tail;
- `not_found` "image not available" when the ref is unknown or was evicted.

The frontend learns the media type from the `ImageRef` it already holds.

### Line limit

`MAX_LINE` in `tail.rs` rises from 8 MiB to 32 MiB. A pasted screenshot is base64 inside one
JSONL line, and a line over the limit is dropped whole, its text included.

### Frontend

- `useChatImage(pane, ref, mediaType)` calls `chatImage` and returns a `Blob` object URL, or
  an error.
  - The URL is cached per `paneKey + ref` in a module-level map, so a virtualized row
    scrolling back in does not refetch.
  - `revokeChatImages(paneKey)` revokes and forgets a Pane's URLs. It runs when the Chat
    lens closes that Pane's chat.
- `ChatImages({ pane, images })` renders a row of 64 px thumbnails.
  - A failed load shows a box reading "Image unavailable".
  - A click opens `ImageViewer`, a full-window overlay with the image fitted to the window.
    Escape or a click on the backdrop closes it.
- In a user turn the row sits above the bubble. The copy button still copies only the text.
- In a tool result the row sits in the expanded tool body, above the output text.

## 2. Model and Reasoning effort

### Sources

Only values the Transcript records are used, and for each one the last value in the file wins.
Effort is never inferred from thinking blocks.

| Agent | Model | Reasoning effort |
|-------|-------|------------------|
| claude | `message.model` of each `type: "assistant"` record | top-level `effort` of each assistant record. Older Claude Code versions record none, so it stays unset |
| pi | `modelId` of a `type: "model_change"` entry; `message.model` of an assistant message | `thinkingLevel` of a `type: "thinking_level_change"` entry. `"off"` is shown as `off` |

A value that is empty, longer than 100 characters, or starts with `<` (Claude's `<synthetic>`)
is ignored.

There is no reset on `/clear` or a new session: both Agents start a new Transcript file then,
and the Chat lens reopens on it.

### Backend

- `pub struct ChatMeta { model: Option<String>, effort: Option<String> }`, with
  `Default`, `PartialEq` and `Serialize`.
- The `Parser` trait gains `fn meta(&self) -> ChatMeta`. It defaults to `ChatMeta::default()`.
- The pi parser reads `model_change` and `thinking_level_change` from entries that are not
  `message`. They are read for every entry in file order, whichever branch it is on.
- `ChatEvent::Meta { model, effort }`:
  - the tail sends it right after the first `Reset`, if the meta is not empty;
  - after that, on any flush where `parser.meta()` differs from the last one sent.

### Frontend

- `ChatEvent` gains `{ type: "meta"; model: string | null; effort: string | null }`, and
  `ChatState` gains `meta`.
- `ChatLens` passes `meta` to `Composer`.
- The Composer bar shows `<span class="composer-model" title="Model · reasoning effort">`,
  just left of Stop and Send:
  - `model · effort` when both are known;
  - the Model alone when only it is known;
  - `effort` alone when only it is known;
  - nothing when neither is known.
- The Model id is shown as recorded, without shortening. The span ellipsizes when the bar is
  narrow.

## 3. Skill chips

### Claude, in the frontend only

- A `ToolCall` whose `name` is `Skill` and whose `input.skill` is a string of 1 to 200
  characters with no line breaks or angle brackets is a Skill use.
- Its status:
  - `requested` while there is no result;
  - `loaded` when the result is not an error;
  - `failed` when the result is an error.
- `turnSkills(items, results): SkillChip[]` (in `src/chat/skills.ts`) keeps the latest use per
  name within a work block, in order of first appearance.
- `SkillChip = { name: string; status: "requested" | "loaded" | "failed"; path?: string }`.

### pi, in the Rust parser

pi records the whole skill file in the user prompt when the user invokes a Skill. The parser
recognises the format of pi's own `parseSkillBlock`:

- One or more chained blocks, each:
  ```
  The user explicitly invoked the "<name>" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.

  <skill-instruction name="<name>" location="<path>">
  …
  </skill-instruction>
  ```
  The two names must match.
- The blocks are optionally followed by `\n\n<user-request>\n…\n</user-request>`.
- The legacy form `<skill name="<name>" location="<path>">\n…\n</skill>` is also recognised,
  optionally followed by `\n\n<request>`.

On a match:

- The `User` item's text becomes the request, or `/skill:<name>` when there is none (one
  `/skill:` per Skill, space-separated).
- The item gains `skills: Vec<SkillUse { name, path }>`. It is not serialized when empty, and
  the frontend shows these as `loaded`.

Text that does not match exactly is left as it is.

### Rendering

- `SkillChips({ chips })` renders each chip as a small pill: `BookIcon`, the name, then the
  status in dim text (`requested`, `loaded`, `failed`). The `title` is the path when known.
- In a Claude work block, the row sits directly under the work block header, outside the
  collapsible rows, so it shows while the block is folded.
- In a pi user turn, the row sits under the bubble.
- Chips never disappear on their own.
- None of these count as a Skill use: lists of available skills, Skill names in prose, edits to
  a SKILL.md, or any other tool.

## Error handling

- A malformed image block (bad base64, unknown type, no uuid) is skipped. The rest of the
  record still parses.
- `chat_image` failing shows "Image unavailable" in place of that thumbnail, and nothing else
  changes.
- `Meta` with both fields null hides the label.
- A pi prompt that resembles the skill format but does not match exactly is shown unchanged.

## Testing

Rust (`cargo test`, `cargo clippy -- -D warnings`):

- Claude parser: an image-only user record, and an image beside text. Refs are
  `uuid:index`, unsupported types and bad base64 are skipped, and bytes reach the sink.
- pi parser:
  - images in a user message and in a tool result;
  - refs are unchanged after a branch rebuild;
  - the skill prompt: one Skill, chained Skills, the legacy form, no request, and
    near-misses left unchanged.
- Meta:
  - Claude model and effort, with the last value winning;
  - `<synthetic>` ignored;
  - no effort field leaves it unset;
  - pi `model_change`, `thinking_level_change` and assistant `model`.
- `ImageStore`: eviction past the budget, and an oversize image not stored.
- tail: `Meta` is sent after the first `Reset`, and again only on change.
- `chat_image` lookup through `ChatManager`: hit, unknown ref, unknown Pane.

Vitest (`pnpm vitest run`, `pnpm typecheck`):

- `chatStore` stores `meta`.
- Composer label: both values, Model only, effort only, hidden.
- `turnSkills`: requested, loaded, failed, and the latest use winning.
- Chips render under a folded work block and under a pi user bubble.
- `ChatImages`:
  - thumbnails from mocked `chatImage`;
  - "Image unavailable" on failure;
  - the viewer opens on click and closes on Escape.
- `useChatImage` caches per Pane and revokes on `revokeChatImages`.

## Credits

The ports go in the herdr-web-ui section of `THIRD_PARTY_NOTICES.md`:

- image extraction;
- metadata rules;
- the skill-prompt format;
- `turnSkills`.
