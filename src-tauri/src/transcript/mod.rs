//! Transcript discovery and streaming: find an agent's JSONL transcript on a Machine and
//! tail it into chat items.
pub mod claude;
pub mod images;
pub mod locate;
pub mod pi;
pub mod tail;

use crate::error::AppError;
use crate::view::PaneRef;
use images::ImageSink;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

pub use locate::{locate, Located};
pub use tail::{spawn_tail, TailHandle};

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

/// The Model and Reasoning effort an Agent reports in its Transcript.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ChatMeta {
    pub model: Option<String>,
    pub effort: Option<String>,
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
    /// The latest Model and Reasoning effort seen so far.
    fn meta(&self) -> ChatMeta {
        ChatMeta::default()
    }
}

/// A Model or Reasoning effort value fit to show: not empty, at most 100 chars, not a
/// `<placeholder>`.
#[allow(dead_code)] // the parsers start using it in later changes
pub(crate) fn meta_label(s: &str) -> Option<String> {
    if s.is_empty() || s.chars().count() > 100 || s.starts_with('<') {
        None
    } else {
        Some(s.to_string())
    }
}

const MAX_RESULT_BYTES: usize = 16 * 1024;

/// Truncates a tool result to at most 16 KiB on a char boundary, marking the cut.
pub(crate) fn truncate_result(s: String) -> String {
    if s.len() <= MAX_RESULT_BYTES {
        return s;
    }
    let mut end = MAX_RESULT_BYTES;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &s[..end])
}

/// The transcript parser for an agent.
#[allow(clippy::default_constructed_unit_structs)] // ClaudeParser gains state in a later change
pub fn parser_for(agent: &str) -> Option<Box<dyn Parser>> {
    match agent {
        "claude" => Some(Box::new(claude::ClaudeParser::default())),
        "pi" => Some(Box::new(pi::PiParser::default())),
        _ => None,
    }
}

/// One live transcript tail per Pane.
#[derive(Default)]
pub struct ChatManager {
    handles: Mutex<HashMap<PaneRef, TailHandle>>,
}

impl ChatManager {
    /// Registers `handle` for `pane`, dropping (and so killing) any previous tail.
    pub fn insert(&self, pane: PaneRef, handle: TailHandle) {
        let old = self.handles.lock().unwrap().insert(pane, handle);
        drop(old);
    }

    pub fn close(&self, pane: &PaneRef) {
        let old = self.handles.lock().unwrap().remove(pane);
        drop(old);
    }

    pub fn page(&self, pane: &PaneRef, before: usize, limit: usize) -> Option<Vec<ChatItem>> {
        self.handles
            .lock()
            .unwrap()
            .get(pane)
            .map(|h| h.page(before, limit))
    }

    /// The bytes of the image `r` in the Pane's open chat.
    pub fn image(&self, pane: &PaneRef, r: &str) -> Result<Vec<u8>, AppError> {
        let map = self.handles.lock().unwrap();
        let handle = map
            .get(pane)
            .ok_or_else(|| AppError::new("not_found", "no open chat for this pane"))?;
        handle
            .image(r)
            .map(|(_, bytes)| bytes)
            .ok_or_else(|| AppError::new("not_found", "image not available"))
    }

    /// End every tail of the Machine (it was disconnected or removed).
    pub fn close_machine(&self, machine_id: &str) {
        let gone: Vec<TailHandle> = {
            let mut map = self.handles.lock().unwrap();
            let keys: Vec<PaneRef> = map
                .keys()
                .filter(|p| p.machine_id == machine_id)
                .cloned()
                .collect();
            keys.into_iter().filter_map(|k| map.remove(&k)).collect()
        };
        drop(gone);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

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
            chats.insert(pane(m), h);
        }
        chats.close_machine("a");
        assert!(chats.page(&pane("a"), 0, 1).is_none());
        assert!(chats.page(&pane("b"), 0, 1).is_some());
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
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "type": "meta", "model": "m", "effort": null })
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
