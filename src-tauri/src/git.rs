//! The folder and git branch a Pane works in, for the Chat lens status line.
use crate::error::AppResult;
use crate::transport::{exec, Transport};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GitStatus {
    /// The working directory's last path segment.
    pub folder: String,
    pub path: String,
    /// The branch, or the short commit on a detached HEAD; None outside a repository.
    pub branch: Option<String>,
    /// Uncommitted or untracked changes in the working tree.
    pub dirty: bool,
}

/// Prints the branch (else the short commit) and `dirty`/`clean`; nothing outside a repository.
/// `--no-optional-locks` keeps `git status` from taking the index lock an agent may need.
const SCRIPT: &str = r#"cd "$1" 2>/dev/null || exit 0
b=$(git symbolic-ref --short -q HEAD 2>/dev/null) || b=$(git rev-parse --short HEAD 2>/dev/null) || exit 0
printf '%s\n' "$b"
if [ -n "$(git --no-optional-locks status --porcelain 2>/dev/null | head -n 1)" ]; then echo dirty; else echo clean; fi"#;

pub async fn git_status(t: &dyn Transport, cwd: &str) -> AppResult<GitStatus> {
    let argv = vec![
        "sh".to_string(),
        "-c".into(),
        SCRIPT.into(),
        "sh".into(),
        cwd.to_string(),
    ];
    let o = exec(t, &argv).await?;
    let mut lines = o.stdout.lines();
    let branch = lines
        .next()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    let dirty = branch.is_some() && lines.next().map(str::trim) == Some("dirty");
    Ok(GitStatus {
        folder: folder_name(cwd),
        path: cwd.to_string(),
        branch,
        dirty,
    })
}

fn folder_name(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    match trimmed.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => "/".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    fn repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        git(dir, &["add", "a.txt"]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }

    async fn status(dir: &Path) -> GitStatus {
        git_status(&LocalTransport, &dir.to_string_lossy())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_clean_repo_reports_its_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("my repo");
        repo(&dir);
        let s = status(&dir).await;
        assert_eq!(s.folder, "my repo");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert!(!s.dirty);
    }

    #[tokio::test]
    async fn changes_and_untracked_files_make_it_dirty() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        std::fs::write(dir.join("new.txt"), "n").unwrap();
        assert!(status(&dir).await.dirty);
    }

    #[tokio::test]
    async fn a_detached_head_reports_the_short_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        repo(&dir);
        git(&dir, &["checkout", "-q", "--detach"]);
        let b = status(&dir).await.branch.unwrap();
        assert!(
            b.len() >= 7 && b.chars().all(|c| c.is_ascii_hexdigit()),
            "{b}"
        );
    }

    #[tokio::test]
    async fn a_repo_without_commits_reports_its_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "trunk"]);
        assert_eq!(status(&dir).await.branch.as_deref(), Some("trunk"));
    }

    #[tokio::test]
    async fn outside_a_repo_there_is_only_the_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("plain");
        std::fs::create_dir_all(&dir).unwrap();
        let s = status(&dir).await;
        assert_eq!(s.folder, "plain");
        assert_eq!(s.branch, None);
        assert!(!s.dirty);
    }

    #[tokio::test]
    async fn a_missing_folder_has_no_branch() {
        let s = git_status(&LocalTransport, "/nonexistent/herdr-app/")
            .await
            .unwrap();
        assert_eq!(s.folder, "herdr-app");
        assert_eq!(s.branch, None);
    }

    #[test]
    fn folder_names() {
        assert_eq!(folder_name("/a/b"), "b");
        assert_eq!(folder_name("/a/b/"), "b");
        assert_eq!(folder_name("/"), "/");
        assert_eq!(folder_name("~"), "~");
    }
}
