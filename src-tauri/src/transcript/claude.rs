//! Claude Code transcript parser.
use super::locate::input_summary;
use super::{truncate_result as truncate, ChatItem, Parser, ParserOutput};
use serde_json::Value;

#[derive(Default)]
pub struct ClaudeParser;

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
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

fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = text.find(&open)? + open.len();
    let len = text[start..].find(&format!("</{name}>"))?;
    Some(text[start..start + len].trim())
}

/// The chat text for a user record: a slash command reads as the user typed
/// it, and the CLI's own bookkeeping (command output, caveats) is dropped.
fn user_text(text: &str) -> Option<String> {
    if text.starts_with("<command-") {
        let name = tag(text, "command-name")?;
        return Some(match tag(text, "command-args").filter(|a| !a.is_empty()) {
            Some(args) => format!("{name} {args}"),
            None => name.to_string(),
        });
    }
    if text.starts_with("<local-command-") || text.starts_with("Caveat:") {
        return None;
    }
    Some(text.to_string())
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
        if !matches!(kind, "user" | "assistant") {
            tracing::trace!(
                record_type = kind,
                "skipping transcript record: unknown type"
            );
            return ParserOutput::None;
        }
        if let Some(reason) = ["isMeta", "isSidechain", "isCompactSummary"]
            .into_iter()
            .find(|k| flag(&v, k))
        {
            tracing::trace!(record_type = kind, reason, "skipping transcript record");
            return ParserOutput::None;
        }
        let content = v.get("message").and_then(|m| m.get("content"));
        // The CLI's own prompts to the agent (a background task finishing)
        // are not the user's words: show their summary as a system line.
        if v.get("promptSource").and_then(Value::as_str) == Some("system") {
            return match content.and_then(Value::as_str).and_then(|s| tag(s, "summary")) {
                Some(text) => ParserOutput::Append(vec![ChatItem::System {
                    text: text.to_string(),
                }]),
                None => ParserOutput::None,
            };
        }
        let mut items = vec![];
        match content {
            Some(Value::String(s)) if kind == "user" => {
                if let Some(text) = user_text(s) {
                    items.push(ChatItem::User { text });
                }
            }
            Some(Value::Array(blocks)) => {
                for b in blocks {
                    let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
                    match (kind, bt) {
                        ("user", "text") => {
                            if let Some(text) =
                                b.get("text").and_then(Value::as_str).and_then(user_text)
                            {
                                items.push(ChatItem::User { text });
                            }
                        }
                        ("user", "tool_result") => items.push(ChatItem::ToolResult {
                            call_id: b
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            output: truncate(result_text(b.get("content"))),
                            is_error: flag(b, "is_error"),
                        }),
                        ("assistant", "text") => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                items.push(ChatItem::AssistantText {
                                    markdown: t.to_string(),
                                });
                            }
                        }
                        ("assistant", "thinking") => {
                            if let Some(t) = b.get("thinking").and_then(Value::as_str) {
                                items.push(ChatItem::Thinking {
                                    text: t.to_string(),
                                });
                            }
                        }
                        ("assistant", "tool_use") => {
                            let name = b
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let input = b.get("input").cloned().unwrap_or(Value::Null);
                            items.push(ChatItem::ToolCall {
                                id: b
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
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
        for l in text.lines() {
            if let ParserOutput::Append(v) = p.push_line(l) {
                out.extend(v)
            }
        }
        out
    }
    #[test]
    fn parses_fixture() {
        let items = run(include_str!("../../tests/fixtures/claude.jsonl"));
        assert_eq!(
            items,
            vec![
                User {
                    text: "list files".into()
                },
                Thinking {
                    text: "need ls".into()
                },
                AssistantText {
                    markdown: "Listing **now**.".into()
                },
                ToolCall {
                    id: "toolu_1".into(),
                    name: "Bash".into(),
                    input_summary: "ls".into(),
                    input: serde_json::json!({"command":"ls","description":"list"})
                },
                ToolResult {
                    call_id: "toolu_1".into(),
                    output: "a.txt\nb.txt".into(),
                    is_error: false
                },
                ToolResult {
                    call_id: "toolu_2".into(),
                    output: "boom".into(),
                    is_error: true
                },
                User {
                    text: "/clear".into()
                },
                AssistantText {
                    markdown: "Done.".into()
                },
            ]
        );
    }
    #[test]
    fn skips_garbage_lines() {
        let items = run("{\"type\":\"user\",\"message\":{\"content\":\"a\"}}\n\u{FFFD}\u{FFFD}garbage\n{\"type\":\"user\",\"message\":{\"content\":\"b\"}");
        assert_eq!(items, vec![User { text: "a".into() }]);
        let more = run("{\"type\":\"user\",\"message\":{\"content\":\"b\"}}");
        assert_eq!(more, vec![User { text: "b".into() }]);
    }
    #[test]
    fn shows_slash_commands_as_user_text() {
        let line = serde_json::json!({"type":"user","message":{"content":"<command-message>working-time</command-message>\n<command-name>/working-time</command-name>\n<command-args>last 1 day</command-args>"}}).to_string();
        assert_eq!(
            run(&line),
            vec![User {
                text: "/working-time last 1 day".into()
            }]
        );
        let bare = serde_json::json!({"type":"user","message":{"content":"<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>"}}).to_string();
        assert_eq!(
            run(&bare),
            vec![User {
                text: "/clear".into()
            }]
        );
        let stdout = serde_json::json!({"type":"user","message":{"content":"<local-command-stdout></local-command-stdout>"}}).to_string();
        assert_eq!(run(&stdout), vec![]);
    }
    #[test]
    fn skips_system_prompts() {
        let note = serde_json::json!({"type":"user","promptSource":"system","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>\n<task-id>a1</task-id>\n<summary>Agent \"Research\" finished</summary>\n</task-notification>"}}).to_string();
        assert_eq!(
            run(&note),
            vec![System {
                text: "Agent \"Research\" finished".into()
            }]
        );
        let bare = serde_json::json!({"type":"user","promptSource":"system","message":{"content":"<task-notification>\n<task-id>a1</task-id>\n</task-notification>"}}).to_string();
        assert_eq!(run(&bare), vec![]);
        let typed = serde_json::json!({"type":"user","promptSource":"typed","origin":{"kind":"human"},"message":{"content":"ok"}}).to_string();
        assert_eq!(run(&typed), vec![User { text: "ok".into() }]);
    }
    #[test]
    fn truncates_long_results() {
        let big = "x".repeat(20_000);
        let line = serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content": big}]}}).to_string();
        match &run(&line)[0] {
            ToolResult { output, .. } => {
                assert!(output.len() < 16_500);
                assert!(output.ends_with("… (truncated)"));
            }
            o => panic!("{o:?}"),
        }
    }
    #[test]
    fn truncates_on_char_boundary() {
        // 3-byte chars; 16384 is not a multiple of 3 boundary issue: 16384 % 3 == 1
        let big = "€".repeat(10_000);
        let line = serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content": big}]}}).to_string();
        match &run(&line)[0] {
            ToolResult { output, .. } => {
                assert!(output.len() < 16_500);
                assert!(output.ends_with("… (truncated)"));
            }
            o => panic!("{o:?}"),
        }
    }
}
