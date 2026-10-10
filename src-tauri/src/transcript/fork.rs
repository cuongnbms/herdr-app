//! Cutting a Transcript: keep only the parent chain leading up to one entry, so the copy can
//! start a new session that forks from just before that entry.
use crate::error::{AppError, AppResult};
use crate::transport::{exec_bytes, exec_input, Transport};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// A cut copy of a Transcript, ready to be written as a new session file.
#[derive(Debug, Clone, PartialEq)]
pub struct Cut {
    pub id: String,
    pub file_name: String,
    pub text: String,
    pub cwd: Option<String>,
}

/// The non-empty lines of `text`, each with its parsed JSON (None when it does not parse).
fn parse(text: &str) -> Vec<(&str, Option<Value>)> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| (l, serde_json::from_str(l).ok()))
        .collect()
}

/// Indexes of the lines on the parent chain of `entry_id` (the entry itself excluded), in
/// file order. The walk stops at a null parent or a parent id that is not in the file.
fn chain(
    parsed: &[(&str, Option<Value>)],
    id_key: &str,
    parent_key: &str,
    entry_id: &str,
) -> AppResult<Vec<usize>> {
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    for (i, (_, v)) in parsed.iter().enumerate() {
        if let Some(id) = v.as_ref().and_then(|v| v[id_key].as_str()) {
            by_id.insert(id, i); // the later line wins
        }
    }
    let start = *by_id.get(entry_id).ok_or_else(|| {
        AppError::new(
            "not_found",
            format!("entry {entry_id} not found in transcript"),
        )
    })?;
    let parent_of = |i: usize| parsed[i].1.as_ref().and_then(|v| v[parent_key].as_str());
    let mut kept = Vec::new();
    let mut seen = HashSet::from([start]);
    let mut parent = parent_of(start);
    while let Some(&i) = parent.and_then(|p| by_id.get(p)) {
        if !seen.insert(i) {
            break; // a cycle; never loop forever on a corrupt file
        }
        kept.push(i);
        parent = parent_of(i);
    }
    kept.sort_unstable();
    Ok(kept)
}

fn join(lines: Vec<String>) -> String {
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

/// Claude records parallel tool calls as branches, so the parent chain reaches only the last
/// result. Before the forked entry's line, also keep every `user` line whose `tool_result`
/// answers a `tool_use` in a kept assistant line, plus its `attachment` descendants
/// (transitively, stopping at any user or assistant line). Leaves `kept` in file order.
fn add_parallel_tool_results(
    parsed: &[(&str, Option<Value>)],
    kept: &mut Vec<usize>,
    entry_id: &str,
) {
    let Some(entry_at) = parsed
        .iter()
        .rposition(|(_, v)| v.as_ref().is_some_and(|v| v["uuid"] == entry_id))
    else {
        return;
    };
    let block_ids = |i: usize, kind: &str, key: &str| -> Vec<String> {
        let Some(Value::Array(blocks)) = parsed[i].1.as_ref().map(|v| &v["message"]["content"])
        else {
            return Vec::new();
        };
        blocks
            .iter()
            .filter(|b| b["type"] == kind)
            .filter_map(|b| b[key].as_str().map(str::to_string))
            .collect()
    };
    let type_of = |i: usize| parsed[i].1.as_ref().and_then(|v| v["type"].as_str());
    let mut added: HashSet<usize> = kept.iter().copied().collect();
    // One API response is written as several assistant lines sharing a `message.id`.
    let message_id = |i: usize| {
        parsed[i]
            .1
            .as_ref()
            .and_then(|v| v["message"]["id"].as_str())
    };
    let responses: HashSet<&str> = kept
        .iter()
        .filter(|&&i| type_of(i) == Some("assistant"))
        .filter_map(|&i| message_id(i))
        .collect();
    for i in 0..entry_at {
        if type_of(i) == Some("assistant") && message_id(i).is_some_and(|m| responses.contains(m)) {
            added.insert(i);
        }
    }
    let assistants: Vec<usize> = added
        .iter()
        .copied()
        .filter(|&i| type_of(i) == Some("assistant"))
        .collect();
    let tool_uses: HashSet<String> = assistants
        .iter()
        .flat_map(|&i| block_ids(i, "tool_use", "id"))
        .collect();
    // Attachments hang off kept assistant lines and off the results added below.
    let mut uuids: HashSet<String> = assistants
        .iter()
        .filter_map(|&i| parsed[i].1.as_ref()?["uuid"].as_str().map(str::to_string))
        .collect();
    for i in 0..entry_at {
        if !added.contains(&i)
            && type_of(i) == Some("user")
            && block_ids(i, "tool_result", "tool_use_id")
                .iter()
                .any(|id| tool_uses.contains(id))
        {
            added.insert(i);
            if let Some(u) = parsed[i].1.as_ref().and_then(|v| v["uuid"].as_str()) {
                uuids.insert(u.to_string());
            }
        }
    }
    // File order puts a parent before its child, so one forward pass finds all descendants.
    for i in 0..entry_at {
        if added.contains(&i) || type_of(i) != Some("attachment") {
            continue;
        }
        let parent = parsed[i].1.as_ref().and_then(|v| v["parentUuid"].as_str());
        if parent.is_some_and(|p| uuids.contains(p)) {
            added.insert(i);
            if let Some(u) = parsed[i].1.as_ref().and_then(|v| v["uuid"].as_str()) {
                uuids.insert(u.to_string());
            }
        }
    }
    *kept = added.into_iter().collect();
    kept.sort_unstable();
}

/// Cut a Claude Transcript to the chain before `entry_id`, re-keyed to session `new_id`.
/// `Ok(None)` when that chain holds no user or assistant line.
pub fn cut_claude(text: &str, entry_id: &str, new_id: &str) -> AppResult<Option<Cut>> {
    let parsed = parse(text);
    let mut kept = chain(&parsed, "uuid", "parentUuid", entry_id)?;
    add_parallel_tool_results(&parsed, &mut kept, entry_id);
    let has_conversation = kept.iter().any(|&i| {
        matches!(
            parsed[i].1.as_ref().and_then(|v| v["type"].as_str()),
            Some("user" | "assistant")
        )
    });
    if !has_conversation {
        return Ok(None);
    }
    let mut cwd = None;
    let mut out = Vec::with_capacity(kept.len());
    for i in kept {
        let mut v = parsed[i].1.clone().unwrap_or(Value::Null);
        if let Some(c) = v["cwd"].as_str() {
            cwd = Some(c.to_string());
        }
        v["sessionId"] = json!(new_id);
        out.push(v.to_string());
    }
    Ok(Some(Cut {
        id: new_id.to_string(),
        file_name: format!("{new_id}.jsonl"),
        text: join(out),
        cwd,
    }))
}

/// Cut a pi Transcript to the chain before `entry_id`, behind a fresh session header made at
/// `now`. `Ok(None)` when that chain holds no message line.
pub fn cut_pi(
    text: &str,
    entry_id: &str,
    new_id: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> AppResult<Option<Cut>> {
    let parsed = parse(text);
    let header_at = parsed
        .iter()
        .position(|(_, v)| v.as_ref().is_some_and(|v| v["type"] == "session"));
    let kept: Vec<usize> = chain(&parsed, "id", "parentId", entry_id)?
        .into_iter()
        .filter(|&i| Some(i) != header_at)
        .collect();
    let has_conversation = kept
        .iter()
        .any(|&i| parsed[i].1.as_ref().is_some_and(|v| v["type"] == "message"));
    if !has_conversation {
        return Ok(None);
    }
    let mut cwd = None;
    let mut out = Vec::with_capacity(kept.len() + 1);
    if let Some(h) = header_at {
        let mut head = parsed[h].1.clone().unwrap_or(Value::Null);
        cwd = head["cwd"].as_str().map(str::to_string);
        head["id"] = json!(new_id);
        head["timestamp"] = json!(now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
        out.push(head.to_string());
    }
    out.extend(kept.into_iter().map(|i| parsed[i].0.to_string()));
    Ok(Some(Cut {
        id: new_id.to_string(),
        file_name: format!("{}_{new_id}.jsonl", now.format("%Y-%m-%dT%H-%M-%S-%3fZ")),
        text: join(out),
        cwd,
    }))
}

/// What a fork made: the new session's id, the file holding it, and the directory it ran in.
/// All `None` when there was nothing before the entry to fork from.
#[derive(Debug, PartialEq, Serialize)]
pub struct Forked {
    pub id: Option<String>,
    pub path: Option<String>,
    pub cwd: Option<String>,
}

/// Fork the Transcript at `path` on the Machine from before `entry_id`, writing the cut copy as
/// a new session file next to the original.
pub async fn fork(t: &dyn Transport, agent: &str, path: &str, entry_id: &str) -> AppResult<Forked> {
    if !matches!(agent, "claude" | "pi") {
        return Err(AppError::new(
            "invalid",
            format!("forking is not supported for {agent}"),
        ));
    }
    let out = exec_bytes(t, &["cat".to_string(), path.to_string()]).await?;
    if out.status != 0 {
        return Err(AppError::new(
            "io",
            format!("reading the transcript failed: {}", out.stderr.trim()),
        ));
    }
    let text = String::from_utf8(out.stdout)
        .map_err(|_| AppError::new("invalid", "the transcript is not valid UTF-8"))?;
    let new_id = uuid::Uuid::new_v4().to_string();
    let cut = if agent == "claude" {
        cut_claude(&text, entry_id, &new_id)?
    } else {
        cut_pi(&text, entry_id, &new_id, chrono::Utc::now())?
    };
    let Some(cut) = cut else {
        return Ok(Forked {
            id: None,
            path: None,
            cwd: None,
        });
    };
    let dir = path.rsplit_once('/').map_or("", |(dir, _)| dir);
    let new_path = format!("{dir}/{}", cut.file_name);
    write_new(t, &new_path, &cut.text).await?;
    Ok(Forked {
        id: Some(cut.id),
        path: Some(new_path),
        cwd: cut.cwd,
    })
}

/// Write `text` to a new private file at `path`, failing if the file already exists.
async fn write_new(t: &dyn Transport, path: &str, text: &str) -> AppResult<()> {
    let argv: Vec<String> = vec![
        "sh".into(),
        "-c".into(),
        "umask 077; set -C; cat > \"$1\"".into(),
        "sh".into(),
        path.into(),
    ];
    let out = exec_input(t, &argv, Some(text.as_bytes())).await?;
    if out.status != 0 {
        return Err(AppError::new(
            "io",
            format!("writing the fork failed: {}", out.stderr.trim()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn lines(t: &str) -> Vec<Value> {
        t.lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn at() -> chrono::DateTime<chrono::Utc> {
        "2026-10-10T08:09:10.123Z".parse().unwrap()
    }

    const CLAUDE: &str = concat!(
        r#"{"type":"summary","summary":"x"}"#,
        "\n",
        r#"{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"old","cwd":"/w/a","message":{"content":"one"}}"#,
        "\n",
        r#"{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"old","cwd":"/w/a","message":{"content":[{"type":"text","text":"r1"}]}}"#,
        "\n",
        r#"{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"old","cwd":"/w/a","message":{"content":"abandoned"}}"#,
        "\n",
        r#"{"type":"assistant","uuid":"a2","parentUuid":"u2","sessionId":"old","cwd":"/w/a","message":{"content":[{"type":"text","text":"r2"}]}}"#,
        "\n",
        r#"{"type":"user","uuid":"u3","parentUuid":"a1","sessionId":"old","cwd":"/w/b","message":{"content":"two"}}"#,
        "\n",
        r#"{"type":"assistant","uuid":"a3","parentUuid":"u3","sessionId":"old","cwd":"/w/b","message":{"content":[{"type":"text","text":"r3"}]}}"#,
        "\n",
        r#"{"type":"user","uuid":"u4","parentUuid":"a3","sessionId":"old","cwd":"/w/b","message":{"content":"three"}}"#,
        "\n",
    );

    #[test]
    fn claude_keeps_the_parent_chain_without_abandoned_branches() {
        let cut = cut_claude(CLAUDE, "u4", "new").unwrap().unwrap();
        let kept = lines(&cut.text);
        let ids: Vec<&str> = kept.iter().map(|v| v["uuid"].as_str().unwrap()).collect();
        assert_eq!(ids, ["u1", "a1", "u3", "a3"]);
        assert!(kept.iter().all(|v| v["sessionId"] == "new"));
        assert_eq!(cut.id, "new");
        assert_eq!(cut.file_name, "new.jsonl");
        assert_eq!(cut.cwd.as_deref(), Some("/w/b"));
        assert!(cut.text.ends_with('\n'));
    }

    #[test]
    fn claude_first_message_has_nothing_to_keep() {
        assert!(cut_claude(CLAUDE, "u1", "new").unwrap().is_none());
    }

    #[test]
    fn claude_unknown_entry_is_not_found() {
        assert_eq!(
            cut_claude(CLAUDE, "nope", "new").unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn claude_walk_stops_at_a_missing_parent() {
        let t = concat!(
            r#"{"type":"assistant","uuid":"a1","parentUuid":"gone","sessionId":"old","message":{"content":[]}}"#,
            "\n",
            r#"{"type":"user","uuid":"u2","parentUuid":"a1","sessionId":"old","message":{"content":"x"}}"#,
            "\n",
        );
        let cut = cut_claude(t, "u2", "new").unwrap().unwrap();
        assert_eq!(lines(&cut.text).len(), 1);
        assert_eq!(cut.cwd, None);
    }

    #[test]
    fn claude_keeps_results_of_parallel_tool_calls() {
        let t = concat!(
            r#"{"type":"user","uuid":"root","parentUuid":null,"sessionId":"old","message":{"content":"r"}}"#,
            "\n",
            r#"{"type":"user","uuid":"P","parentUuid":"root","sessionId":"old","message":{"content":"p"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"A1","parentUuid":"P","sessionId":"old","message":{"content":[{"type":"tool_use","id":"T1"}]}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"A2","parentUuid":"A1","sessionId":"old","message":{"content":[{"type":"tool_use","id":"T2"}]}}"#,
            "\n",
            r#"{"type":"attachment","uuid":"AT2","parentUuid":"A2","sessionId":"old"}"#,
            "\n",
            r#"{"type":"user","uuid":"R1","parentUuid":"A1","sessionId":"old","message":{"content":[{"type":"tool_result","tool_use_id":"T1"}]}}"#,
            "\n",
            r#"{"type":"attachment","uuid":"X1","parentUuid":"R1","sessionId":"old"}"#,
            "\n",
            r#"{"type":"attachment","uuid":"X2","parentUuid":"X1","sessionId":"old"}"#,
            "\n",
            r#"{"type":"user","uuid":"R2","parentUuid":"A2","sessionId":"old","message":{"content":[{"type":"tool_result","tool_use_id":"T2"}]}}"#,
            "\n",
            r#"{"type":"attachment","uuid":"AR2","parentUuid":"R2","sessionId":"old"}"#,
            "\n",
            r#"{"type":"user","uuid":"F","parentUuid":"AR2","sessionId":"old","message":{"content":"fork here"}}"#,
            "\n",
        );
        let cut = cut_claude(t, "F", "new").unwrap().unwrap();
        let ids: Vec<String> = lines(&cut.text)
            .iter()
            .map(|v| v["uuid"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            ids,
            ["root", "P", "A1", "A2", "AT2", "R1", "X1", "X2", "R2", "AR2"]
        );
    }

    #[test]
    fn claude_keeps_every_block_of_a_response_with_out_of_order_results() {
        let t = concat!(
            r#"{"type":"user","uuid":"P","parentUuid":null,"sessionId":"old","message":{"content":"p"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"TH","parentUuid":"P","sessionId":"old","message":{"id":"M","content":[{"type":"thinking"}]}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"U1","parentUuid":"TH","sessionId":"old","message":{"id":"M","content":[{"type":"tool_use","id":"T1"}]}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"U2","parentUuid":"U1","sessionId":"old","message":{"id":"M","content":[{"type":"tool_use","id":"T2"}]}}"#,
            "\n",
            r#"{"type":"attachment","uuid":"AU2","parentUuid":"U2","sessionId":"old"}"#,
            "\n",
            r#"{"type":"user","uuid":"R2","parentUuid":"U2","sessionId":"old","message":{"content":[{"type":"tool_result","tool_use_id":"T2"}]}}"#,
            "\n",
            r#"{"type":"attachment","uuid":"XR2a","parentUuid":"R2","sessionId":"old"}"#,
            "\n",
            r#"{"type":"attachment","uuid":"XR2b","parentUuid":"XR2a","sessionId":"old"}"#,
            "\n",
            r#"{"type":"user","uuid":"R1","parentUuid":"U1","sessionId":"old","message":{"content":[{"type":"tool_result","tool_use_id":"T1"}]}}"#,
            "\n",
            r#"{"type":"attachment","uuid":"XR1","parentUuid":"R1","sessionId":"old"}"#,
            "\n",
            r#"{"type":"user","uuid":"F","parentUuid":"XR1","sessionId":"old","message":{"content":"next"}}"#,
            "\n",
        );
        let cut = cut_claude(t, "F", "new").unwrap().unwrap();
        let ids: Vec<String> = lines(&cut.text)
            .iter()
            .map(|v| v["uuid"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            ids,
            ["P", "TH", "U1", "U2", "AU2", "R2", "XR2a", "XR2b", "R1", "XR1"]
        );
    }

    const PI: &str = concat!(
        r#"{"type":"session","version":3,"id":"old","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/w/app"}"#,
        "\n",
        r#"{"type":"model_change","id":"m","parentId":null,"modelId":"x"}"#,
        "\n",
        r#"{"type":"message","id":"a","parentId":"m","message":{"role":"user","content":"hi"}}"#,
        "\n",
        r#"{"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":[]}}"#,
        "\n",
        r#"{"type":"message","id":"x","parentId":"b","message":{"role":"user","content":"abandoned"}}"#,
        "\n",
        r#"{"type":"message","id":"c","parentId":"b","message":{"role":"user","content":"again"}}"#,
        "\n",
    );

    #[test]
    fn pi_keeps_header_and_chain_and_renames_the_session() {
        let cut = cut_pi(PI, "c", "new", at()).unwrap().unwrap();
        let out: Vec<&str> = cut.text.lines().collect();
        let src: Vec<&str> = PI.lines().collect();
        assert_eq!(out.len(), 4);
        let head: Value = serde_json::from_str(out[0]).unwrap();
        assert_eq!(head["id"], "new");
        assert_eq!(head["timestamp"], "2026-10-10T08:09:10.123Z");
        assert_eq!(head["cwd"], "/w/app");
        assert_eq!(
            &out[1..],
            &[src[1], src[2], src[3]],
            "chain lines are copied byte for byte"
        );
        assert_eq!(cut.file_name, "2026-10-10T08-09-10-123Z_new.jsonl");
        assert_eq!(cut.cwd.as_deref(), Some("/w/app"));
    }

    #[test]
    fn pi_first_message_has_nothing_to_keep() {
        assert!(cut_pi(PI, "a", "new", at()).unwrap().is_none());
    }

    use crate::transport::local::LocalTransport;

    #[tokio::test]
    async fn fork_writes_a_private_copy_next_to_the_original() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("a dir");
        std::fs::create_dir(&dir).unwrap();
        let src = dir.join("old.jsonl");
        std::fs::write(&src, CLAUDE).unwrap();
        let f = fork(&LocalTransport, "claude", src.to_str().unwrap(), "u4")
            .await
            .unwrap();
        let id = f.id.clone().unwrap();
        let path = f.path.clone().unwrap();
        assert_eq!(path, dir.join(format!("{id}.jsonl")).to_string_lossy());
        assert_eq!(f.cwd.as_deref(), Some("/w/b"));
        assert_eq!(lines(&std::fs::read_to_string(&path).unwrap()).len(), 4);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let again = fork(&LocalTransport, "claude", src.to_str().unwrap(), "u4")
            .await
            .unwrap();
        assert_ne!(again.path, f.path, "a second fork is a second session");
    }

    #[tokio::test]
    async fn fork_at_the_first_message_writes_nothing() {
        let d = tempfile::tempdir().unwrap();
        let src = d.path().join("old.jsonl");
        std::fs::write(&src, CLAUDE).unwrap();
        let f = fork(&LocalTransport, "claude", src.to_str().unwrap(), "u1")
            .await
            .unwrap();
        assert_eq!(
            f,
            Forked {
                id: None,
                path: None,
                cwd: None
            }
        );
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn fork_never_overwrites_and_rejects_other_agents() {
        let d = tempfile::tempdir().unwrap();
        let taken = d.path().join("x.jsonl");
        std::fs::write(&taken, "keep").unwrap();
        assert_eq!(
            write_new(&LocalTransport, taken.to_str().unwrap(), "new")
                .await
                .unwrap_err()
                .code,
            "io"
        );
        assert_eq!(std::fs::read_to_string(&taken).unwrap(), "keep");
        assert_eq!(
            fork(&LocalTransport, "codex", taken.to_str().unwrap(), "u1")
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
    }
}
