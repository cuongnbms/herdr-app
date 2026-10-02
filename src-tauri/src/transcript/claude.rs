//! Claude Code transcript parser.
use super::locate::input_summary;
use super::{ChatItem, Parser, ParserOutput};
use serde_json::Value;

const MAX_RESULT_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub struct ClaudeParser;

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Truncates to at most 16 KiB on a char boundary, marking the cut.
fn truncate(s: String) -> String {
    if s.len() <= MAX_RESULT_BYTES {
        return s;
    }
    let mut end = MAX_RESULT_BYTES;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &s[..end])
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn user_text_ok(text: &str) -> bool {
    !(text.starts_with("<command-") || text.starts_with("<local-command-") || text.starts_with("Caveat:"))
}

impl Parser for ClaudeParser {
    fn push_line(&mut self, line: &str) -> ParserOutput {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("skipping non-JSON transcript line: {e}");
                return ParserOutput::None;
            }
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(kind, "user" | "assistant")
            || flag(&v, "isMeta")
            || flag(&v, "isSidechain")
            || flag(&v, "isCompactSummary")
        {
            return ParserOutput::None;
        }
        let content = v.get("message").and_then(|m| m.get("content"));
        let mut items = vec![];
        match content {
            Some(Value::String(s)) if kind == "user" => {
                if user_text_ok(s) {
                    items.push(ChatItem::User { text: s.clone() });
                }
            }
            Some(Value::Array(blocks)) => {
                for b in blocks {
                    let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
                    match (kind, bt) {
                        ("user", "text") => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                if user_text_ok(t) {
                                    items.push(ChatItem::User { text: t.to_string() });
                                }
                            }
                        }
                        ("user", "tool_result") => items.push(ChatItem::ToolResult {
                            call_id: b.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string(),
                            output: truncate(result_text(b.get("content"))),
                            is_error: flag(b, "is_error"),
                        }),
                        ("assistant", "text") => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                items.push(ChatItem::AssistantText { markdown: t.to_string() });
                            }
                        }
                        ("assistant", "thinking") => {
                            if let Some(t) = b.get("thinking").and_then(Value::as_str) {
                                items.push(ChatItem::Thinking { text: t.to_string() });
                            }
                        }
                        ("assistant", "tool_use") => {
                            let name = b.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                            let input = b.get("input").cloned().unwrap_or(Value::Null);
                            items.push(ChatItem::ToolCall {
                                id: b.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                                input_summary: input_summary(&name, &input),
                                name,
                                input,
                            });
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        if items.is_empty() {
            ParserOutput::None
        } else {
            ParserOutput::Append(items)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::{ChatItem::*, Parser, ParserOutput};
    fn run(text: &str) -> Vec<ChatItem> {
        let mut p = ClaudeParser::default();
        let mut out = vec![];
        for l in text.lines() { if let ParserOutput::Append(v) = p.push_line(l) { out.extend(v) } }
        out
    }
    #[test]
    fn parses_fixture() {
        let items = run(include_str!("../../tests/fixtures/claude.jsonl"));
        assert_eq!(items, vec![
            User { text: "list files".into() },
            Thinking { text: "need ls".into() },
            AssistantText { markdown: "Listing **now**.".into() },
            ToolCall { id: "toolu_1".into(), name: "Bash".into(), input_summary: "ls".into(), input: serde_json::json!({"command":"ls","description":"list"}) },
            ToolResult { call_id: "toolu_1".into(), output: "a.txt\nb.txt".into(), is_error: false },
            ToolResult { call_id: "toolu_2".into(), output: "boom".into(), is_error: true },
            AssistantText { markdown: "Done.".into() },
        ]);
    }
    #[test]
    fn skips_garbage_lines() {
        let items = run("{\"type\":\"user\",\"message\":{\"content\":\"a\"}}\n\u{FFFD}\u{FFFD}garbage\n{\"type\":\"user\",\"message\":{\"content\":\"b\"}");
        assert_eq!(items, vec![User { text: "a".into() }]);
        let more = run("{\"type\":\"user\",\"message\":{\"content\":\"b\"}}");
        assert_eq!(more, vec![User { text: "b".into() }]);
    }
    #[test]
    fn truncates_long_results() {
        let big = "x".repeat(20_000);
        let line = serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content": big}]}}).to_string();
        match &run(&line)[0] { ToolResult { output, .. } => { assert!(output.len() < 16_500); assert!(output.ends_with("… (truncated)")); } o => panic!("{o:?}") }
    }
    #[test]
    fn truncates_on_char_boundary() {
        // 3-byte chars; 16384 is not a multiple of 3 boundary issue: 16384 % 3 == 1
        let big = "€".repeat(10_000);
        let line = serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content": big}]}}).to_string();
        match &run(&line)[0] { ToolResult { output, .. } => { assert!(output.len() < 16_500); assert!(output.ends_with("… (truncated)")); } o => panic!("{o:?}") }
    }
}
