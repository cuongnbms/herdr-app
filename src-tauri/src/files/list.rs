use serde::Serialize;

use super::paths::{check_rel, script_argv};
use super::MAX_DIR_ENTRIES;
use crate::complete::files::SKIP_DIRS;
use crate::error::{AppError, AppResult};
use crate::transport::{exec_bytes, Transport};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    /// A symlink to a folder: it expands like a folder.
    DirLink,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
}

/// `$1` is the root, `$2` the folder below it. Exit 3 when either cannot be entered.
/// An unmatched glob yields its own pattern, so entries that do not exist are skipped.
const LIST_SCRIPT: &str = r#"cd "$1" && cd "./$2" || exit 3
for e in * .*; do
  case "$e" in .|..) continue;; esac
  case "$e" in *"
"*) continue;; esac
  [ -e "./$e" ] || [ -L "./$e" ] || continue
  if [ -L "./$e" ]; then
    if [ -d "./$e" ]; then k=L; else k=l; fi
  elif [ -d "./$e" ]; then k=d; else k=f; fi
  printf '%s\t%s\n' "$k" "$e"
done"#;

/// One level of `rel` below `root`: folders (linked ones too) first, then files and symlinks,
/// each sorted case-insensitively. Heavy folders (`SKIP_DIRS`) are left out; a linked folder
/// is kept whatever its name, as `complete/files.rs` (`find -type d`) keeps it too.
pub async fn list_dir(t: &dyn Transport, root: &str, rel: &str) -> AppResult<Vec<Entry>> {
    check_rel(rel)?;
    let out = exec_bytes(t, &script_argv(LIST_SCRIPT, &[root, rel])).await?;
    match out.status {
        0 => {}
        3 => {
            return Err(AppError::new(
                "not_found",
                format!("no such folder: {rel:?}"),
            ))
        }
        _ => return Err(AppError::new("io", out.stderr.trim().to_string())),
    }
    let mut entries: Vec<Entry> = out
        .stdout
        .split(|b| *b == b'\n')
        .filter_map(|line| {
            let line = String::from_utf8_lossy(line);
            let (k, name) = line.split_once('\t')?;
            let kind = match k {
                "d" => EntryKind::Dir,
                "l" => EntryKind::Symlink,
                "L" => EntryKind::DirLink,
                "f" => EntryKind::File,
                _ => return None,
            };
            if kind == EntryKind::Dir && SKIP_DIRS.contains(&name) {
                return None;
            }
            Some(Entry {
                name: name.to_string(),
                kind,
            })
        })
        .collect();
    entries.sort_by_key(|e| {
        (
            !matches!(e.kind, EntryKind::Dir | EntryKind::DirLink),
            e.name.to_lowercase(),
        )
    });
    entries.truncate(MAX_DIR_ENTRIES);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::local::LocalTransport;

    fn mk(root: &std::path::Path, files: &[&str]) {
        for p in files {
            let f = root.join(p);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, "x").unwrap();
        }
    }

    #[tokio::test]
    async fn lists_one_level_dirs_first_skipping_heavy_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("my root");
        mk(
            &root,
            &[
                "b.md",
                "A.txt",
                "src/x.ts",
                "node_modules/y.js",
                ".git/HEAD",
                "-dash.md",
                "it's.md",
                "build",
            ],
        );
        std::os::unix::fs::symlink("b.md", root.join("link")).unwrap();
        std::os::unix::fs::symlink("src", root.join("srclink")).unwrap();
        std::os::unix::fs::symlink("gone", root.join("dangling")).unwrap();
        let got = list_dir(&LocalTransport, &root.to_string_lossy(), "")
            .await
            .unwrap();
        let names: Vec<(&str, &EntryKind)> =
            got.iter().map(|e| (e.name.as_str(), &e.kind)).collect();
        assert_eq!(
            names,
            vec![
                ("src", &EntryKind::Dir),
                ("srclink", &EntryKind::DirLink),
                ("-dash.md", &EntryKind::File),
                ("A.txt", &EntryKind::File),
                ("b.md", &EntryKind::File),
                ("build", &EntryKind::File),
                ("dangling", &EntryKind::Symlink),
                ("it's.md", &EntryKind::File),
                ("link", &EntryKind::Symlink),
            ]
        );
        let sub = list_dir(&LocalTransport, &root.to_string_lossy(), "src")
            .await
            .unwrap();
        assert_eq!(
            sub,
            vec![Entry {
                name: "x.ts".into(),
                kind: EntryKind::File
            }]
        );
        let linked = list_dir(&LocalTransport, &root.to_string_lossy(), "srclink")
            .await
            .unwrap();
        assert_eq!(linked, sub);
    }

    #[tokio::test]
    async fn missing_folder_is_not_found_and_escape_is_invalid() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path().to_string_lossy().into_owned();
        assert_eq!(
            list_dir(&LocalTransport, &r, "nope")
                .await
                .unwrap_err()
                .code,
            "not_found"
        );
        assert_eq!(
            list_dir(&LocalTransport, &r, "../").await.unwrap_err().code,
            "invalid"
        );
    }
}
