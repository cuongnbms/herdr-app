//! Transcript discovery and streaming: find an agent's JSONL transcript on a Machine and
//! tail it into chat items.
pub mod claude;
pub mod locate;
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
    User { text: String },
    AssistantText { markdown: String },
    Thinking { text: String },
    ToolCall { id: String, name: String, input_summary: String, input: Value },
    ToolResult { call_id: String, output: String, is_error: bool },
    System { text: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    Reset { items: Vec<ChatItem>, total: usize },
    Append { items: Vec<ChatItem> },
    Error { error: AppError },
}

pub enum ParserOutput {
    None,
    Append(Vec<ChatItem>),
    Reset(Vec<ChatItem>),
}

pub trait Parser: Send {
    fn push_line(&mut self, line: &str) -> ParserOutput;
}

/// The transcript parser for an agent; `claude` lands in Task 15, `pi` in Task 16.
pub fn parser_for(agent: &str) -> Option<Box<dyn Parser>> {
    match agent {
        "claude" => Some(Box::new(claude::ClaudeParser::default())),
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
        self.handles.lock().unwrap().get(pane).map(|h| h.page(before, limit))
    }
}
