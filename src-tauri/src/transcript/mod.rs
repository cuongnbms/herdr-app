//! Transcript discovery and streaming: find an agent's JSONL transcript on a Machine and
//! tail it into chat items.
pub mod claude;
pub mod images;
pub mod locate;
pub mod pi;
mod skill_prompt;
pub mod tail;

use crate::error::AppError;
use crate::view::PaneRef;
use images::ImageSink;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

pub use locate::{locate, Located};
pub use tail::{spawn_tail, Sink, TailHandle};

/// An image attached to a chat item; its bytes are fetched by `reference`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ImageRef {
    #[serde(rename = "ref")]
    pub reference: String,
    pub media_type: String,
}

/// A Skill the user invoked in a message.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SkillUse {
    pub name: String,
    pub path: String,
}

/// The Model, Reasoning effort and context size an Agent reports in its Transcript.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ChatMeta {
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Tokens the last main-thread reply took in and gave out: how full the context is.
    pub context_tokens: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatItem {
    User {
        text: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        skills: Vec<SkillUse>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    AssistantText {
        markdown: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    Thinking {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    ToolCall {
        id: String,
        name: String,
        input_summary: String,
        input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    ToolResult {
        call_id: String,
        output: String,
        is_error: bool,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
    System {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ts: Option<String>,
    },
}

impl ChatItem {
    /// When the transcript record that produced this item was written (ISO 8601), if it says.
    pub fn ts(&self) -> Option<&str> {
        match self {
            ChatItem::User { ts, .. }
            | ChatItem::AssistantText { ts, .. }
            | ChatItem::Thinking { ts, .. }
            | ChatItem::ToolCall { ts, .. }
            | ChatItem::ToolResult { ts, .. }
            | ChatItem::System { ts, .. } => ts.as_deref(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    Reset {
        items: Vec<ChatItem>,
        total: usize,
    },
    Append {
        items: Vec<ChatItem>,
    },
    Error {
        error: AppError,
    },
    Meta {
        model: Option<String>,
        effort: Option<String>,
        context_tokens: Option<u64>,
    },
}

#[derive(Debug)]
pub enum ParserOutput {
    None,
    Append(Vec<ChatItem>),
    Reset(Vec<ChatItem>),
}

pub trait Parser: Send {
    fn push_line(&mut self, line: &str, images: &mut dyn ImageSink) -> ParserOutput;
    /// The latest Model, Reasoning effort and context size seen so far.
    fn meta(&self) -> ChatMeta {
        ChatMeta::default()
    }
}

/// A Model or Reasoning effort value fit to show: not empty, at most 100 chars, not a
/// `<placeholder>`.
pub(crate) fn meta_label(s: &str) -> Option<String> {
    if s.is_empty() || s.chars().count() > 100 || s.starts_with('<') {
        None
    } else {
        Some(s.to_string())
    }
}

const MAX_RESULT_BYTES: usize = 16 * 1024;
pub(crate) const MAX_INPUT_STRING_BYTES: usize = 64 * 1024;

/// Cuts `s` to at most `max` bytes on a char boundary, marking the cut.
fn cut(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &s[..end])
}

/// Truncates a tool result to at most 16 KiB on a char boundary, marking the cut.
pub(crate) fn truncate_result(s: String) -> String {
    cut(s, MAX_RESULT_BYTES)
}

/// Caps every string in a tool input at 64 KiB, keeping all fields, so a huge Write
/// or Edit can't bloat the Chat.
pub(crate) fn cap_input(v: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::String(s) => Value::String(cut(s, MAX_INPUT_STRING_BYTES)),
        Value::Array(a) => Value::Array(a.into_iter().map(cap_input).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, cap_input(v))).collect()),
        other => other,
    }
}

/// The transcript parser for an agent.
pub fn parser_for(agent: &str) -> Option<Box<dyn Parser>> {
    match agent {
        "claude" => Some(Box::new(claude::ClaudeParser::default())),
        "pi" => Some(Box::new(pi::PiParser::default())),
        _ => None,
    }
}

/// Closed tails kept running, so reopening skips the backlog.
pub const PARKED_TAILS: usize = 3;

struct Entry {
    path: String,
    handle: TailHandle,
}

#[derive(Default)]
struct Tails {
    open: HashMap<PaneRef, Entry>,
    /// Oldest first.
    parked: VecDeque<(PaneRef, Entry)>,
}

/// One live transcript tail per open Pane, plus up to 3 parked ones.
#[derive(Default)]
pub struct ChatManager {
    tails: Mutex<Tails>,
}

impl ChatManager {
    /// Registers `handle` for `pane`, dropping (and so killing) any previous tail of it.
    pub fn insert(&self, pane: PaneRef, path: String, handle: TailHandle) {
        let gone = {
            let mut t = self.tails.lock().unwrap();
            let mut gone: Vec<Entry> = t.open.remove(&pane).into_iter().collect();
            if let Some(i) = t.parked.iter().position(|(p, _)| p == &pane) {
                gone.extend(t.parked.remove(i).map(|(_, e)| e));
            }
            t.open.insert(pane, Entry { path, handle });
            gone
        };
        drop(gone);
    }

    /// Reopens the Pane's tail onto `sink` if it is still tailing `path`; false if there
    /// is none (a stale one is dropped), and the caller must spawn a fresh tail.
    pub fn reattach(&self, pane: &PaneRef, path: &str, sink: Sink) -> bool {
        let entry = {
            let mut t = self.tails.lock().unwrap();
            match t.open.remove(pane) {
                Some(e) => Some(e),
                None => t
                    .parked
                    .iter()
                    .position(|(p, _)| p == pane)
                    .and_then(|i| t.parked.remove(i))
                    .map(|(_, e)| e),
            }
        };
        let Some(entry) = entry else { return false };
        if entry.path != path || !entry.handle.is_running() {
            drop(entry);
            return false;
        }
        // `attach` locks the image store, so the map lock is already released.
        entry.handle.attach(sink);
        self.tails.lock().unwrap().open.insert(pane.clone(), entry);
        true
    }

    /// Parks the Pane's tail; the oldest parked ones past `PARKED_TAILS` are dropped.
    pub fn close(&self, pane: &PaneRef) {
        let entry = self.tails.lock().unwrap().open.remove(pane);
        let Some(entry) = entry else { return };
        entry.handle.detach();
        let gone: Vec<(PaneRef, Entry)> = {
            let mut t = self.tails.lock().unwrap();
            t.parked.push_back((pane.clone(), entry));
            let extra = t.parked.len().saturating_sub(PARKED_TAILS);
            t.parked.drain(..extra).collect()
        };
        drop(gone);
    }

    pub fn page(&self, pane: &PaneRef, before: usize, limit: usize) -> Option<Vec<ChatItem>> {
        self.tails
            .lock()
            .unwrap()
            .open
            .get(pane)
            .map(|e| e.handle.page(before, limit))
    }

    /// The bytes of the image `r` in the Pane's open chat.
    pub fn image(&self, pane: &PaneRef, r: &str) -> Result<Vec<u8>, AppError> {
        // The tail locks the store only briefly, but `tails` must still not be held
        // while locking it.
        let store = self
            .tails
            .lock()
            .unwrap()
            .open
            .get(pane)
            .map(|e| e.handle.images())
            .ok_or_else(|| AppError::new("not_found", "no open chat for this pane"))?;
        let found = store.lock().unwrap().get(r);
        found
            .map(|(_, bytes)| bytes)
            .ok_or_else(|| AppError::new("not_found", "image not available"))
    }

    /// End every tail of the Machine, open or parked (it was disconnected or removed).
    pub fn close_machine(&self, machine_id: &str) {
        let (open, parked) = {
            let mut t = self.tails.lock().unwrap();
            let t = &mut *t;
            let keys: Vec<PaneRef> = t
                .open
                .keys()
                .filter(|p| p.machine_id == machine_id)
                .cloned()
                .collect();
            let open: Vec<Entry> = keys.into_iter().filter_map(|k| t.open.remove(&k)).collect();
            let (gone, kept) = std::mem::take(&mut t.parked)
                .into_iter()
                .partition(|(p, _)| p.machine_id == machine_id);
            t.parked = kept;
            (open, gone)
        };
        drop((open, parked));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn caps_each_input_string_and_keeps_every_field() {
        let big = format!("a{}", "é".repeat(40 * 1024)); // 80 KiB; the leading byte makes a 2-byte char straddle the cut
        let v = serde_json::json!({"file_path": "/a", "edits": [{"old_string": big, "new_string": "x"}], "n": 3});
        let out = cap_input(v);
        let old = out["edits"][0]["old_string"].as_str().unwrap();
        assert!(old.ends_with("\n… (truncated)"));
        assert!(old.len() <= MAX_INPUT_STRING_BYTES + "\n… (truncated)".len());
        assert_eq!(out["edits"][0]["new_string"], "x");
        assert_eq!(out["file_path"], "/a");
        assert_eq!(out["n"], 3);
    }

    struct NoItems;
    impl Parser for NoItems {
        fn push_line(&mut self, _: &str, _: &mut dyn ImageSink) -> ParserOutput {
            ParserOutput::None
        }
    }

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
        let pane = PaneRef {
            machine_id: "a".into(),
            session: "default".into(),
            pane_id: "w1:p1".into(),
        };
        chats.insert(
            pane.clone(),
            p.to_string_lossy().into(),
            spawn_tail(
                Arc::new(crate::transport::local::LocalTransport),
                p.to_string_lossy().into(),
                Box::new(OneImage),
                Arc::new(|_| {}),
            ),
        );
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert_eq!(chats.image(&pane, "u:0").unwrap(), vec![1, 2, 3]);
        assert_eq!(
            chats.image(&pane, "u:9").unwrap_err().message,
            "image not available"
        );
        let other = PaneRef {
            pane_id: "w1:p2".into(),
            ..pane
        };
        assert_eq!(
            chats.image(&other, "u:0").unwrap_err().message,
            "no open chat for this pane"
        );
    }

    #[tokio::test]
    async fn image_lookup_lets_go_of_the_handles_while_the_store_is_busy() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "").unwrap();
        let chats = Arc::new(ChatManager::default());
        let pane = PaneRef {
            machine_id: "a".into(),
            session: "default".into(),
            pane_id: "w1:p1".into(),
        };
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(NoItems),
            Arc::new(|_| {}),
        );
        let store = h.images();
        chats.insert(pane.clone(), p.to_string_lossy().into(), h);
        // The tail is mid-line (a long parse holds the store lock).
        let busy = store.lock().unwrap();
        let (c, p2) = (chats.clone(), pane.clone());
        std::thread::spawn(move || {
            let _ = c.image(&p2, "u:0");
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        let (tx, rx) = std::sync::mpsc::channel();
        let c = chats.clone();
        std::thread::spawn(move || {
            tx.send(c.page(&pane, 0, 1).is_some()).unwrap();
        });
        let paged = rx.recv_timeout(std::time::Duration::from_secs(2));
        drop(busy);
        assert_eq!(paged, Ok(true), "chat_page waited on the image store");
    }

    #[tokio::test]
    async fn close_machine_ends_only_that_machines_tails() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "").unwrap();
        let path: String = p.to_string_lossy().into();
        let chats = ChatManager::default();
        let pane = |m: &str| PaneRef {
            machine_id: m.into(),
            session: "default".into(),
            pane_id: "w1:p1".into(),
        };
        for m in ["a", "b"] {
            let h = spawn_tail(
                Arc::new(crate::transport::local::LocalTransport),
                path.clone(),
                Box::new(NoItems),
                Arc::new(|_| {}),
            );
            chats.insert(pane(m), path.clone(), h);
        }
        chats.close_machine("a");
        assert!(chats.page(&pane("a"), 0, 1).is_none());
        assert!(chats.page(&pane("b"), 0, 1).is_some());
    }

    struct Echo;
    impl Parser for Echo {
        fn push_line(&mut self, line: &str, _: &mut dyn ImageSink) -> ParserOutput {
            let item = ChatItem::User { ts: None, text: line.into(), images: vec![], skills: vec![] };
            if line == "RESET" { ParserOutput::Reset(vec![item]) } else { ParserOutput::Append(vec![item]) }
        }
    }
    fn pane(id: &str) -> PaneRef {
        PaneRef { machine_id: "a".into(), session: "default".into(), pane_id: id.into() }
    }
    fn recorder() -> (Sink, Arc<std::sync::Mutex<Vec<ChatEvent>>>) {
        let got: Arc<std::sync::Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        (Arc::new(move |e| g.lock().unwrap().push(e)), got)
    }
    fn open(chats: &ChatManager, p: &PaneRef, path: &std::path::Path) -> Arc<std::sync::Mutex<Vec<ChatEvent>>> {
        let (sink, got) = recorder();
        let path: String = path.to_string_lossy().into();
        if !chats.reattach(p, &path, sink.clone()) {
            chats.insert(p.clone(), path.clone(), spawn_tail(Arc::new(crate::transport::local::LocalTransport), path, Box::new(Echo), sink));
        }
        got
    }

    #[tokio::test]
    async fn reopening_a_parked_tail_resets_from_kept_items() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\nb\n").unwrap();
        let chats = ChatManager::default();
        let first = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        chats.close(&pane("p1"));
        assert!(chats.page(&pane("p1"), 2, 10).is_none(), "a parked tail is not open");
        use std::io::Write;
        // A pi-style branch switch while parked.
        std::fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(b"RESET\n").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let second = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let ev = second.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { items, total: 1 } if items.len() == 1), "{ev:?}");
        assert_eq!(ev.iter().filter(|e| matches!(e, ChatEvent::Reset { .. })).count(), 1);
        assert!(!first.lock().unwrap().iter().any(|e| matches!(e, ChatEvent::Reset { total: 1, .. })), "the closed lens got events");
    }

    #[tokio::test]
    async fn close_then_open_within_a_tick_still_resets_once() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        chats.close(&pane("p1"));
        let again = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let ev = again.lock().unwrap();
        assert_eq!(ev.iter().filter(|e| matches!(e, ChatEvent::Reset { total: 1, .. })).count(), 1, "{ev:?}");
    }

    #[tokio::test]
    async fn a_parked_tail_mid_backlog_sends_its_first_reset_once() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.close(&pane("p1")); // before any Reset was sent
        let again = open(&chats, &pane("p1"), &f);
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let ev = again.lock().unwrap();
        assert_eq!(ev.iter().filter(|e| matches!(e, ChatEvent::Reset { .. })).count(), 1, "{ev:?}");
    }

    #[tokio::test]
    async fn a_fourth_park_drops_the_oldest_and_other_paths_start_fresh() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        let g = d.path().join("u.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        std::fs::write(&g, "z\n").unwrap();
        let chats = ChatManager::default();
        for id in ["p1", "p2", "p3", "p4"] {
            open(&chats, &pane(id), &f);
            chats.close(&pane(id));
        }
        let (sink, _) = recorder();
        assert!(!chats.reattach(&pane("p1"), &f.to_string_lossy(), sink.clone()), "p1 should have been dropped");
        assert!(!chats.reattach(&pane("p4"), &g.to_string_lossy(), sink.clone()), "another path must not reattach");
        assert!(chats.reattach(&pane("p3"), &f.to_string_lossy(), sink));
    }

    #[tokio::test]
    async fn a_dead_parked_tail_is_not_reattached() {
        struct Gone;
        #[async_trait::async_trait]
        impl crate::transport::Transport for Gone {
            fn wrap(&self, _: &[String], _: bool) -> Vec<String> { vec!["true".into()] }
            async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
            async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
        }
        let chats = ChatManager::default();
        let (sink, _) = recorder();
        chats.insert(pane("p1"), "/x".into(), spawn_tail(Arc::new(Gone), "/x".into(), Box::new(Echo), sink.clone()));
        chats.close(&pane("p1"));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!chats.reattach(&pane("p1"), "/x", sink));
    }

    #[tokio::test]
    async fn close_machine_drops_parked_tails() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.jsonl");
        std::fs::write(&f, "a\n").unwrap();
        let chats = ChatManager::default();
        open(&chats, &pane("p1"), &f);
        chats.close(&pane("p1"));
        chats.close_machine("a");
        let (sink, _) = recorder();
        assert!(!chats.reattach(&pane("p1"), &f.to_string_lossy(), sink));
    }

    #[test]
    fn serializes_ts_only_when_known() {
        let with = serde_json::to_value(ChatItem::User {
            text: "a".into(),
            images: vec![],
            skills: vec![],
            ts: Some("2026-10-03T00:00:00Z".into()),
        })
        .unwrap();
        assert_eq!(with["ts"], "2026-10-03T00:00:00Z");
        let without = serde_json::to_value(ChatItem::User {
            text: "a".into(),
            images: vec![],
            skills: vec![],
            ts: None,
        })
        .unwrap();
        assert!(without.get("ts").is_none());
    }

    #[test]
    fn omits_empty_images_and_skills() {
        let v = serde_json::to_value(ChatItem::User {
            text: "a".into(),
            images: vec![],
            skills: vec![],
            ts: None,
        })
        .unwrap();
        assert!(v.get("images").is_none() && v.get("skills").is_none());
        let v = serde_json::to_value(ChatItem::ToolResult {
            call_id: "c".into(),
            output: "o".into(),
            is_error: false,
            images: vec![ImageRef {
                reference: "e:0".into(),
                media_type: "image/png".into(),
            }],
            ts: None,
        })
        .unwrap();
        assert_eq!(
            v["images"],
            serde_json::json!([{ "ref": "e:0", "media_type": "image/png" }])
        );
    }

    #[test]
    fn serializes_meta_event() {
        let v = serde_json::to_value(ChatEvent::Meta {
            model: Some("m".into()),
            effort: None,
            context_tokens: Some(42),
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "type": "meta", "model": "m", "effort": null, "context_tokens": 42 })
        );
    }

    #[test]
    fn meta_label_rejects_placeholders() {
        assert_eq!(
            meta_label("claude-opus-5-5"),
            Some("claude-opus-5-5".into())
        );
        assert_eq!(meta_label("<synthetic>"), None);
        assert_eq!(meta_label(""), None);
        assert_eq!(meta_label(&"x".repeat(101)), None);
    }
}
