//! Transcript discovery and streaming: find an agent's JSONL transcript on a Machine and
//! tail it into chat items.
pub mod claude;
pub mod locate;
pub mod pi;
pub mod tail;

use crate::error::AppError;
use crate::view::PaneRef;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

pub use locate::{locate, Located};
pub use tail::{spawn_tail, TailHandle};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatItem {
    User {
        text: String,
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
    Reset { items: Vec<ChatItem>, total: usize },
    Append { items: Vec<ChatItem> },
    Error { error: AppError },
}

#[derive(Debug)]
pub enum ParserOutput {
    None,
    Append(Vec<ChatItem>),
    Reset(Vec<ChatItem>),
}

pub trait Parser: Send {
    fn push_line(&mut self, line: &str) -> ParserOutput;
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
pub fn parser_for(agent: &str) -> Option<Box<dyn Parser>> {
    match agent {
        "claude" => Some(Box::new(claude::ClaudeParser)),
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
        fn push_line(&mut self, _: &str) -> ParserOutput {
            ParserOutput::None
        }
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
            ts: Some("2026-10-03T00:00:00Z".into()),
        })
        .unwrap();
        assert_eq!(with["ts"], "2026-10-03T00:00:00Z");
        let without = serde_json::to_value(ChatItem::User {
            text: "a".into(),
            ts: None,
        })
        .unwrap();
        assert!(without.get("ts").is_none());
    }
}
