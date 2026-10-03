# Chat transcript extras Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Chat lens shows the images in the Transcript, a Model and Reasoning effort label in the Composer, and a Skill chip on each turn that used a Skill.

**Architecture:**
- The Rust parsers decode inline base64 images into a per-tail `ImageStore`, which is capped and evicts the oldest first. Chat items carry only `{ref, media_type}`, and the webview fetches the bytes with a `chat_image` command.
- Parsers also report a `ChatMeta`. The tail sends it as a `ChatEvent::Meta` whenever it changes.
- Claude Skill chips are derived in the frontend from `Skill` tool calls. The pi parser rewrites pi's skill-invocation prompt into the request plus `skills`.

**Tech Stack:** Rust (Tauri 2, serde_json, `base64` 0.22), React 19 + TypeScript, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-03-chat-transcript-extras-design.md` (ADR: `docs/adr/0003-chat-images-kept-from-the-tail.md`)

## Global Constraints

- Kept image types are exactly `image/png`, `image/jpeg`, `image/gif` and `image/webp`. Any other type, and data that fails base64 (STANDARD) decoding, is skipped and takes no number.
- Image refs:
  - Claude: `<record uuid>:<block index in message.content>`;
  - pi: `<entry id>:<n>`, where n counts kept images of that entry from 0.
- `IMAGE_BUDGET` is `64 * 1024 * 1024` decoded bytes per tail. `MAX_LINE` in `tail.rs` becomes `32 * 1024 * 1024`.
- Meta values pass through one helper, `meta_label(&str) -> Option<String>` in `src-tauri/src/transcript/mod.rs`. It rejects a value that is empty, longer than 100 chars, or starts with `<`. For each field, the last value read wins.
- New Rust fields are `#[serde(skip_serializing_if = "Vec::is_empty")]`:
  - `images: Vec<ImageRef>` on `User` and `ToolResult`;
  - `skills: Vec<SkillUse>` on `User`.
  The TS types mark them optional (`images?:`, `skills?:`).
- `ImageRef` serializes as `{ "ref": string, "media_type": string }`. `SkillUse` serializes as `{ "name": string, "path": string }`.
- `ChatEvent::Meta` serializes as `{ "type": "meta", "model": string | null, "effort": string | null }`.
- Error copy:
  - `AppError::new("not_found", "no open chat for this pane")` for an unknown Pane;
  - `AppError::new("not_found", "image not available")` for an unknown or evicted ref.
  - The UI shows `Image unavailable` for a failed image.
- UI copy:
  - Composer label title: `Model · reasoning effort`. Label text: `model · effort`, the Model alone, effort alone, or nothing.
  - Chip statuses are the words `requested`, `loaded`, `failed`.
  - pi request fallback: `/skill:<name>` per Skill, space-separated.
- CSS class names:
  - Composer: `composer-model`.
  - Images: `chat-images`, `chat-image`, `chat-image-missing`, `image-viewer`.
  - Skills: `skill-chips`, `skill-chip`, `skill-chip-status`.
  - All CSS goes in `src/styles.css`, next to the related existing blocks.
- Glossary words in UI copy and comments: Machine, Pane, Agent, Lens, Transcript, Model, Reasoning effort, Skill. Never "host" or "mode".
- Run Rust checks from `src-tauri/`: `cargo test` and `cargo clippy -- -D warnings`. Run frontend checks from the repo root: `pnpm vitest run` and `pnpm typecheck`.

## Review Focus

- **A Claude user record whose `content` is a plain string.** It must parse exactly as today, with no images and no panic. Task 3 test `string_content_unchanged`.
- **A pi branch rebuild after images were stored.** The `Reset` items keep the same refs, and the store still answers them. Task 4 test `refs_survive_branch_rebuild`.
- **Meta unknown at first, known later.** No `Meta` event is sent with the first `Reset`, and one is sent when the Model first appears. Task 2 test `meta_sent_after_reset_and_on_change`.
- **A virtualized row scrolling out and back in.** It must not call `chatImage` again for the same ref. Task 7 test `caches per pane and ref`.
- **A Skill call with no result yet, inside a folded work block.** The chip shows `requested` while the block is closed. Task 8 test `shows chips while folded`.

---

### Task 1: Rust data model, ImageStore and the Parser trait

**Files:**
- Create: `src-tauri/src/transcript/images.rs`
- Modify:
  - `src-tauri/src/transcript/mod.rs` (`ChatItem`, `ChatEvent`, `Parser`, new types, `meta_label`, `pub mod images;`);
  - `src-tauri/Cargo.toml` (add `base64 = "0.22"` under `[dependencies]`);
  - every `push_line` caller and every `ChatItem::User` and `ChatItem::ToolResult` literal in `src-tauri/src/transcript/{claude,pi,tail,mod}.rs`.

**Interfaces:**
- Produces, in `transcript::images`:
  - `pub const IMAGE_BUDGET: usize`;
  - `pub trait ImageSink { fn put(&mut self, r: String, media_type: String, bytes: Vec<u8>); }`;
  - `impl ImageSink for Vec<(String, String, Vec<u8>)>`, which pushes the tuple;
  - `pub struct ImageStore` with `pub fn new(budget: usize) -> Self`, `pub fn get(&self, r: &str) -> Option<(String, Vec<u8>)>` and `impl ImageSink`;
  - `pub fn decode_image(media_type: &str, data: &str) -> Option<Vec<u8>>`, which returns None for a type outside the four or for bad base64.
- Produces, in `transcript` (mod.rs):
  - `pub struct ImageRef { #[serde(rename = "ref")] pub reference: String, pub media_type: String }`, deriving `Clone, Debug, PartialEq, Serialize`;
  - `pub struct SkillUse { pub name: String, pub path: String }`, with the same derives;
  - `#[derive(Clone, Debug, Default, PartialEq, Serialize)] pub struct ChatMeta { pub model: Option<String>, pub effort: Option<String> }`;
  - `ChatEvent::Meta { model: Option<String>, effort: Option<String> }`;
  - `pub(crate) fn meta_label(s: &str) -> Option<String>`;
  - `ChatItem::User { text, images: Vec<ImageRef>, skills: Vec<SkillUse>, ts }`;
  - `ChatItem::ToolResult { call_id, output, is_error, images: Vec<ImageRef>, ts }`;
  - `trait Parser { fn push_line(&mut self, line: &str, images: &mut dyn ImageSink) -> ParserOutput; fn meta(&self) -> ChatMeta { ChatMeta::default() } }`.
- `parser_for` must construct `claude::ClaudeParser::default()`, because Task 3 gives it state.

- [ ] **Step 1: Write the failing tests** in `images.rs`, and in `mod.rs`'s test module:

```rust
// src-tauri/src/transcript/images.rs
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evicts_oldest_past_budget() {
        let mut s = ImageStore::new(10);
        s.put("a".into(), "image/png".into(), vec![0; 4]);
        s.put("b".into(), "image/png".into(), vec![1; 4]);
        s.put("c".into(), "image/png".into(), vec![2; 4]);
        assert!(s.get("a").is_none());
        assert_eq!(s.get("b"), Some(("image/png".into(), vec![1; 4])));
        assert_eq!(s.get("c"), Some(("image/png".into(), vec![2; 4])));
    }
    #[test]
    fn skips_an_image_larger_than_the_budget() {
        let mut s = ImageStore::new(10);
        s.put("a".into(), "image/png".into(), vec![0; 4]);
        s.put("big".into(), "image/png".into(), vec![0; 11]);
        assert!(s.get("big").is_none());
        assert!(s.get("a").is_some());
    }
    #[test]
    fn replacing_a_ref_does_not_double_count() {
        let mut s = ImageStore::new(10);
        s.put("a".into(), "image/png".into(), vec![0; 6]);
        s.put("a".into(), "image/png".into(), vec![1; 6]);
        s.put("b".into(), "image/png".into(), vec![2; 4]);
        assert_eq!(s.get("a"), Some(("image/png".into(), vec![1; 6])));
        assert!(s.get("b").is_some());
    }
    #[test]
    fn decodes_only_kept_types() {
        assert_eq!(decode_image("image/png", "AQID"), Some(vec![1, 2, 3]));
        assert_eq!(decode_image("image/webp", "AQID"), Some(vec![1, 2, 3]));
        assert_eq!(decode_image("image/svg+xml", "AQID"), None);
        assert_eq!(decode_image("image/png", "not base64!"), None);
    }
}
```

```rust
// added to src-tauri/src/transcript/mod.rs tests
#[test]
fn omits_empty_images_and_skills() {
    let v = serde_json::to_value(ChatItem::User { text: "a".into(), images: vec![], skills: vec![], ts: None }).unwrap();
    assert!(v.get("images").is_none() && v.get("skills").is_none());
    let v = serde_json::to_value(ChatItem::ToolResult {
        call_id: "c".into(), output: "o".into(), is_error: false,
        images: vec![ImageRef { reference: "e:0".into(), media_type: "image/png".into() }], ts: None,
    }).unwrap();
    assert_eq!(v["images"], serde_json::json!([{ "ref": "e:0", "media_type": "image/png" }]));
}
#[test]
fn serializes_meta_event() {
    let v = serde_json::to_value(ChatEvent::Meta { model: Some("m".into()), effort: None }).unwrap();
    assert_eq!(v, serde_json::json!({ "type": "meta", "model": "m", "effort": null }));
}
#[test]
fn meta_label_rejects_placeholders() {
    assert_eq!(meta_label("claude-opus-5-5"), Some("claude-opus-5-5".into()));
    assert_eq!(meta_label("<synthetic>"), None);
    assert_eq!(meta_label(""), None);
    assert_eq!(meta_label(&"x".repeat(101)), None);
}
```

- [ ] **Step 2: Run them to verify they fail to compile**

Run: `cd src-tauri && cargo test transcript:: 2>&1 | tail -20`
Expected: compile errors (`ImageStore`, `ImageRef` and `meta_label` are not found).

- [ ] **Step 3: Implement**
- Add the types and the trait change.
- `ImageStore` keeps a `HashMap<String, (String, Vec<u8>)>`, a `VecDeque<String>` of insertion order, and the bytes used. On `put` it:
  1. skips an image larger than the budget;
  2. removes any old entry with the same ref;
  3. inserts the new one;
  4. pops the oldest entries until the bytes used fit the budget.
- Update every existing caller and literal mechanically:
  - add `images: vec![]` (and `skills: vec![]` on `User`);
  - tests pass `&mut Vec::<(String, String, Vec<u8>)>::new()` as the sink;
  - `tail.rs`'s `State::line` passes a throwaway `Vec` for now (Task 2 wires the store).
- No parser emits images or meta yet.

- [ ] **Step 4: Run the whole Rust suite**

Run: `cd src-tauri && cargo test && cargo clippy -- -D warnings`
Expected: all pass, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(chat): add image refs, Skill uses and meta to the transcript model"
```

### Task 2: Tail owns the ImageStore, sends Meta; `chat_image` command

**Files:**
- Modify:
  - `src-tauri/src/transcript/tail.rs` (`TailHandle`, `State`, `MAX_LINE`, `flush`);
  - `src-tauri/src/transcript/mod.rs` (`ChatManager::image`);
  - `src-tauri/src/commands.rs` (new `chat_image`);
  - `src-tauri/src/lib.rs` (register `commands::chat_image` beside `commands::chat_page`).

**Interfaces:**
- Consumes (Task 1): `ImageStore`, `IMAGE_BUDGET`, `ImageSink`, `ChatMeta`, `ChatEvent::Meta`, and `Parser::meta`.
- Produces:
  - `TailHandle::image(&self, r: &str) -> Option<(String, Vec<u8>)>`;
  - `ChatManager::image(&self, pane: &PaneRef, r: &str) -> Result<Vec<u8>, AppError>`, with the two Global Constraints errors;
  - `#[tauri::command] pub async fn chat_image(chats: Chats<'_>, machine_id: String, session: String, pane_id: String, r#ref: String) -> Result<tauri::ipc::Response, AppError>`. It returns `tauri::ipc::Response::new(bytes)`. The JS argument is named `ref`.
- Meta rules:
  - On the first flush that sends the `Reset`, also send `Meta` right after it, only if `parser.meta() != ChatMeta::default()`.
  - On later flushes, after draining the queued events, send `Meta` when `parser.meta()` differs from the last value sent. The last value sent starts as the default.

- [ ] **Step 1: Write the failing tests**, in `tail.rs` tests and `mod.rs` tests:

```rust
// tail.rs tests: a parser whose meta follows "MODEL x" lines and which stores an image per "IMG r" line
struct MetaLines { model: Option<String> }
impl Parser for MetaLines {
    fn push_line(&mut self, line: &str, images: &mut dyn crate::transcript::images::ImageSink) -> ParserOutput {
        if let Some(m) = line.strip_prefix("MODEL ") {
            self.model = Some(m.into());
            return ParserOutput::None;
        }
        if let Some(r) = line.strip_prefix("IMG ") {
            images.put(r.into(), "image/png".into(), vec![7, 7]);
            return ParserOutput::None;
        }
        ParserOutput::Append(vec![ChatItem::User { ts: None, text: line.into(), images: vec![], skills: vec![] }])
    }
    fn meta(&self) -> crate::transcript::ChatMeta {
        crate::transcript::ChatMeta { model: self.model.clone(), effort: None }
    }
}

#[tokio::test]
async fn meta_sent_after_reset_and_on_change() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("t.jsonl");
    std::fs::write(&p, "a\n").unwrap();
    let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
    let g = got.clone();
    let h = spawn_tail(
        Arc::new(crate::transport::local::LocalTransport),
        p.to_string_lossy().into(),
        Box::new(MetaLines { model: None }),
        Arc::new(move |e| g.lock().unwrap().push(e)),
    );
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    {
        let ev = got.lock().unwrap();
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert!(matches!(ev[0], ChatEvent::Reset { .. }));
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
    writeln!(f, "MODEL m1\nb\nIMG r1").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    writeln!(f, "c").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let ev = got.lock().unwrap();
    let metas: Vec<_> = ev.iter().filter_map(|e| match e {
        ChatEvent::Meta { model, .. } => Some(model.clone()),
        _ => None,
    }).collect();
    assert_eq!(metas, vec![Some("m1".to_string())]);
    assert_eq!(h.image("r1"), Some(("image/png".to_string(), vec![7, 7])));
    assert_eq!(h.image("nope"), None);
    drop(h);
}

#[tokio::test]
async fn meta_known_at_open_follows_the_reset() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("t.jsonl");
    std::fs::write(&p, "MODEL m0\na\n").unwrap();
    let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
    let g = got.clone();
    let _h = spawn_tail(
        Arc::new(crate::transport::local::LocalTransport),
        p.to_string_lossy().into(),
        Box::new(MetaLines { model: None }),
        Arc::new(move |e| g.lock().unwrap().push(e)),
    );
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let ev = got.lock().unwrap();
    assert!(matches!(ev[0], ChatEvent::Reset { .. }));
    assert!(matches!(&ev[1], ChatEvent::Meta { model: Some(m), .. } if m == "m0"));
}
```

```rust
// mod.rs tests
#[tokio::test]
async fn image_lookup_through_chat_manager() {
    struct OneImage;
    impl Parser for OneImage {
        fn push_line(&mut self, _: &str, images: &mut dyn images::ImageSink) -> ParserOutput {
            images.put("u:0".into(), "image/png".into(), vec![1, 2, 3]);
            ParserOutput::None
        }
    }
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("t.jsonl");
    std::fs::write(&p, "x\n").unwrap();
    let chats = ChatManager::default();
    let pane = PaneRef { machine_id: "a".into(), session: "default".into(), pane_id: "w1:p1".into() };
    chats.insert(pane.clone(), spawn_tail(
        Arc::new(crate::transport::local::LocalTransport),
        p.to_string_lossy().into(),
        Box::new(OneImage),
        Arc::new(|_| {}),
    ));
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_eq!(chats.image(&pane, "u:0").unwrap(), vec![1, 2, 3]);
    assert_eq!(chats.image(&pane, "u:9").unwrap_err().message, "image not available");
    let other = PaneRef { pane_id: "w1:p2".into(), ..pane };
    assert_eq!(chats.image(&other, "u:0").unwrap_err().message, "no open chat for this pane");
}
```

(If `AppError`'s message field has another name, read `src-tauri/src/error.rs` and use that. Keep the asserted strings exactly.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test transcript:: 2>&1 | tail -20`
Expected: compile errors (`TailHandle::image` and `ChatManager::image` are not found).

- [ ] **Step 3: Implement**
- `TailHandle` gains `images: Arc<Mutex<ImageStore>>`, created with `ImageStore::new(IMAGE_BUDGET)` in `spawn_tail`.
- `State` holds a clone of it and `last_meta: ChatMeta`. `State::line` locks the store and passes `&mut *guard` as the sink.
- Set `MAX_LINE` to 32 MiB.
- Add `chat_image` as described in Interfaces and register it.

- [ ] **Step 4: Run the Rust suite**

Run: `cd src-tauri && cargo test && cargo clippy -- -D warnings`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(chat): keep transcript images per tail and serve them by ref"
```

### Task 3: Claude parser — images and meta

**Files:**
- Modify: `src-tauri/src/transcript/claude.rs`.

**Interfaces:**
- Consumes (Task 1): `ImageSink`, `decode_image`, `ImageRef`, `ChatMeta`, `meta_label`.
- Produces:
  - `#[derive(Default)] pub struct ClaudeParser { meta: ChatMeta }`;
  - `Parser::meta` returns `self.meta.clone()`.
- Rules:
  - **Images.** For a `type: "user"` record whose `message.content` is an array, each block with `type == "image"` and `source.type == "base64"` is decoded with `decode_image(source.media_type, source.data)`.
    - Ref: `format!("{uuid}:{index}")`, where `uuid` is the record's top-level `uuid` and `index` is the block's position in `content`. Without `uuid`, there are no images.
    - A decoded image goes to the sink and to the record's image list.
    - After the blocks are walked, the list attaches to the first `User` item. If there is none and the list is not empty, insert `User { text: "", images, skills: vec![], ts }` at position 0.
  - **Meta.** For each `type: "assistant"` record, read `message.model` and the top-level `effort` (string only) through `meta_label`. A `Some` result overwrites that field of `self.meta`.
  - Both run after the existing `isMeta` / `isSidechain` / `isCompactSummary` skip. A sidechain record is a subagent's, and its Model must not replace the main Agent's.

- [ ] **Step 1: Write the failing tests** (in `claude.rs` tests; update `run` to pass a sink and also return it):

```rust
fn run_with(text: &str) -> (Vec<ChatItem>, Vec<(String, String, Vec<u8>)>, ClaudeParser) {
    let mut p = ClaudeParser::default();
    let mut sink: Vec<(String, String, Vec<u8>)> = vec![];
    let mut out = vec![];
    for l in text.lines() {
        if let ParserOutput::Append(v) = p.push_line(l, &mut sink) { out.extend(v) }
    }
    (out, sink, p)
}
fn png(data: &str) -> serde_json::Value {
    serde_json::json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":data}})
}
#[test]
fn image_beside_text_attaches_to_the_user_item() {
    let line = serde_json::json!({"type":"user","uuid":"u1","message":{"content":[png("AQID"),{"type":"text","text":"look"}]}}).to_string();
    let (items, sink, _) = run_with(&line);
    assert_eq!(items, vec![User {
        ts: None, text: "look".into(), skills: vec![],
        images: vec![ImageRef { reference: "u1:0".into(), media_type: "image/png".into() }],
    }]);
    assert_eq!(sink, vec![("u1:0".to_string(), "image/png".to_string(), vec![1, 2, 3])]);
}
#[test]
fn image_only_record_gets_an_empty_user_item() {
    let line = serde_json::json!({"type":"user","uuid":"u2","message":{"content":[
        {"type":"image","source":{"type":"base64","media_type":"image/svg+xml","data":"AQID"}},
        png("not base64!"),
        png("AQID")
    ]}}).to_string();
    let (items, sink, _) = run_with(&line);
    assert_eq!(items, vec![User {
        ts: None, text: "".into(), skills: vec![],
        images: vec![ImageRef { reference: "u2:2".into(), media_type: "image/png".into() }],
    }]);
    assert_eq!(sink.len(), 1);
}
#[test]
fn no_uuid_no_images() {
    let line = serde_json::json!({"type":"user","message":{"content":[png("AQID"),{"type":"text","text":"x"}]}}).to_string();
    let (items, sink, _) = run_with(&line);
    assert_eq!(items, vec![User { ts: None, text: "x".into(), images: vec![], skills: vec![] }]);
    assert!(sink.is_empty());
}
#[test]
fn string_content_unchanged() {
    let (items, sink, _) = run_with(r#"{"type":"user","uuid":"u3","message":{"content":"plain"}}"#);
    assert_eq!(items, vec![User { ts: None, text: "plain".into(), images: vec![], skills: vec![] }]);
    assert!(sink.is_empty());
}
#[test]
fn reads_model_and_effort_last_wins() {
    let lines = [
        serde_json::json!({"type":"assistant","effort":"medium","message":{"model":"claude-haiku-4-5","content":[]}}),
        serde_json::json!({"type":"assistant","effort":"high","message":{"model":"claude-opus-5-5","content":[]}}),
        serde_json::json!({"type":"assistant","message":{"model":"<synthetic>","content":[]}}),
        serde_json::json!({"type":"assistant","isSidechain":true,"effort":"low","message":{"model":"claude-sonnet-5-5","content":[]}}),
    ].map(|v| v.to_string()).join("\n");
    let (_, _, p) = run_with(&lines);
    assert_eq!(p.meta(), ChatMeta { model: Some("claude-opus-5-5".into()), effort: Some("high".into()) });
}
#[test]
fn no_effort_field_leaves_it_unset() {
    let (_, _, p) = run_with(&serde_json::json!({"type":"assistant","message":{"model":"claude-opus-5-5","content":[]}}).to_string());
    assert_eq!(p.meta(), ChatMeta { model: Some("claude-opus-5-5".into()), effort: None });
}
```

Add `use crate::transcript::{ChatMeta, ImageRef};` to the test module as needed.

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test transcript::claude`
Expected: the new tests FAIL (no images, meta empty).

- [ ] **Step 3: Implement the rules above in `ClaudeParser::push_line`.**

- [ ] **Step 4: Run the Rust suite**

Run: `cd src-tauri && cargo test && cargo clippy -- -D warnings`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transcript/claude.rs
git commit -m "feat(chat): read pasted images, Model and effort from Claude transcripts"
```

### Task 4: pi parser — images and meta

**Files:**
- Modify: `src-tauri/src/transcript/pi.rs`.

**Interfaces:**
- Consumes (Task 1): `ImageSink`, `decode_image`, `ImageRef`, `ChatMeta`, `meta_label`.
- Produces: `PiParser` gains `meta: ChatMeta`, and `Parser::meta` returns a clone of it.
- Rules:
  - **Images.** A block with `type == "image"` in a `user` or `toolResult` message is decoded with `decode_image(mimeType or media_type, data)`.
    - Ref: `format!("{entry_id}:{n}")`. `n` counts the kept images of the entry from 0.
    - User: images attach to the first `User` item, or form `User { text: "", .. }`.
    - toolResult: images go on its `ToolResult`.
    - `message_items` takes the entry id and the sink.
  - **Meta.** For every entry, in file order, whatever its branch:
    - `type == "model_change"`: `modelId`, else `model`, sets the Model;
    - `type == "thinking_level_change"`: `thinkingLevel` sets the effort;
    - `type == "message"` with `message.role == "assistant"`: `message.model` sets the Model.
    - All values go through `meta_label`.

- [ ] **Step 1: Write the failing tests** (in `pi.rs` tests; give `feed` a sink parameter, and update existing callers to pass `&mut vec![]`):

```rust
fn img(data: &str) -> serde_json::Value { serde_json::json!({"type":"image","mimeType":"image/png","data":data}) }
#[test]
fn images_in_user_and_tool_result() {
    let mut p = PiParser::default();
    let mut sink: Vec<(String, String, Vec<u8>)> = vec![];
    let lines = [
        serde_json::json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"see"},img("AQID")]}}),
        serde_json::json!({"type":"message","id":"b","parentId":"a","message":{"role":"toolResult","toolCallId":"c1","content":[{"type":"text","text":"read"},{"type":"image","media_type":"image/jpeg","data":"AQID"},img("AQID")]}}),
        serde_json::json!({"type":"message","id":"c","parentId":"b","message":{"role":"user","content":[img("AQID")]}}),
    ];
    let items = appended(lines.iter().map(|l| p.push_line(&l.to_string(), &mut sink)).collect());
    let r = |s: &str, t: &str| ImageRef { reference: s.into(), media_type: t.into() };
    assert_eq!(items, vec![
        User { ts: None, text: "see".into(), skills: vec![], images: vec![r("a:0", "image/png")] },
        ToolResult { ts: None, call_id: "c1".into(), output: "read".into(), is_error: false,
            images: vec![r("b:0", "image/jpeg"), r("b:1", "image/png")] },
        User { ts: None, text: "".into(), skills: vec![], images: vec![r("c:0", "image/png")] },
    ]);
    assert_eq!(sink.len(), 4);
}
#[test]
fn refs_survive_branch_rebuild() {
    let mut p = PiParser::default();
    let mut sink: Vec<(String, String, Vec<u8>)> = vec![];
    p.push_line(&serde_json::json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"},img("AQID")]}}).to_string(), &mut sink);
    p.push_line(r#"{"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}"#, &mut sink);
    match p.push_line(r#"{"type":"message","id":"e","parentId":"a","message":{"role":"user","content":"again"}}"#, &mut sink) {
        ParserOutput::Reset(items) => assert!(matches!(&items[0], User { images, .. } if images[0].reference == "a:0")),
        o => panic!("{o:?}"),
    }
}
#[test]
fn reads_model_and_thinking_level() {
    let mut p = PiParser::default();
    let mut sink: Vec<(String, String, Vec<u8>)> = vec![];
    for l in [
        r#"{"type":"model_change","id":"m1","parentId":null,"provider":"anthropic","modelId":"claude-sonnet-5-5"}"#,
        r#"{"type":"thinking_level_change","id":"t1","parentId":"m1","thinkingLevel":"off"}"#,
        r#"{"type":"message","id":"a","parentId":"t1","message":{"role":"assistant","model":"gpt-5","content":[]}}"#,
        r#"{"type":"model_change","id":"m2","parentId":"a","modelId":"<none>"}"#,
    ] { p.push_line(l, &mut sink); }
    assert_eq!(p.meta(), ChatMeta { model: Some("gpt-5".into()), effort: Some("off".into()) });
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test transcript::pi`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement the rules above.**

- [ ] **Step 4: Run the Rust suite**

Run: `cd src-tauri && cargo test && cargo clippy -- -D warnings`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transcript/pi.rs
git commit -m "feat(chat): read images, Model and thinking level from pi transcripts"
```

### Task 5: pi skill-invocation prompt

**Files:**
- Create: `src-tauri/src/transcript/skill_prompt.rs` (and add `mod skill_prompt;` in `mod.rs`).
- Modify: `src-tauri/src/transcript/pi.rs` (user text blocks).

**Interfaces:**
- Consumes (Task 1): `SkillUse`.
- Produces: `pub(crate) fn parse_skill_prompt(text: &str) -> Option<(Vec<SkillUse>, String)>`, which returns the Skills and the request (trimmed; empty when none).
- The format is exact. Match with string operations; there is no regex crate. `N` is the Skill name and `P` the location.
  - **Chained form.** The text starts with one or more blocks. Consecutive blocks are separated by `\n\n`. Each block is exactly:
    ```
    The user explicitly invoked the "N" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name="N" location="P">\n…\n</skill-instruction>
    ```
    - The two N must be equal.
    - N is 1–200 chars with no `\r`, `\n`, `<`, `>` or `"`.
    - P is 1–4096 chars with no line break or `"`.
    - The body is matched lazily, up to the first `\n</skill-instruction>`.
  - **After the blocks:** either nothing (request is empty), or exactly `\n\n<user-request>\n` + R + `\n</user-request>` to the end of the text, where R is the request.
  - **Legacy form** (only when the text does not start with the chained form):
    ```
    <skill name="N" location="P">\n…\n</skill>
    ```
    It is optionally followed by `\n\n` and then any text, which becomes the request.
  - Anything else returns None.
- In pi `user` messages, each text block is passed to `parse_skill_prompt`. On `Some((skills, request))`, the `User` item gets:
  - text = `request` if it is not empty, else the Skills as `/skill:<name>` joined by a single space;
  - `skills`.

- [ ] **Step 1: Write the failing tests** (in `skill_prompt.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn block(n: &str, p: &str) -> String {
        format!("The user explicitly invoked the \"{n}\" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name=\"{n}\" location=\"{p}\">\n# {n}\nbody\n</skill-instruction>")
    }
    fn s(n: &str, p: &str) -> SkillUse { SkillUse { name: n.into(), path: p.into() } }
    #[test]
    fn one_skill_with_request() {
        let t = format!("{}\n\n<user-request>\nfix the bug\n</user-request>", block("review", "/h/.pi/skills/review/SKILL.md"));
        assert_eq!(parse_skill_prompt(&t), Some((vec![s("review", "/h/.pi/skills/review/SKILL.md")], "fix the bug".into())));
    }
    #[test]
    fn chained_skills_without_request() {
        let t = format!("{}\n\n{}", block("a", "/a/SKILL.md"), block("b", "/b/SKILL.md"));
        assert_eq!(parse_skill_prompt(&t), Some((vec![s("a", "/a/SKILL.md"), s("b", "/b/SKILL.md")], "".into())));
    }
    #[test]
    fn legacy_form() {
        let t = "<skill name=\"tdd\" location=\"/t/SKILL.md\">\nbody\n</skill>\n\nwrite tests";
        assert_eq!(parse_skill_prompt(t), Some((vec![s("tdd", "/t/SKILL.md")], "write tests".into())));
        let bare = "<skill name=\"tdd\" location=\"/t/SKILL.md\">\nbody\n</skill>";
        assert_eq!(parse_skill_prompt(bare), Some((vec![s("tdd", "/t/SKILL.md")], "".into())));
    }
    #[test]
    fn near_misses_are_none() {
        assert_eq!(parse_skill_prompt("just text"), None);
        let mismatch = block("a", "/a/SKILL.md").replacen("name=\"a\"", "name=\"b\"", 1);
        assert_eq!(parse_skill_prompt(&mismatch), None);
        let trailing = format!("{}\n\nloose text", block("a", "/a/SKILL.md"));
        assert_eq!(parse_skill_prompt(&trailing), None);
        let unclosed = block("a", "/a/SKILL.md").replace("\n</skill-instruction>", "");
        assert_eq!(parse_skill_prompt(&unclosed), None);
    }
}
```

And in `pi.rs` tests:

```rust
#[test]
fn skill_prompt_becomes_request_and_skills() {
    let mut p = PiParser::default();
    let text = "<skill name=\"tdd\" location=\"/t/SKILL.md\">\nbody\n</skill>";
    let line = serde_json::json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":[{"type":"text","text":text}]}}).to_string();
    match p.push_line(&line, &mut vec![]) {
        ParserOutput::Append(v) => assert_eq!(v, vec![User {
            ts: None, text: "/skill:tdd".into(), images: vec![],
            skills: vec![SkillUse { name: "tdd".into(), path: "/t/SKILL.md".into() }],
        }]),
        o => panic!("{o:?}"),
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test transcript::`
Expected: compile error or FAIL (`parse_skill_prompt` is missing).

- [ ] **Step 3: Implement `parse_skill_prompt` and the hook-up in `pi.rs`.**

- [ ] **Step 4: Run the Rust suite**

Run: `cd src-tauri && cargo test && cargo clippy -- -D warnings`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/transcript
git commit -m "feat(chat): show a pi Skill invocation as its request and the Skill"
```

### Task 6: Frontend types, IPC, meta in the store and the Composer label

**Files:**
- Modify:
  - `src/lib/types.ts`;
  - `src/lib/ipc.ts`;
  - `src/chat/chatStore.ts`;
  - `src/chat/ChatLens.tsx` (pass `meta={state.meta}` to `Composer`);
  - `src/chat/Composer.tsx`;
  - `src/styles.css`.
- Create: `src/chat/modelLabel.ts`.
- Test:
  - `src/chat/chatStore.test.ts`;
  - `src/chat/modelLabel.test.ts`;
  - `src/chat/Composer.test.tsx`.

**Interfaces:**
- Produces, in `types.ts`:
  - `export interface ImageRef { ref: string; media_type: string }`;
  - `export interface SkillUse { name: string; path: string }`;
  - `export interface ChatMeta { model: string | null; effort: string | null }`;
  - `user` gains `images?: ImageRef[]; skills?: SkillUse[]`, and `tool_result` gains `images?: ImageRef[]`;
  - `ChatEvent` gains `| { type: "meta"; model: string | null; effort: string | null }`.
- Produces, in `ipc.ts`: `export const chatImage = (p: PaneRef, ref: string) => invoke<ArrayBuffer>("chat_image", { machineId: p.machine_id, session: p.session, paneId: p.pane_id, ref })`.
- Produces, in `chatStore.ts`:
  - `ChatState.meta: ChatMeta`, starting as `{ model: null, effort: null }` in `emptyChat`;
  - a `reset` keeps `state.meta`;
  - a `meta` event replaces it.
- Produces: `modelLabel(meta: ChatMeta | undefined): string | null` in `src/chat/modelLabel.ts`.
- `Composer` gets a new optional prop, `meta?: ChatMeta`. It renders `<span className="composer-model" title="Model · reasoning effort">{label}</span>` immediately before the Stop/Send buttons in `.composer-bar`, only when the label is not null. CSS: dim text (`var(--fg-3)`), 11.5px, `margin-left: auto`, `min-width: 0`, and one-line ellipsis.

- [ ] **Step 1: Write the failing tests**

```ts
// src/chat/modelLabel.test.ts
import { describe, expect, it } from "vitest";
import { modelLabel } from "./modelLabel";
describe("modelLabel", () => {
  it("joins the Model and effort, or shows whichever is known", () => {
    expect(modelLabel({ model: "claude-opus-5-5", effort: "high" })).toBe("claude-opus-5-5 · high");
    expect(modelLabel({ model: "claude-opus-5-5", effort: null })).toBe("claude-opus-5-5");
    expect(modelLabel({ model: null, effort: "off" })).toBe("off");
    expect(modelLabel({ model: null, effort: null })).toBeNull();
    expect(modelLabel(undefined)).toBeNull();
  });
});
```

```ts
// added to src/chat/chatStore.test.ts (import emptyChat and reduce if not imported)
it("keeps the latest meta across resets", () => {
  let s = reduce(emptyChat, { type: "meta", model: "m", effort: "high" });
  expect(s.meta).toEqual({ model: "m", effort: "high" });
  s = reduce(s, { type: "reset", items: [], total: 0 });
  expect(s.meta).toEqual({ model: "m", effort: "high" });
});
```

```tsx
// added to src/chat/Composer.test.tsx
describe("Composer model label", () => {
  it("shows the Model and effort when known", () => {
    render(<Composer pane={pane} agent="claude" meta={{ model: "claude-opus-5-5", effort: "high" }} />);
    const label = screen.getByTitle("Model · reasoning effort");
    expect(label.textContent).toBe("claude-opus-5-5 · high");
  });
  it("shows nothing when neither is known", () => {
    render(<Composer pane={pane} agent="claude" meta={{ model: null, effort: null }} />);
    expect(screen.queryByTitle("Model · reasoning effort")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/chat/modelLabel.test.ts src/chat/chatStore.test.ts src/chat/Composer.test.tsx`
Expected: FAIL (module missing, `meta` undefined, label missing).

- [ ] **Step 3: Implement the interfaces above.** Also add `meta` to any other `ChatState` literal the compiler flags.

- [ ] **Step 4: Run the frontend suite**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(chat): show the Model and reasoning effort in the Composer"
```

### Task 7: Images in the Chat lens

**Files:**
- Create: `src/chat/images.tsx`.
- Test: `src/chat/images.test.tsx`.
- Modify:
  - `src/chat/ChatItemView.tsx` (user and tool result rendering);
  - `src/chat/ChatLens.tsx` (context provider, revoke on close);
  - `src/styles.css`.

**Interfaces:**
- Consumes: `chatImage` from `../lib/ipc` and `ImageRef` (Task 6).
- Produces, in `images.tsx`:
  - `export const ChatPaneContext = createContext<PaneRef | null>(null)`.
  - `export function useChatImage(pane: PaneRef, image: ImageRef): { url: string | null; failed: boolean }`.
    - It caches a `Promise<string>` per `` `${paneKey(pane)}\n${image.ref}` `` in a module-level `Map`.
    - The promise wraps the bytes in `new Blob([bytes], { type: image.media_type })` and `URL.createObjectURL`.
    - A rejected entry is removed from the cache, so a later mount retries.
  - `export function revokeChatImages(key: string): void`. It revokes every resolved URL whose cache key starts with `` `${key}\n` `` and deletes those entries.
  - `export function ChatImages({ images }: { images: ImageRef[] }): JSX.Element | null`.
    - It reads the Pane from `ChatPaneContext` and renders nothing without it.
    - It renders `<div className="chat-images">`, with each image as `<button className="chat-image" aria-label="Open image N">` wrapping `<img alt="Image N">`.
    - A failed image renders `<div className="chat-image-missing">Image unavailable</div>`.
    - A click opens `ImageViewer`.
  - `function ImageViewer({ url, onClose })`: `<div className="image-viewer" role="dialog" aria-label="Image">` with the `<img>`. It closes on Escape (a keydown listener on `window`) and on a click of the backdrop, but not on the image itself.
- In `ChatItemView`:
  - **User case:** render `<ChatImages images={item.images} />` above the bubble when `item.images?.length`, and render the bubble only when `item.text !== ""`.
  - **Tool call body:** when the result has `images?.length`, render `<ChatImages images={result.images} />` above the result `<pre>`.
  - **Standalone `tool_result` case:** same, above its `<pre>`.
- In `ChatLens`:
  - wrap the returned tree in `<ChatPaneContext.Provider value={pane}>`;
  - in the `[key]` effect's cleanup, call `revokeChatImages(key)`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/chat/images.test.tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ chatImage: vi.fn() }));
import { chatImage } from "../lib/ipc";
import { ChatImages, ChatPaneContext, revokeChatImages } from "./images";

const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const key = "devtuf/default/w1:p1";
const png = { ref: "u1:0", media_type: "image/png" };
let n = 0;
beforeEach(() => {
  revokeChatImages(key);
  vi.mocked(chatImage).mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  URL.createObjectURL = vi.fn(() => `blob:${++n}`);
  URL.revokeObjectURL = vi.fn();
});
const show = (images = [png]) =>
  render(<ChatPaneContext.Provider value={pane}><ChatImages images={images} /></ChatPaneContext.Provider>);

describe("ChatImages", () => {
  it("shows a thumbnail from the bytes", async () => {
    show();
    const img = await screen.findByRole("img", { name: "Image 1" });
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(chatImage).toHaveBeenCalledWith(pane, "u1:0");
  });

  it("says when an image is unavailable", async () => {
    vi.mocked(chatImage).mockRejectedValueOnce({ code: "not_found", message: "image not available" });
    show();
    expect(await screen.findByText("Image unavailable")).toBeTruthy();
  });

  it("caches per pane and ref", async () => {
    const first = show();
    await screen.findByRole("img", { name: "Image 1" });
    first.unmount();
    show();
    await screen.findByRole("img", { name: "Image 1" });
    expect(chatImage).toHaveBeenCalledTimes(1);
    revokeChatImages(key);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("opens a viewer on click and closes it on Escape", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Open image 1" }));
    expect(screen.getByRole("dialog", { name: "Image" })).toBeTruthy();
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders nothing outside a chat pane", () => {
    const { container } = render(<ChatImages images={[png]} />);
    expect(container.innerHTML).toBe("");
  });
});
```

```tsx
// added to src/chat/ChatItemView.test.tsx (mock ../lib/ipc's chatImage the same way; wrap renders in ChatPaneContext.Provider)
it("shows a user turn's images above an image-only bubble", async () => {
  render(<ChatPaneContext.Provider value={{ machine_id: "m", session: "s", pane_id: "p" }}>
    <ChatItemView item={{ kind: "user", text: "", images: [{ ref: "u:0", media_type: "image/png" }] }} copy />
  </ChatPaneContext.Provider>);
  expect(await screen.findByRole("img", { name: "Image 1" })).toBeTruthy();
  expect(document.querySelector(".chat-bubble")).toBeNull();
});
```

`ChatItemView.test.tsx` has no `vi.mock` of `../lib/ipc` today. Add `vi.mock("../lib/ipc", () => ({ chatImage: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer) }))`. Also stub `URL.createObjectURL = vi.fn(() => "blob:x")` in that test.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/chat/images.test.tsx src/chat/ChatItemView.test.tsx`
Expected: FAIL (module `./images` missing).

- [ ] **Step 3: Implement the interfaces above, plus the CSS.**
- `.chat-images`: a flex row with 6px gap, wrapping.
- `.chat-image`: 64px square, cover fit, `--r-sm` radius, `--line-2` border, no padding.
- `.chat-image-missing`: the same box with dim 11px text, centered.
- `.image-viewer`: a fixed full-window overlay with a dark backdrop. The `img` uses `max-width: 92vw; max-height: 92vh`.
- `.chat-user`: becomes a column, aligned to the end.

- [ ] **Step 4: Run the frontend suite**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(chat): show images from the transcript in user turns and tool results"
```

### Task 8: Skill chips

**Files:**
- Create: `src/chat/skills.tsx`.
- Test: `src/chat/skills.test.tsx`.
- Modify:
  - `src/chat/WorkBlockView.tsx`;
  - `src/chat/ChatItemView.tsx` (user case);
  - `src/styles.css`.

**Interfaces:**
- Consumes: `SkillUse` (Task 6), `ToolResult` from `./workBlocks`, and `BookIcon` from `../ui/icons`.
- Produces:
  - `export interface SkillChip { name: string; status: "requested" | "loaded" | "failed"; path?: string }`.
  - `export function turnSkills(items: ChatItem[], results: Map<string, ToolResult>): SkillChip[]`.
    - It takes every `tool_call` with `name === "Skill"` whose `input.skill` is a string of 1 to 200 chars with no `\r`, `\n`, `<` or `>`.
    - Status comes from `results.get(call.id)`: none → `requested`, `is_error` → `failed`, else `loaded`.
    - It keeps one chip per name, at its first position, with the status of the latest use.
  - `export function SkillChips({ chips }: { chips: SkillChip[] }): JSX.Element | null`.
    - It renders null for an empty list.
    - Otherwise `<div className="skill-chips">`, with each chip as `<span className="skill-chip" title={path}>`. The span holds `<BookIcon />`, the name, and `<span className="skill-chip-status">{status}</span>`.
- `WorkBlockView` computes `turnSkills(block.items, results)` and renders `<SkillChips>` right after the header button, outside the `open &&` rows.
- In `ChatItemView`'s user case, when `item.skills?.length`, render `<SkillChips chips={item.skills.map(s => ({ name: s.name, path: s.path, status: "loaded" }))} />` under the bubble.
- CSS: `.skill-chips` is a flex row with 6px gap, wrapping, and 4px top margin. `.skill-chip` is an inline pill: 22px high, 999px radius, `--line-2` border, 12px text, `--fg-2`, with a 12px icon. `.skill-chip-status` is `--fg-3`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/chat/skills.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../lib/types";
import { WorkBlockView } from "./WorkBlockView";
import { ChatItemView } from "./ChatItemView";
import { turnSkills } from "./skills";
import type { ToolResult, WorkBlock } from "./workBlocks";

const call = (id: string, skill: unknown): ChatItem => ({ kind: "tool_call", id, name: "Skill", input_summary: String(skill), input: { skill } });
const result = (id: string, is_error: boolean): ToolResult => ({ kind: "tool_result", call_id: id, output: "", is_error });

describe("turnSkills", () => {
  it("reads status from the result and keeps the latest use per name", () => {
    const items = [call("1", "tdd"), call("2", "review"), call("3", "tdd"), call("4", "bad\nname"), { kind: "tool_call", id: "5", name: "Bash", input_summary: "", input: { skill: "x" } } as ChatItem];
    const results = new Map([["1", result("1", true)], ["3", result("3", false)]]);
    expect(turnSkills(items, results)).toEqual([
      { name: "tdd", status: "loaded" },
      { name: "review", status: "requested" },
    ]);
  });
  it("marks a failed use", () => {
    expect(turnSkills([call("1", "tdd")], new Map([["1", result("1", true)]]))).toEqual([{ name: "tdd", status: "failed" }]);
  });
});

describe("Skill chips", () => {
  it("shows chips while folded", () => {
    const block: WorkBlock = { id: "b", items: [call("1", "tdd")], start: null, end: null };
    render(<WorkBlockView block={block} results={new Map()} open={false} onToggle={() => {}} live={false} />);
    expect(screen.getByText("tdd")).toBeTruthy();
    expect(screen.getByText("requested")).toBeTruthy();
  });
  it("shows a pi Skill under the user bubble", () => {
    render(<ChatItemView item={{ kind: "user", text: "/skill:tdd", skills: [{ name: "tdd", path: "/t/SKILL.md" }] }} />);
    const chip = screen.getByText("tdd").closest(".skill-chip")!;
    expect(chip.getAttribute("title")).toBe("/t/SKILL.md");
    expect(screen.getByText("loaded")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/chat/skills.test.tsx`
Expected: FAIL (module `./skills` missing).

- [ ] **Step 3: Implement the interfaces above.**

- [ ] **Step 4: Run the frontend suite**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(chat): show Skill chips on the turns that used a Skill"
```

### Task 9: Credits and full verification

**Files:**
- Modify: `THIRD_PARTY_NOTICES.md` (the herdr-web-ui paragraph).

- [ ] **Step 1: Extend the herdr-web-ui paragraph's list** with: "the Transcript image extraction in `src-tauri/src/transcript/claude.rs`, `pi.rs` and `images.rs`, the Model and Reasoning effort rules, the pi skill-prompt format in `src-tauri/src/transcript/skill_prompt.rs`, and `turnSkills` in `src/chat/skills.tsx`". Keep the sentence's existing order and its ending.

- [ ] **Step 2: Run everything**

Run: `cd src-tauri && cargo test && cargo clippy -- -D warnings && cd .. && pnpm vitest run && pnpm typecheck`
Expected: all pass, zero warnings.

- [ ] **Step 3: Commit**

```bash
git add THIRD_PARTY_NOTICES.md
git commit -m "docs: credit herdr-web-ui for the transcript extras"
```
