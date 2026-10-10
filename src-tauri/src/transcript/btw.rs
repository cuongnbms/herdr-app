//! Side questions (btw): the argv that runs `claude -p` on a fork of a Transcript, and the
//! parsing of its stream-json output into events for the card.
use serde::Serialize;
use serde_json::Value;

/// The `sh -c` body: enter the working directory, find `claude` (through a login shell when
/// it is not on PATH) and exec it with the remaining arguments.
pub const CLAUDE_SCRIPT: &str = r#"cd "$1" || exit 1; shift
p="$1"; shift
c=$(command -v "$p") || c=$("${SHELL:-/bin/sh}" -lc "command -v $p" 2>/dev/null | tail -n 1)
[ -n "$c" ] || { echo "claude not found on this machine" >&2; exit 127; }
exec "$c" "$@""#;

/// The argv that asks `question` on a fork of the Transcript `transcript_id`, or, when
/// `fork_id` is given, resumes that fork without forking again. The question goes after
/// `--` so a leading dash is not read as a flag.
pub fn btw_argv(
    program: &str,
    cwd: &str,
    transcript_id: &str,
    fork_id: Option<&str>,
    model: Option<&str>,
    question: &str,
) -> Vec<String> {
    let mut a: Vec<String> = [
        "sh",
        "-c",
        CLAUDE_SCRIPT,
        "sh",
        cwd,
        program,
        "-p",
        "--resume",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push(fork_id.unwrap_or(transcript_id).to_string());
    if fork_id.is_none() {
        a.push("--fork-session".into());
    }
    if let Some(m) = model {
        a.extend(["--model".to_string(), m.to_string()]);
    }
    a.extend(
        [
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--verbose",
            "--",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    a.push(question.to_string());
    a
}

fn values(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.lines().filter_map(|l| serde_json::from_str(l).ok())
}

/// `message.model` of the last assistant line that has one.
pub fn last_model(text: &str) -> Option<String> {
    values(text)
        .filter(|v| v["type"] == "assistant")
        .filter_map(|v| v["message"]["model"].as_str().map(str::to_string))
        .last()
}

/// `cwd` of the last line that has one.
pub fn last_cwd(text: &str) -> Option<String> {
    values(text)
        .filter_map(|v| v["cwd"].as_str().map(str::to_string))
        .last()
}

/// What a side question reports while it runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BtwEvent {
    Delta {
        text: String,
    },
    Tool {
        name: String,
    },
    Done {
        fork_id: String,
        cache_read: u64,
        input: u64,
    },
    Error {
        message: String,
    },
}

/// The events one line of `claude -p --output-format stream-json` carries. Lines from a
/// subagent (a non-null `parent_tool_use_id`), unknown lines and non-JSON give none.
pub fn parse_line(line: &str) -> Vec<BtwEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    let from_subagent = !v["parent_tool_use_id"].is_null();
    match v["type"].as_str() {
        Some("stream_event") if !from_subagent => {
            let delta = &v["event"]["delta"];
            if v["event"]["type"] == "content_block_delta" && delta["type"] == "text_delta" {
                if let Some(text) = delta["text"].as_str() {
                    return vec![BtwEvent::Delta { text: text.into() }];
                }
            }
            vec![]
        }
        Some("assistant") if !from_subagent => v["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["type"] == "tool_use")
            .filter_map(|b| b["name"].as_str())
            .map(|name| BtwEvent::Tool { name: name.into() })
            .collect(),
        Some("result") => {
            if v["is_error"] == true {
                let message = v["result"]
                    .as_str()
                    .or_else(|| v["subtype"].as_str())
                    .unwrap_or("error");
                vec![BtwEvent::Error {
                    message: message.into(),
                }]
            } else if v["is_error"] == false {
                vec![BtwEvent::Done {
                    fork_id: v["session_id"].as_str().unwrap_or_default().into(),
                    cache_read: v["usage"]["cache_read_input_tokens"].as_u64().unwrap_or(0),
                    input: v["usage"]["input_tokens"].as_u64().unwrap_or(0),
                }]
            } else {
                vec![]
            }
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn first_question_forks_the_transcript() {
        let a = btw_argv(
            "claude",
            "/w/b",
            "t1",
            None,
            Some("claude-opus-5-5"),
            "why?",
        );
        assert_eq!(&a[..5], &s(&["sh", "-c", CLAUDE_SCRIPT, "sh", "/w/b"])[..]);
        assert_eq!(
            &a[5..],
            &s(&[
                "claude",
                "-p",
                "--resume",
                "t1",
                "--fork-session",
                "--model",
                "claude-opus-5-5",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--",
                "why?",
            ])[..]
        );
    }

    #[test]
    fn follow_up_resumes_the_fork_without_forking_again() {
        let a = btw_argv("claude", "/w", "t1", Some("f1"), None, "-v là gì?");
        assert!(a.windows(2).any(|w| w == ["--resume", "f1"]));
        assert!(!a.contains(&"--fork-session".to_string()));
        assert!(!a.contains(&"--model".to_string()));
        assert_eq!(&a[a.len() - 2..], &s(&["--", "-v là gì?"])[..]);
    }

    const T: &str = concat!(
        r#"{"type":"user","cwd":"/w/a","message":{"role":"user","content":"hi"},"uuid":"u1"}"#,
        "\n",
        r#"{"type":"assistant","cwd":"/w/a","message":{"model":"claude-sonnet-5-5","content":[]},"uuid":"a1"}"#,
        "\n",
        r#"{"type":"assistant","cwd":"/w/b","message":{"model":"claude-opus-5-5","content":[]},"uuid":"a2"}"#,
        "\n",
        r#"{"type":"system","subtype":"compact_boundary"}"#,
        "\n",
    );

    #[test]
    fn model_and_cwd_come_from_the_last_lines_that_have_them() {
        assert_eq!(last_model(T).as_deref(), Some("claude-opus-5-5"));
        assert_eq!(last_cwd(T).as_deref(), Some("/w/b"));
        assert_eq!(last_model(r#"{"type":"user"}"#), None);
        assert_eq!(last_cwd(r#"{"type":"user"}"#), None);
    }

    #[test]
    fn stream_lines_become_events() {
        assert_eq!(
            parse_line(
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}"#
            ),
            vec![BtwEvent::Delta { text: "Hel".into() }]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","id":"t","name":"Read","input":{}}]}}"#
            ),
            vec![BtwEvent::Tool {
                name: "Read".into()
            }]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"f1","usage":{"input_tokens":12,"cache_read_input_tokens":34000}}"#
            ),
            vec![BtwEvent::Done {
                fork_id: "f1".into(),
                cache_read: 34000,
                input: 12
            }]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"f1"}"#
            ),
            vec![BtwEvent::Error {
                message: "error_during_execution".into()
            }]
        );
        assert_eq!(
            parse_line(r#"{"type":"system","subtype":"init","session_id":"f1"}"#),
            vec![]
        );
        assert_eq!(parse_line("Warning: not json"), vec![]);
    }

    #[test]
    fn subagent_lines_are_ignored() {
        assert_eq!(
            parse_line(
                r#"{"type":"stream_event","parent_tool_use_id":"toolu_x","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}"#
            ),
            vec![]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"assistant","parent_tool_use_id":"toolu_x","message":{"content":[{"type":"tool_use","id":"t","name":"Read","input":{}}]}}"#
            ),
            vec![]
        );
    }
}
