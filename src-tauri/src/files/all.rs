use serde::Serialize;

use super::paths::script_argv;
use super::MAX_LIST_FILES;
use crate::complete::files::{is_home, SKIP_DIRS};
use crate::error::{AppError, AppResult};
use crate::transport::{exec_bytes, Transport};

/// Upper bound on the bytes read back, so a huge tree cannot flood the transport.
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct FileList {
    pub paths: Vec<String>,
    pub capped: bool,
    pub refused: bool,
}

/// `$1` is the root; the prune expression bakes in the constant `SKIP_DIRS` names.
/// Inside a git work tree the index decides (honouring .gitignore); elsewhere `find`
/// walks the folder. `git ls-files` fails outside a repo, so detect the work tree first.
/// Exit 3 when the root cannot be entered.
fn script() -> String {
    let prune = SKIP_DIRS
        .iter()
        .map(|n| format!("-name {n}"))
        .collect::<Vec<_>>()
        .join(" -o ");
    format!(
        r#"cd "$1" || exit 3
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files -z -co --exclude-standard
else
  find . \( -type d \( {prune} \) \) -prune -o -type f -print0
fi | head -c {MAX_OUTPUT_BYTES}"#
    )
}

/// Every file below `root`, `/`-separated and sorted. The home folder and `/` are
/// refused (`refused: true`) without running anything.
pub async fn list_all(t: &dyn Transport, home: &str, root: &str) -> AppResult<FileList> {
    if is_home(home, root) || root.trim_end_matches('/').is_empty() {
        return Ok(FileList {
            paths: Vec::new(),
            capped: false,
            refused: true,
        });
    }
    let out = exec_bytes(t, &script_argv(&script(), &[root])).await?;
    match out.status {
        0 => {}
        3 => {
            return Err(AppError::new(
                "not_found",
                format!("no such folder: {root:?}"),
            ))
        }
        _ => return Err(AppError::new("io", out.stderr.trim().to_string())),
    }
    let mut records: Vec<&[u8]> = out.stdout.split(|b| *b == 0).collect();
    // The last piece is empty after a final NUL; otherwise the output was cut mid-record.
    records.pop();
    let mut paths: Vec<String> = records
        .into_iter()
        .filter(|r| !r.is_empty())
        .map(|r| String::from_utf8_lossy(r).into_owned())
        .map(|p| p.strip_prefix("./").map(str::to_string).unwrap_or(p))
        .filter(|p| !p.split('/').any(|seg| SKIP_DIRS.contains(&seg)))
        .collect();
    paths.sort();
    let capped = paths.len() > MAX_LIST_FILES;
    paths.truncate(MAX_LIST_FILES);
    Ok(FileList {
        paths,
        capped,
        refused: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;
    use std::process::Command;

    fn mk(root: &std::path::Path, files: &[&str]) {
        for p in files {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "x").unwrap();
        }
    }

    #[tokio::test]
    async fn git_repo_respects_gitignore_and_lists_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("repo");
        mk(
            &r,
            &[
                ".gitignore",
                "src/a.ts",
                "out/gen.js",
                "new file.md",
                "node_modules/m.js",
            ],
        );
        std::fs::write(r.join(".gitignore"), "out/\n").unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&r)
            .status()
            .unwrap();
        Command::new("git")
            .args(["add", "src/a.ts", ".gitignore", "-f", "node_modules/m.js"])
            .current_dir(&r)
            .status()
            .unwrap();
        let got = list_all(&LocalTransport, "/nonexistent-home", &r.to_string_lossy())
            .await
            .unwrap();
        assert_eq!(
            got,
            FileList {
                paths: vec![".gitignore".into(), "new file.md".into(), "src/a.ts".into()],
                capped: false,
                refused: false
            }
        );
        // A subfolder root lists paths relative to itself.
        let sub = list_all(
            &LocalTransport,
            "/nonexistent-home",
            &r.join("src").to_string_lossy(),
        )
        .await
        .unwrap();
        assert_eq!(sub.paths, vec!["a.ts".to_string()]);
    }

    #[tokio::test]
    async fn plain_folder_uses_find_and_skips_heavy_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().join("plain");
        mk(&r, &["a.md", "target/x", "deep/b.md"]);
        let got = list_all(&LocalTransport, "/nonexistent-home", &r.to_string_lossy())
            .await
            .unwrap();
        assert_eq!(got.paths, vec!["a.md".to_string(), "deep/b.md".to_string()]);
    }

    #[tokio::test]
    async fn home_and_slash_are_refused() {
        for (home, root) in [("/home/u", "/home/u/"), ("/home/u", "/")] {
            let got = list_all(&LocalTransport, home, root).await.unwrap();
            assert!(got.refused && got.paths.is_empty(), "{root}");
        }
    }

    #[tokio::test]
    async fn missing_root_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let gone = tmp.path().join("gone");
        let err = list_all(
            &LocalTransport,
            "/nonexistent-home",
            &gone.to_string_lossy(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "not_found");
    }
}
