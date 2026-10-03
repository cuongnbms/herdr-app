//! pi transcript parser: entries form a tree; the visible conversation is the branch from
//! the last entry up to the root.
use super::images::ImageSink;
use super::locate::input_summary;
use super::{truncate_result, ChatItem, Parser, ParserOutput};
use serde_json::Value;
use std::collections::HashMap;

const MAX_BRANCH_BYTES: usize = 64 * 1024 * 1024;
const TOO_LARGE: &str = "Conversation too large to show; use the Terminal lens.";

/// What is kept per entry: just enough to rebuild a branch.
struct Entry {
    parent: Option<String>,
    items: Vec<ChatItem>,
    len: usize,
}

pub struct PiParser {
    entries: HashMap<String, Entry>,
    leaf: Option<String>,
    /// Sum of line lengths along the visible branch.
    branch_bytes: usize,
    limit: usize,
    too_large: bool,
}

impl Default for PiParser {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            leaf: None,
            branch_bytes: 0,
            limit: MAX_BRANCH_BYTES,
            too_large: false,
        }
    }
}

impl PiParser {
    #[cfg(test)]
    fn with_limit(limit: usize) -> Self {
        Self {
            limit,
            ..Self::default()
        }
    }

    fn trip(&mut self) -> ParserOutput {
        self.too_large = true;
        self.entries.clear();
        ParserOutput::Reset(vec![ChatItem::System {
            ts: None,
            text: TOO_LARGE.to_string(),
        }])
    }
}

fn str_of<'a>(v: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .unwrap_or("")
}

fn text_blocks(content: Option<&Value>) -> Vec<String> {
    match content {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str).map(str::to_string))
            .collect(),
        _ => vec![],
    }
}

fn message_items(entry: &Value) -> Vec<ChatItem> {
    let Some(msg) = entry.get("message") else {
        return vec![];
    };
    let hidden = |v: &Value| v.get("display").and_then(Value::as_bool) == Some(false);
    if hidden(entry) || hidden(msg) {
        return vec![];
    }
    let ts = entry
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::to_string);
    let content = msg.get("content");
    match msg.get("role").and_then(Value::as_str).unwrap_or("") {
        "user" => text_blocks(content)
            .into_iter()
            .map(|text| ChatItem::User {
                images: vec![],
                skills: vec![],
                ts: ts.clone(),
                text,
            })
            .collect(),
        "assistant" => {
            let mut items = vec![];
            let Some(Value::Array(blocks)) = content else {
                return items;
            };
            for b in blocks {
                match b.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            items.push(ChatItem::AssistantText {
                                ts: ts.clone(),
                                markdown: t.to_string(),
                            });
                        }
                    }
                    "thinking" => {
                        if let Some(t) = b.get("thinking").and_then(Value::as_str) {
                            items.push(ChatItem::Thinking {
                                ts: ts.clone(),
                                text: t.to_string(),
                            });
                        }
                    }
                    "toolCall" => {
                        let name = str_of(b, &["toolName", "name"]).to_string();
                        let input = ["toolInput", "input", "arguments"]
                            .iter()
                            .find_map(|k| b.get(*k))
                            .cloned()
                            .unwrap_or(Value::Null);
                        items.push(ChatItem::ToolCall {
                            ts: ts.clone(),
                            id: str_of(b, &["toolCallId", "id", "callId"]).to_string(),
                            input_summary: input_summary(&name, &input),
                            name,
                            input,
                        });
                    }
                    _ => {}
                }
            }
            items
        }
        "toolResult" => vec![ChatItem::ToolResult {
            images: vec![],
            ts: ts.clone(),
            call_id: str_of(msg, &["toolCallId", "callId"]).to_string(),
            output: truncate_result(text_blocks(content).join("\n")),
            is_error: msg.get("isError").and_then(Value::as_bool).unwrap_or(false),
        }],
        _ => vec![],
    }
}

impl Parser for PiParser {
    fn push_line(&mut self, line: &str, _images: &mut dyn ImageSink) -> ParserOutput {
        if self.too_large {
            return ParserOutput::None;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("skipping non-JSON transcript line: {e}");
                return ParserOutput::None;
            }
        };
        let Some(id) = v.get("id").and_then(Value::as_str).map(str::to_string) else {
            let record_type = str_of(&v, &["type"]);
            tracing::trace!(record_type, "skipping transcript entry without id");
            return ParserOutput::None;
        };
        let parent = v
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let is_message = v.get("type").and_then(Value::as_str) == Some("message");
        let items = if is_message {
            message_items(&v)
        } else {
            vec![]
        };
        if items.is_empty() {
            tracing::trace!(entry_id = id.as_str(), "transcript entry produces no items");
        }
        let len = line.len();

        let extends_leaf = match (&self.leaf, &parent) {
            (Some(leaf), Some(p)) => leaf == p,
            (None, None) => true,
            _ => false,
        };
        let appended = items.clone();
        if let Some(old) = self
            .entries
            .insert(id.clone(), Entry { parent, items, len })
        {
            tracing::trace!(
                entry_id = id.as_str(),
                old_len = old.len,
                "duplicate entry id replaced"
            );
        }
        self.leaf = Some(id.clone());

        if extends_leaf {
            self.branch_bytes += len;
            if self.branch_bytes > self.limit {
                return self.trip();
            }
            return if appended.is_empty() {
                ParserOutput::None
            } else {
                ParserOutput::Append(appended)
            };
        }

        // Branch switch (or unknown parent): rebuild the path from the new leaf to the root.
        let mut path = vec![];
        let mut bytes = 0usize;
        let mut cursor = Some(id);
        while let Some(cur) = cursor {
            let Some(entry) = self.entries.get(&cur) else {
                break;
            };
            if path.len() > self.entries.len() {
                break; // cycle guard
            }
            bytes += entry.len;
            path.push(entry);
            cursor = entry.parent.clone();
        }
        self.branch_bytes = bytes;
        if bytes > self.limit {
            return self.trip();
        }
        let items = path
            .iter()
            .rev()
            .flat_map(|e| e.items.iter().cloned())
            .collect();
        ParserOutput::Reset(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::{ChatItem::*, Parser, ParserOutput};
    fn feed(p: &mut PiParser, text: &str) -> Vec<ParserOutput> {
        text.lines()
            .map(|l| p.push_line(l, &mut Vec::<(String, String, Vec<u8>)>::new()))
            .collect()
    }
    fn appended(outs: Vec<ParserOutput>) -> Vec<ChatItem> {
        outs.into_iter()
            .flat_map(|o| match o {
                ParserOutput::Append(v) => v,
                ParserOutput::Reset(v) => v,
                ParserOutput::None => vec![],
            })
            .collect()
    }

    #[test]
    fn parses_linear_branch() {
        let mut p = PiParser::default();
        let items = appended(feed(&mut p, include_str!("../../tests/fixtures/pi.jsonl")));
        assert_eq!(
            items,
            vec![
                User {
                    images: vec![],
                    skills: vec![],
                    ts: None,
                    text: "hi".into()
                },
                Thinking {
                    ts: None,
                    text: "greet".into()
                },
                AssistantText {
                    ts: None,
                    markdown: "Hello!".into()
                },
                ToolCall {
                    ts: None,
                    id: "c1".into(),
                    name: "bash".into(),
                    input_summary: "pwd".into(),
                    input: serde_json::json!({"command":"pwd"})
                },
                ToolResult {
                    images: vec![],
                    ts: None,
                    call_id: "c1".into(),
                    output: "/w/app".into(),
                    is_error: false
                },
            ]
        );
    }
    #[test]
    fn branch_switch_resets_to_new_path() {
        let mut p = PiParser::default();
        feed(&mut p, include_str!("../../tests/fixtures/pi.jsonl"));
        let out = p.push_line(r#"{"type":"message","id":"e","parentId":"a","message":{"role":"user","content":"again"}}"#, &mut Vec::<(String, String, Vec<u8>)>::new());
        match out {
            ParserOutput::Reset(items) => assert_eq!(
                items,
                vec![
                    User {
                        images: vec![],
                        skills: vec![],
                        ts: None,
                        text: "hi".into()
                    },
                    User {
                        images: vec![],
                        skills: vec![],
                        ts: None,
                        text: "again".into()
                    }
                ]
            ),
            o => panic!("{o:?}"),
        }
        let next = p.push_line(r#"{"type":"message","id":"f","parentId":"e","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}"#, &mut Vec::<(String, String, Vec<u8>)>::new());
        assert!(
            matches!(next, ParserOutput::Append(v) if v == vec![AssistantText { ts: None, markdown: "ok".into() }])
        );
    }
    #[test]
    fn unknown_parent_starts_branch_there() {
        let mut p = PiParser::default();
        let out = p.push_line(r#"{"type":"message","id":"x","parentId":"gone","message":{"role":"user","content":"hey"}}"#, &mut Vec::<(String, String, Vec<u8>)>::new());
        assert!(
            matches!(out, ParserOutput::Reset(v) if v == vec![User { ts: None, text: "hey".into(), images: vec![], skills: vec![] }])
        );
    }
    #[test]
    fn truncates_long_results() {
        let mut p = PiParser::default();
        let big = "x".repeat(20_000);
        let line = serde_json::json!({"type":"message","id":"a","parentId":null,"message":{"role":"toolResult","toolCallId":"t","content":[{"type":"text","text":big}]}}).to_string();
        match p.push_line(&line, &mut Vec::<(String, String, Vec<u8>)>::new()) {
            ParserOutput::Append(v) => match &v[0] {
                ToolResult { output, .. } => {
                    assert!(output.len() < 16_500);
                    assert!(output.ends_with("… (truncated)"));
                }
                o => panic!("{o:?}"),
            },
            o => panic!("{o:?}"),
        }
    }
    #[test]
    fn oversize_branch_emits_system_once_then_stops() {
        let mut p = PiParser::with_limit(300);
        let l1 = r#"{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"one"}}"#;
        assert!(matches!(
            p.push_line(l1, &mut Vec::<(String, String, Vec<u8>)>::new()),
            ParserOutput::Append(_)
        ));
        let big = format!(
            r#"{{"type":"message","id":"b","parentId":"a","message":{{"role":"user","content":"{}"}}}}"#,
            "y".repeat(300)
        );
        match p.push_line(&big, &mut Vec::<(String, String, Vec<u8>)>::new()) {
            ParserOutput::Reset(v) => assert_eq!(
                v,
                vec![System {
                    ts: None,
                    text: "Conversation too large to show; use the Terminal lens.".into()
                }]
            ),
            o => panic!("{o:?}"),
        }
        assert!(matches!(
            p.push_line(l1, &mut Vec::<(String, String, Vec<u8>)>::new()),
            ParserOutput::None
        ));
    }
    #[test]
    fn stamps_items_with_the_entry_timestamp() {
        let mut p = PiParser::default();
        let line = r#"{"type":"message","id":"a","parentId":null,"timestamp":"2026-10-02T11:46:32.940Z","message":{"role":"user","content":"hi","timestamp":1790941592936}}"#;
        match p.push_line(line, &mut Vec::<(String, String, Vec<u8>)>::new()) {
            ParserOutput::Append(v) => assert_eq!(v[0].ts(), Some("2026-10-02T11:46:32.940Z")),
            o => panic!("{o:?}"),
        }
    }
}
