use serde::Serialize;

use super::paths::script_argv;
use super::MAX_CHANGED;
use crate::error::{AppError, AppResult};
use crate::git::{parse_porcelain_v2, GitChange};
use crate::transport::{exec, Transport};

#[derive(Serialize, Debug, PartialEq)]
pub struct Changed {
    /// False when the root is missing or not inside a git repository.
    pub repo: bool,
    /// Changed files under the root, however many are listed.
    pub total: u32,
    pub changes: Vec<GitChange>,
}

/// `$1` is the root. Prints the root's path inside the repository (empty at the top, else ending
/// in `/`) as one NUL-terminated record, then `git status` limited to the root; nothing outside a
/// repository.
const CHANGED_SCRIPT: &str = r#"cd "$1" 2>/dev/null || exit 0
p=$(git rev-parse --show-prefix 2>/dev/null) || exit 0
printf '%s\0' "$p"
exec git --no-optional-locks status --porcelain=v2 -z -uall -- ."#;

/// Changed files under `root`, with paths relative to it; the first `MAX_CHANGED` are listed.
pub async fn changed(t: &dyn Transport, root: &str) -> AppResult<Changed> {
    let o = exec(t, &script_argv(CHANGED_SCRIPT, &[root])).await?;
    if o.status != 0 {
        return Err(AppError::new("io", o.stderr.trim().to_string()));
    }
    let Some((prefix, rest)) = o.stdout.split_once('\0') else {
        return Ok(Changed {
            repo: false,
            total: 0,
            changes: vec![],
        });
    };
    let mut changes: Vec<GitChange> = parse_porcelain_v2(rest, usize::MAX)
        .changes
        .into_iter()
        .filter_map(|c| {
            let path = c.path.strip_prefix(prefix)?.to_string();
            Some(GitChange { path, ..c })
        })
        .collect();
    let total = changes.len() as u32;
    changes.truncate(MAX_CHANGED);
    Ok(Changed {
        repo: true,
        total,
        changes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;
    use std::process::Command;

    #[tokio::test]
    async fn changes_are_relative_to_a_subfolder_root() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("repo");
        std::fs::create_dir_all(r.join("app/src")).unwrap();
        std::fs::write(r.join("top.md"), "1").unwrap();
        std::fs::write(r.join("app/src/a.ts"), "1").unwrap();
        let git = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&r)
                .output()
                .unwrap();
        };
        git(&["init", "-q"]);
        git(&["-c", "user.email=a@b", "-c", "user.name=a", "add", "."]);
        git(&[
            "-c",
            "user.email=a@b",
            "-c",
            "user.name=a",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "init",
        ]);
        std::fs::write(r.join("top.md"), "2").unwrap();
        std::fs::write(r.join("app/src/a.ts"), "2").unwrap();
        std::fs::write(r.join("app/new.md"), "n").unwrap();

        let got = changed(&LocalTransport, &r.join("app").to_string_lossy())
            .await
            .unwrap();
        assert!(got.repo);
        assert_eq!(got.total, 2);
        let paths: Vec<(&str, &str)> = got
            .changes
            .iter()
            .map(|c| (c.code.as_str(), c.path.as_str()))
            .collect();
        assert!(paths.contains(&(" M", "src/a.ts")));
        assert!(paths.contains(&("??", "new.md")));
    }

    #[tokio::test]
    async fn outside_a_repo_is_not_a_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let got = changed(&LocalTransport, &tmp.path().to_string_lossy())
            .await
            .unwrap();
        assert_eq!(
            got,
            Changed {
                repo: false,
                total: 0,
                changes: vec![]
            }
        );
    }

    #[tokio::test]
    async fn renames_are_listed_once_and_the_list_is_capped() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        let git = |args: &[&str]| {
            Command::new("git")
                .args([
                    "-c",
                    "user.email=a@b",
                    "-c",
                    "user.name=a",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .current_dir(r)
                .output()
                .unwrap();
        };
        git(&["init", "-q"]);
        std::fs::write(r.join("old.txt"), "some content here\nmore\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "init"]);
        git(&["mv", "old.txt", "new.txt"]);
        for i in 0..(MAX_CHANGED + 5) {
            std::fs::write(r.join(format!("u{i:03}")), "x").unwrap();
        }
        let got = changed(&LocalTransport, &r.to_string_lossy())
            .await
            .unwrap();
        assert_eq!(got.total as usize, MAX_CHANGED + 6);
        assert_eq!(got.changes.len(), MAX_CHANGED);
        assert!(got
            .changes
            .iter()
            .any(|c| c.code == "R " && c.path == "new.txt"));
        assert!(!got.changes.iter().any(|c| c.path == "old.txt"));
    }
}
