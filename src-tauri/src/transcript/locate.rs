//! Find the transcript file of the agent running in a Pane.
use crate::error::{AppError, AppResult};
use crate::transport::{exec, MachineInfo, Transport};
use crate::view::PaneView;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Located {
    pub agent: String,
    pub path: String,
    pub ambiguous: bool,
    pub candidates: Vec<String>,
}

fn java_string_hash(s: &str) -> i32 {
    s.encode_utf16().fold(0i32, |h, u| h.wrapping_mul(31).wrapping_add(u as i32))
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Claude Code's project directory name for `cwd`.
pub fn claude_project_dir(cwd: &str) -> String {
    let enc: String = cwd.encode_utf16().map(|u| if u < 128 && (u as u8).is_ascii_alphanumeric() { u as u8 as char } else { '-' }).collect();
    if enc.len() <= 200 {
        return enc;
    }
    format!("{}-{}", &enc[..200], base36(java_string_hash(cwd).unsigned_abs() as u64))
}

/// pi's session directory name for `cwd`.
pub fn pi_session_dir(cwd: &str) -> String {
    format!("--{}--", cwd.trim_start_matches('/').replace(['/', '\\', ':'], "-"))
}

/// A one-line summary of a tool call's input, at most 120 chars plus `…`.
pub fn input_summary(name: &str, input: &Value) -> String {
    let keys: &[&str] = match name {
        "Bash" => &["command"],
        "Read" | "Edit" | "Write" => &["file_path", "path"],
        "Grep" | "Glob" => &["pattern"],
        _ => &[],
    };
    let s = keys
        .iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str))
        .or_else(|| input.as_object().and_then(|o| o.values().find_map(Value::as_str)))
        .unwrap_or("");
    if s.chars().count() > 120 {
        format!("{}…", s.chars().take(120).collect::<String>())
    } else {
        s.to_string()
    }
}

fn sh(script: &str, arg: &str) -> Vec<String> {
    vec!["sh".into(), "-c".into(), script.into(), "sh".into(), arg.into()]
}

async fn file_exists(t: &dyn Transport, path: &str) -> bool {
    matches!(exec(t, &sh(r#"test -f "$1""#, path)).await, Ok(o) if o.status == 0)
}

/// Up to 20 `*.jsonl` files in `dir`, newest first.
async fn newest_in(t: &dyn Transport, dir: &str) -> Vec<String> {
    let script = r#"cd "$1" 2>/dev/null && ls -1t -- *.jsonl 2>/dev/null | head -n 20"#;
    match exec(t, &sh(script, dir)).await {
        Ok(o) => o.stdout.lines().filter(|l| !l.is_empty()).map(|l| format!("{}/{l}", dir.trim_end_matches('/'))).collect(),
        Err(_) => Vec::new(),
    }
}

pub async fn locate(t: &dyn Transport, info: &MachineInfo, agent_get: &Value, pane: &PaneView, same_agent_same_cwd: usize) -> AppResult<Located> {
    let agent = agent_get["agent"]["agent"].as_str().map(str::to_string).or_else(|| pane.agent.clone()).unwrap_or_default();
    let session = &agent_get["agent"]["agent_session"];
    let found = |path: String, ambiguous: bool, candidates: Vec<String>| Located { agent: agent.clone(), path, ambiguous, candidates };

    if session["kind"] == "path" {
        if let Some(p) = session["value"].as_str() {
            return Ok(found(p.to_string(), false, vec![p.to_string()]));
        }
    }
    let home = info.home.trim_end_matches('/');
    let dirs: Vec<String> = match (agent.as_str(), pane.cwd.as_deref()) {
        ("claude", Some(cwd)) => vec![format!("{home}/.claude/projects/{}", claude_project_dir(cwd))],
        ("pi", Some(cwd)) => vec![format!("{}/{}", info.pi_dir.trim_end_matches('/'), pi_session_dir(cwd))],
        _ => Vec::new(),
    };
    if agent == "claude" {
        if let (Some(id), Some(dir)) = (session["value"].as_str(), dirs.first()) {
            let path = format!("{dir}/{id}.jsonl");
            if file_exists(t, &path).await {
                return Ok(found(path.clone(), false, vec![path]));
            }
        }
    }
    for dir in &dirs {
        let candidates = newest_in(t, dir).await;
        if let Some(first) = candidates.first() {
            return Ok(found(first.clone(), same_agent_same_cwd > 1, candidates));
        }
    }
    Err(AppError::new("not_found", format!("no transcript found for {} in {}", if agent.is_empty() { "agent" } else { &agent }, pane.cwd.as_deref().unwrap_or("unknown directory"))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn claude_dir_encoding() {
        assert_eq!(claude_project_dir("/Users/me/herdr app"), "-Users-me-herdr-app");
        assert_eq!(claude_project_dir("/srv/example.com/my_project"), "-srv-example-com-my-project");
        let long = format!("/{}", "a".repeat(250));
        let enc = claude_project_dir(&long);
        assert!(enc.starts_with(&format!("-{}", "a".repeat(199))));
        assert_eq!(enc.len(), 200 + 1 + enc.rsplit('-').next().unwrap().len());
    }
    #[test]
    fn pi_dir_encoding() {
        assert_eq!(pi_session_dir("/Users/cuongnb/agent-skills/skills"), "--Users-cuongnb-agent-skills-skills--");
        assert_eq!(pi_session_dir("/Users/cuongnb"), "--Users-cuongnb--");
    }
    #[test]
    fn summarises_tool_input() {
        assert_eq!(input_summary("Bash", &json!({"command":"ls -la","description":"x"})), "ls -la");
        assert_eq!(input_summary("Edit", &json!({"file_path":"/a/b.rs","old_string":"x"})), "/a/b.rs");
        assert_eq!(input_summary("Grep", &json!({"pattern":"fn main"})), "fn main");
        assert_eq!(input_summary("Other", &json!({"n":1,"q":"hello"})), "hello");
        assert_eq!(input_summary("Bash", &json!({"command":"x".repeat(200)})).chars().count(), 121);
    }
    #[tokio::test]
    async fn locates_newest_claude_file_and_flags_ambiguity() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".claude/projects").join(claude_project_dir("/w/app"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("old.jsonl"), "{}\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(dir.join("new.jsonl"), "{}\n").unwrap();
        let info = crate::transport::MachineInfo { home: home.path().to_string_lossy().into(), herdr: "herdr".into(), pi_dir: "/none".into(), version: "0.9.3".into(), protocol: 22 };
        let pane = crate::view::PaneView { pane_id: "w1:p1".into(), terminal_id: "t".into(), title: "x".into(), cwd: Some("/w/app".into()), agent: Some("claude".into()), status: Default::default() };
        let got = locate(&crate::transport::local::LocalTransport, &info, &json!({"agent":{"agent":"claude"}}), &pane, 2).await.unwrap();
        assert!(got.path.ends_with("/new.jsonl"), "{}", got.path);
        assert!(got.ambiguous);
        assert_eq!(got.candidates.len(), 2);
        let exact = locate(&crate::transport::local::LocalTransport, &info, &json!({"agent":{"agent":"claude","agent_session":{"kind":"id","value":"old"}}}), &pane, 2).await.unwrap();
        assert!(exact.path.ends_with("/old.jsonl") && !exact.ambiguous);
    }
}
