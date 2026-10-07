//! Upload and Download naming and source validation. Nothing is ever overwritten: a clash
//! gets the first free Finder-style name (ADR-0005).

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

/// One item dropped from Finder, validated by `check_sources`.
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub path: PathBuf,
    pub name: String,
    /// A real folder. A symlink to a folder is not one: it is copied as a link.
    pub is_dir: bool,
}

/// The `n`-th Finder-style variant of `name`: 0 is `name` itself, then `stem (n).ext`.
/// Folders and dotfiles (`.env`) have no extension; only the last dot splits (`a.tar (1).gz`).
pub fn candidate(name: &str, is_dir: bool, n: usize) -> String {
    if n == 0 {
        return name.to_string();
    }
    let split = if is_dir {
        None
    } else {
        name.rfind('.').filter(|&i| i > 0)
    };
    match split {
        Some(i) => format!("{} ({n}){}", &name[..i], &name[i..]),
        None => format!("{name} ({n})"),
    }
}

/// The first variant of `name` not in `taken` (lowercased names, case-insensitive volumes).
/// Records the pick, lowercased, so later items of the same batch skip it.
pub fn unique_name(taken: &mut HashSet<String>, name: &str, is_dir: bool) -> String {
    let mut n = 0;
    loop {
        let c = candidate(name, is_dir, n);
        if taken.insert(c.to_lowercase()) {
            return c;
        }
        n += 1;
    }
}

/// A `taken` set for `unique_name` from existing names.
pub fn taken_set<'a>(names: impl IntoIterator<Item = &'a str>) -> HashSet<String> {
    names.into_iter().map(str::to_lowercase).collect()
}

/// Validate the absolute paths the webview reports for a Finder drop.
pub fn check_sources(paths: &[String]) -> AppResult<Vec<Source>> {
    if paths.is_empty() {
        return Err(AppError::new("invalid", "nothing to upload"));
    }
    paths
        .iter()
        .map(|p| {
            if !p.starts_with('/') || p.contains('\0') || p.contains('\n') {
                return Err(AppError::new(
                    "invalid",
                    format!("not an absolute path: {p:?}"),
                ));
            }
            let path = PathBuf::from(p);
            let ft = match fs::symlink_metadata(&path) {
                Ok(m) => m.file_type(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(AppError::new("not_found", format!("{p}: no such file")))
                }
                Err(e) => return Err(AppError::new("io", format!("{p}: {e}"))),
            };
            if !(ft.is_file() || ft.is_dir() || ft.is_symlink()) {
                return Err(AppError::new(
                    "invalid",
                    format!("{p}: not a file, folder or symlink"),
                ));
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| AppError::new("invalid", format!("{p}: no usable file name")))?
                .to_string();
            Ok(Source {
                path,
                name,
                is_dir: ft.is_dir(),
            })
        })
        .collect()
}

/// `rel` under the absolute `root` ("" is the root itself).
pub fn join_abs(root: &str, rel: &str) -> String {
    if rel.is_empty() {
        root.to_string()
    } else if root.ends_with('/') {
        format!("{root}{rel}")
    } else {
        format!("{root}/{rel}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    #[test]
    fn candidate_follows_finder_style() {
        assert_eq!(candidate("report.md", false, 0), "report.md");
        assert_eq!(candidate("report.md", false, 1), "report (1).md");
        assert_eq!(candidate("report.md", false, 2), "report (2).md");
        assert_eq!(candidate("assets", true, 1), "assets (1)");
        assert_eq!(candidate("v1.2", true, 1), "v1.2 (1)");
        assert_eq!(candidate(".env", false, 1), ".env (1)");
        assert_eq!(candidate("a.tar.gz", false, 1), "a.tar (1).gz");
        assert_eq!(candidate("x (1).md", false, 1), "x (1) (1).md");
        assert_eq!(candidate("Makefile", false, 1), "Makefile (1)");
    }

    #[test]
    fn unique_name_skips_taken_case_insensitively_and_records_its_pick() {
        let mut taken = taken_set(["Report.md", "report (1).md"]);
        assert_eq!(unique_name(&mut taken, "report.md", false), "report (2).md");
        assert_eq!(unique_name(&mut taken, "new.md", false), "new.md");
        assert_eq!(unique_name(&mut taken, "a.png", false), "a.png");
        assert_eq!(unique_name(&mut taken, "A.png", false), "A (1).png");
    }

    #[test]
    fn join_abs_handles_root_and_slash() {
        assert_eq!(join_abs("/r", ""), "/r");
        assert_eq!(join_abs("/r", "a/b"), "/r/a/b");
        assert_eq!(join_abs("/", "a"), "/a");
        assert_eq!(join_abs("/", ""), "/");
    }

    #[test]
    fn check_sources_validates_paths_and_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        fs::write(p.join("a.md"), "x").unwrap();
        fs::create_dir(p.join("d")).unwrap();
        symlink(p.join("d"), p.join("link")).unwrap();
        symlink(p.join("missing"), p.join("dangling")).unwrap();

        assert_eq!(check_sources(&[]).unwrap_err().code, "invalid");
        assert_eq!(
            check_sources(&["rel/a.md".into()]).unwrap_err().code,
            "invalid"
        );
        assert_eq!(
            check_sources(&[format!("{}/a\nb", p.display())])
                .unwrap_err()
                .code,
            "invalid"
        );
        assert_eq!(
            check_sources(&[format!("{}/nope", p.display())])
                .unwrap_err()
                .code,
            "not_found"
        );
        let fifo = p.join("pipe");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        assert_eq!(
            check_sources(&[fifo.to_str().unwrap().into()])
                .unwrap_err()
                .code,
            "invalid"
        );

        let got = check_sources(&[
            format!("{}/a.md", p.display()),
            format!("{}/d", p.display()),
            format!("{}/link", p.display()),
            format!("{}/dangling", p.display()),
        ])
        .unwrap();
        let summary: Vec<_> = got.iter().map(|s| (s.name.as_str(), s.is_dir)).collect();
        // A symlink to a folder is not a folder: it is copied as a link.
        assert_eq!(
            summary,
            [
                ("a.md", false),
                ("d", true),
                ("link", false),
                ("dangling", false)
            ]
        );
    }
}
