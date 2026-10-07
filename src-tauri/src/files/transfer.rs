//! Upload and Download naming and source validation. Nothing is ever overwritten: a clash
//! gets the first free Finder-style name (ADR-0005).

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::files::paths::{io_error, script_argv};
use crate::transport::{sh_quote, Transport};

/// Hard limit for one transfer.
pub const TRANSFER_TIMEOUT: Duration = Duration::from_secs(600);

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

/// How a spawned transfer command ended.
#[derive(Debug)]
pub struct Exit {
    pub code: i32,
    pub stderr: String,
}

/// Run `argv` on the Machine with piped stdio and `io` on its stdin/stdout in a separate thread,
/// while this thread waits for the child and kills it at `timeout` (which also unblocks `io`).
/// `io` must drop stdin to signal EOF. Returns the child's exit and `io`'s own result.
pub fn run_piped<T: Send + 'static>(
    t: &dyn Transport,
    argv: &[String],
    timeout: Duration,
    io: impl FnOnce(ChildStdin, ChildStdout) -> AppResult<T> + Send + 'static,
) -> AppResult<(Exit, AppResult<T>)> {
    let full = t.wrap(argv, false);
    let (prog, args) = full
        .split_first()
        .ok_or_else(|| AppError::new("invalid", "empty command"))?;
    let mut child = Command::new(prog)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::new("io", format!("cannot start {prog}: {e}")))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    // Drain stderr concurrently so a chatty child cannot block on a full pipe.
    let err_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });
    let io_thread = thread::spawn(move || io(stdin, stdout));

    let deadline = Instant::now() + timeout;
    let mut wait_err = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                wait_err = Some(AppError::new("io", e.to_string()));
                break None;
            }
        }
    };
    // The child is gone, so its pipes are closed and both threads finish.
    let io_res = io_thread
        .join()
        .unwrap_or_else(|_| Err(AppError::new("io", "transfer thread panicked")));
    let stderr = err_thread.join().unwrap_or_default().trim().to_string();
    if let Some(e) = wait_err {
        return Err(e);
    }
    match status {
        None => Err(AppError::new(
            "timeout",
            format!("transfer timed out after {}s", timeout.as_secs()),
        )),
        Some(s) => Ok((
            Exit {
                code: s.code().unwrap_or(-1),
                stderr,
            },
            io_res,
        )),
    }
}

/// Script for `sh -c` (destination is `$1`): unpack the tar stream into a staging dir, require
/// the `done` marker, then move each item into place without ever replacing anything.
pub fn upload_cmd(names: &[String]) -> String {
    let mut s = String::from(
        "set -e\n\
         t=$(mktemp -d \"$1/.herdr-upload.XXXXXX\"); trap 'rm -rf \"$t\"' EXIT\n\
         tar -xf - -C \"$t\"\n\
         if [ ! -e \"$t\"/done ]; then echo 'upload was interrupted' >&2; exit 1; fi\n",
    );
    for name in names {
        let n = sh_quote(name);
        let msg = sh_quote(&format!("{name} already exists, try again"));
        s.push_str(&format!(
            "if [ -e \"$1\"/{n} ] || [ -L \"$1\"/{n} ]; then printf '%s\\n' {msg} >&2; exit 1; fi\n\
             mv -n -- \"$t\"/i/{n} \"$1\"/{n} || true\n\
             if [ -e \"$t\"/i/{n} ] || [ -L \"$t\"/i/{n} ]; then printf '%s\\n' {msg} >&2; exit 1; fi\n"
        ));
    }
    s
}

/// Write a tar stream: each source as `i/<name>` (symlinks kept as links), then an empty `done`
/// entry. Without `done` the remote places nothing.
pub fn write_upload_stream(w: impl Write, items: &[(Source, String)]) -> AppResult<()> {
    let mut b = tar::Builder::new(w);
    b.follow_symlinks(false);
    for (s, name) in items {
        let in_tar = format!("i/{name}");
        let added = if s.is_dir {
            b.append_dir_all(&in_tar, &s.path)
        } else {
            b.append_path_with_name(&s.path, &in_tar)
        };
        added.map_err(|e| AppError::new("io", format!("{}: {e}", s.path.display())))?;
    }
    let mut h = tar::Header::new_gnu();
    h.set_size(0);
    h.set_mode(0o644);
    h.set_entry_type(tar::EntryType::Regular);
    b.append_data(&mut h, "done", &b""[..])
        .map_err(|e| AppError::new("io", format!("cannot append done marker: {e}")))?;
    b.into_inner()
        .map(drop)
        .map_err(|e| AppError::new("io", format!("upload stream: {e}")))
}

/// Copy `sources` into the folder `dest_abs` on the Machine, never replacing anything. `existing`
/// are the names already there. Blocking; returns the final names in source order.
pub fn upload(
    t: &dyn Transport,
    dest_abs: &str,
    existing: &[String],
    sources: Vec<Source>,
) -> AppResult<Vec<String>> {
    let mut taken = taken_set(existing.iter().map(String::as_str));
    let items: Vec<(Source, String)> = sources
        .into_iter()
        .map(|s| {
            let name = unique_name(&mut taken, &s.name, s.is_dir);
            (s, name)
        })
        .collect();
    let names: Vec<String> = items.iter().map(|(_, n)| n.clone()).collect();
    let argv = script_argv(&upload_cmd(&names), &[dest_abs]);
    let (exit, io) = run_piped(t, &argv, TRANSFER_TIMEOUT, move |stdin, _| {
        write_upload_stream(stdin, &items)
    })?;
    match io {
        // The stream failed before `done`, so the remote's "interrupted" is only a symptom.
        Err(local) if exit.stderr.contains("upload was interrupted") => Err(local),
        _ if exit.code != 0 => Err(io_error(exit.code, &exit.stderr)),
        Err(local) => Err(local),
        Ok(()) => Ok(names),
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

    use crate::transport::local::LocalTransport;

    fn src(p: &std::path::Path) -> Source {
        check_sources(&[p.to_str().unwrap().to_string()])
            .unwrap()
            .remove(0)
    }
    /// Sorted names in `dir`, hidden ones included.
    fn ls(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn upload_copies_tree_keeps_symlinks_and_renames_on_conflict() {
        let from = tempfile::tempdir().unwrap();
        let f = from.path();
        fs::create_dir_all(f.join("assets/deep")).unwrap();
        fs::write(f.join("assets/deep/b c.md"), "deep").unwrap();
        symlink("deep/b c.md", f.join("assets/link.md")).unwrap();
        fs::write(f.join("it's a b.md"), "q").unwrap();
        let to = tempfile::tempdir().unwrap();
        let t = to.path();
        let dest = t.to_str().unwrap();
        let sources = vec![src(&f.join("assets")), src(&f.join("it's a b.md"))];

        assert_eq!(
            upload(&LocalTransport, dest, &[], sources.clone()).unwrap(),
            ["assets", "it's a b.md"]
        );
        assert_eq!(
            fs::read_to_string(t.join("assets/deep/b c.md")).unwrap(),
            "deep"
        );
        assert_eq!(
            fs::read_link(t.join("assets/link.md")).unwrap(),
            std::path::PathBuf::from("deep/b c.md")
        );
        assert_eq!(fs::read_to_string(t.join("it's a b.md")).unwrap(), "q");

        let existing = ls(t);
        assert_eq!(
            upload(&LocalTransport, dest, &existing, sources).unwrap(),
            ["assets (1)", "it's a b (1).md"]
        );
        assert_eq!(
            ls(t),
            ["assets", "assets (1)", "it's a b (1).md", "it's a b.md"]
        );
    }

    #[test]
    fn upload_fails_on_a_name_taken_after_listing_and_never_replaces() {
        let from = tempfile::tempdir().unwrap();
        fs::write(from.path().join("a.md"), "new").unwrap();
        fs::write(from.path().join("b.md"), "new").unwrap();
        let to = tempfile::tempdir().unwrap();
        fs::write(to.path().join("b.md"), "old").unwrap();
        // The listing missed b.md: it "appeared" after listing.
        let err = upload(
            &LocalTransport,
            to.path().to_str().unwrap(),
            &[],
            vec![
                src(&from.path().join("a.md")),
                src(&from.path().join("b.md")),
            ],
        )
        .unwrap_err();
        assert!(
            err.message.contains("b.md already exists, try again"),
            "{err:?}"
        );
        assert_eq!(fs::read_to_string(to.path().join("b.md")).unwrap(), "old");
        // a.md was moved before the failure and stays; no staging dir is left.
        assert_eq!(ls(to.path()), ["a.md", "b.md"]);
    }

    #[test]
    fn upload_without_the_done_marker_places_nothing() {
        let to = tempfile::tempdir().unwrap();
        let argv: Vec<String> = [
            "sh",
            "-c",
            &upload_cmd(&["a.md".into()]),
            "sh",
            to.path().to_str().unwrap(),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (exit, io) = run_piped(&LocalTransport, &argv, TRANSFER_TIMEOUT, |stdin, _| {
            let mut b = tar::Builder::new(stdin);
            let mut h = tar::Header::new_gnu();
            h.set_size(1);
            h.set_mode(0o644);
            b.append_data(&mut h, "i/a.md", &b"x"[..]).unwrap();
            b.into_inner()
                .map(drop)
                .map_err(|e| AppError::new("io", e.to_string()))
        })
        .unwrap();
        io.unwrap();
        assert_ne!(exit.code, 0);
        assert!(
            exit.stderr.contains("upload was interrupted"),
            "{}",
            exit.stderr
        );
        assert!(ls(to.path()).is_empty());
    }

    #[test]
    fn upload_reports_the_local_error_when_a_source_cannot_be_read() {
        let from = tempfile::tempdir().unwrap();
        let locked = from.path().join("locked.md");
        fs::write(&locked, "x").unwrap();
        let s = src(&locked);
        fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o000)).unwrap();
        let to = tempfile::tempdir().unwrap();
        let err = upload(&LocalTransport, to.path().to_str().unwrap(), &[], vec![s]).unwrap_err();
        assert!(err.message.contains("locked.md"), "{err:?}");
        assert!(ls(to.path()).is_empty());
    }

    #[test]
    fn run_piped_kills_the_child_after_the_timeout() {
        let argv: Vec<String> = vec!["sleep".into(), "5".into()];
        let started = std::time::Instant::now();
        let err = run_piped(
            &LocalTransport,
            &argv,
            Duration::from_millis(200),
            |stdin, _| {
                drop(stdin);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
