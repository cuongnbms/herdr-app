//! The live Files watch loops: `inotifywait` or a portable `find` poll on a Machine over its
//! transport, FSEvents (via the `notify` crate) on this Mac. Each loop sends `WatchEvent`s to a sink.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ::notify::event::{CreateKind, RemoveKind};
use ::notify::{EventKind, RecursiveMode, Watcher};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc;

use super::watch::{
    adds_excluded_dir, dedupe, exit_message, inotify_cmd, parse_inotify_line, parse_poll_record,
    poll_cmd, Backoff, Change, PollRecord, WatchEvent,
};
use crate::complete::files::SKIP_DIRS;
use crate::error::{AppError, AppResult};
use crate::transport::{exec, Transport};

const DEBOUNCE: Duration = Duration::from_millis(300);
/// Inotify sessions that end without a single event before the run settles for the poll.
const INOTIFY_FAILURES: usize = 3;

pub type WatchSink = Arc<dyn Fn(WatchEvent) + Send + Sync>;

/// Watch `root` until the task is aborted, restarting after errors with a backoff.
pub async fn run_watch(t: Arc<dyn Transport>, local: bool, root: String, sink: WatchSink) {
    // Whether the current attempt delivered any change: an attempt that did not is a failure
    // of inotify itself (e.g. its watch limit), not of the connection.
    let got_event = Arc::new(AtomicBool::new(false));
    let tracked: WatchSink = {
        let (sink, got_event) = (sink.clone(), got_event.clone());
        Arc::new(move |e| {
            if matches!(e, WatchEvent::Changes { .. }) {
                got_event.store(true, Ordering::Relaxed);
            }
            sink(e)
        })
    };
    let mut backoff = Backoff::default();
    let mut has_inotify = None;
    let mut silent_failures = 0;
    let mut poll_only = false;
    loop {
        got_event.store(false, Ordering::Relaxed);
        let mut inotify = false;
        let result = if local {
            watch_local(&root, &tracked, &mut backoff).await
        } else {
            if has_inotify.is_none() {
                has_inotify = Some(
                    exec(
                        &*t,
                        &[
                            "sh".into(),
                            "-c".into(),
                            "command -v inotifywait >/dev/null 2>&1".into(),
                        ],
                    )
                    .await
                    .map(|o| o.status == 0)
                    .unwrap_or(false),
                );
            }
            if has_inotify == Some(true) && !poll_only {
                inotify = true;
                watch_inotify(&*t, &root, &tracked, &mut backoff).await
            } else {
                watch_poll(&*t, &root, &tracked, &mut backoff).await
            }
        };
        if let Err(e) = result {
            sink(WatchEvent::Error { message: e.message });
            if inotify && !got_event.load(Ordering::Relaxed) {
                silent_failures += 1;
                if silent_failures >= INOTIFY_FAILURES {
                    poll_only = true;
                }
            }
            tokio::time::sleep(backoff.next_delay()).await;
        }
    }
}

/// Start `script` on the Machine. The caller keeps `child.stdin` open for as long as it reads:
/// the script's watchdog ends the watcher when that stdin reaches EOF.
pub(crate) fn spawn_stream(t: &dyn Transport, script: &str) -> AppResult<Child> {
    let argv = t.wrap(&["sh".into(), "-c".into(), script.into()], false);
    let program = argv
        .first()
        .ok_or_else(|| AppError::new("invalid", "empty command"))?;
    tokio::process::Command::new(program)
        .args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::new("io", format!("cannot start watch: {e}")))
}

/// The error for a watch session whose stdout ended, with the reason from its stderr.
async fn ended(child: &mut Child) -> AppError {
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ =
            tokio::time::timeout(Duration::from_secs(2), pipe.read_to_string(&mut stderr)).await;
    }
    AppError::new("io", exit_message(&stderr))
}

fn missing_pipe(name: &str) -> AppError {
    AppError::new("io", format!("watch has no {name}"))
}

/// Portable fallback: one batch per scan of the remote `find` loop.
pub(crate) async fn watch_poll(
    t: &dyn Transport,
    root: &str,
    sink: &WatchSink,
    backoff: &mut Backoff,
) -> AppResult<()> {
    let mut child = spawn_stream(t, &poll_cmd(root))?;
    let _stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or_else(|| missing_pipe("stdout"))?;
    let mut reader = BufReader::new(stdout);
    sink(WatchEvent::Resync);
    let mut batch: Vec<Change> = Vec::new();
    let mut rec = Vec::new();
    loop {
        rec.clear();
        let n = reader
            .read_until(0, &mut rec)
            .await
            .map_err(|e| AppError::new("io", e.to_string()))?;
        if n == 0 || rec.last() != Some(&0) {
            return Err(ended(&mut child).await);
        }
        rec.pop();
        backoff.reset();
        match parse_poll_record(root, &rec) {
            Some(PollRecord::Change(change)) => batch.push(change),
            Some(PollRecord::End) => {
                if !batch.is_empty() {
                    sink(WatchEvent::Changes {
                        changes: dedupe(std::mem::take(&mut batch)),
                    });
                }
            }
            None => {}
        }
    }
}

/// `Ok(())` means restart: a heavy folder appeared, and `inotifywait -r` would otherwise
/// watch everything inside it.
pub(crate) async fn watch_inotify(
    t: &dyn Transport,
    root: &str,
    sink: &WatchSink,
    backoff: &mut Backoff,
) -> AppResult<()> {
    let mut child = spawn_stream(t, &inotify_cmd(root))?;
    let _stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or_else(|| missing_pipe("stdout"))?;
    let mut lines = BufReader::new(stdout).lines();
    sink(WatchEvent::Resync);
    let mut batch: Vec<Change> = Vec::new();
    loop {
        // Wait indefinitely for the first event; then flush once 300 ms pass without another.
        let next = if batch.is_empty() {
            Some(lines.next_line().await)
        } else {
            tokio::time::timeout(DEBOUNCE, lines.next_line()).await.ok()
        };
        match next {
            None => sink(WatchEvent::Changes {
                changes: dedupe(std::mem::take(&mut batch)),
            }),
            Some(Ok(Some(line))) => {
                backoff.reset();
                if let Some(change) = parse_inotify_line(root, &line) {
                    let restart = adds_excluded_dir(&change);
                    batch.push(change);
                    if restart {
                        sink(WatchEvent::Changes {
                            changes: dedupe(batch),
                        });
                        return Ok(());
                    }
                }
            }
            Some(Ok(None)) => return Err(ended(&mut child).await),
            Some(Err(e)) => return Err(AppError::new("io", e.to_string())),
        }
    }
}

/// FSEvents (or the OS equivalent) on this machine, batched with the same debounce.
pub(crate) async fn watch_local(
    root: &str,
    sink: &WatchSink,
    backoff: &mut Backoff,
) -> AppResult<()> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut watcher =
        ::notify::recommended_watcher(move |res: ::notify::Result<::notify::Event>| {
            let _ = tx.send(res);
        })
        .map_err(|e| AppError::new("io", format!("cannot start watcher: {e}")))?;
    watcher
        .watch(Path::new(root), RecursiveMode::Recursive)
        .map_err(|e| AppError::new("io", format!("cannot watch {root}: {e}")))?;
    sink(WatchEvent::Resync);
    let mut roots = vec![PathBuf::from(root)];
    if let Ok(canonical) = std::fs::canonicalize(root) {
        roots.push(canonical);
    }
    let mut batch: Vec<Change> = Vec::new();
    loop {
        let next = if batch.is_empty() {
            Some(rx.recv().await)
        } else {
            tokio::time::timeout(DEBOUNCE, rx.recv()).await.ok()
        };
        match next {
            None => sink(WatchEvent::Changes {
                changes: dedupe(std::mem::take(&mut batch)),
            }),
            Some(Some(Ok(event))) => {
                backoff.reset();
                batch.extend(
                    event
                        .paths
                        .iter()
                        .filter_map(|p| local_change(&roots, p, &event.kind)),
                );
            }
            Some(Some(Err(e))) => return Err(AppError::new("io", format!("watch error: {e}"))),
            Some(None) => return Err(AppError::new("io", "watcher stopped")),
        }
    }
}

/// The `Change` for one FSEvents path under any spelling of the root (as configured and
/// canonicalized, e.g. `/var/...` vs `/private/var/...`). The file system is consulted for
/// `removed` and `is_dir` because FSEvents coalesces event kinds.
fn local_change(roots: &[PathBuf], path: &Path, kind: &EventKind) -> Option<Change> {
    if matches!(kind, EventKind::Access(_)) {
        return None;
    }
    let rel = roots.iter().find_map(|r| path.strip_prefix(r).ok())?;
    let rel = rel.to_string_lossy().into_owned();
    if rel.split('/').any(|seg| SKIP_DIRS.contains(&seg)) {
        return None;
    }
    let (is_dir, removed) = match std::fs::symlink_metadata(path) {
        Ok(m) => (m.is_dir(), false),
        Err(_) => (
            matches!(
                kind,
                EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
            ),
            true,
        ),
    };
    Some(Change {
        path: rel,
        is_dir,
        removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::watch::{Change, WatchEvent};
    use crate::transport::local::LocalTransport;
    use std::time::Duration;
    use tokio::sync::mpsc;

    fn collect() -> (WatchSink, mpsc::UnboundedReceiver<WatchEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Arc::new(move |e| {
                let _ = tx.send(e);
            }),
            rx,
        )
    }

    /// Changes until `want` matches one, failing after 15 s.
    async fn until(
        rx: &mut mpsc::UnboundedReceiver<WatchEvent>,
        want: impl Fn(&Change) -> bool,
    ) -> Vec<Change> {
        let mut seen = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(WatchEvent::Changes { changes })) => {
                    let hit = changes.iter().any(&want);
                    seen.extend(changes);
                    if hit {
                        return seen;
                    }
                }
                Ok(Some(_)) => {}
                _ => panic!("timed out, saw {seen:?}"),
            }
        }
    }

    #[tokio::test]
    async fn poll_reports_new_files_and_folder_changes_but_nothing_inside_heavy_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("a b");
        std::fs::create_dir(&root).unwrap();
        let root_s = root.to_string_lossy().into_owned();
        let (sink, mut rx) = collect();
        let r = root_s.clone();
        let task = tokio::spawn(async move {
            watch_poll(&LocalTransport, &r, &sink, &mut Backoff::default()).await
        });
        assert!(matches!(rx.recv().await, Some(WatchEvent::Resync)));
        // Marker mtimes have 1 s resolution on some filesystems: write after the first scan.
        tokio::time::sleep(Duration::from_millis(2500)).await;
        std::fs::write(root.join("x y.md"), "hi").unwrap();
        until(&mut rx, |c| c.path == "x y.md" && !c.is_dir).await;
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/pkg.js"), "").unwrap();
        std::fs::remove_file(root.join("x y.md")).unwrap();
        let seen = until(&mut rx, |c| c.path.is_empty() && c.is_dir).await;
        assert!(
            seen.iter().all(|c| !c.path.starts_with("node_modules")),
            "{seen:?}"
        );
        task.abort();
    }

    #[tokio::test]
    async fn poll_follows_a_symlinked_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("real")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("link")).unwrap();
        let link = dir.path().join("link").to_string_lossy().into_owned();
        let (sink, mut rx) = collect();
        let task = tokio::spawn(async move {
            watch_poll(&LocalTransport, &link, &sink, &mut Backoff::default()).await
        });
        assert!(matches!(rx.recv().await, Some(WatchEvent::Resync)));
        tokio::time::sleep(Duration::from_millis(2500)).await;
        std::fs::write(dir.path().join("real/n.md"), "hi").unwrap();
        until(&mut rx, |c| c.path == "n.md").await;
        task.abort();
    }

    #[tokio::test]
    async fn the_poll_loop_exits_when_stdin_closes() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = spawn_stream(
            &LocalTransport,
            &crate::files::watch::poll_cmd(&dir.path().to_string_lossy()),
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(child.stdin.take());
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        assert!(status.is_ok(), "poll loop still running after stdin closed");
    }

    #[tokio::test]
    async fn local_watch_reports_created_and_removed_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let (sink, mut rx) = collect();
        let task =
            tokio::spawn(async move { watch_local(&root, &sink, &mut Backoff::default()).await });
        assert!(matches!(rx.recv().await, Some(WatchEvent::Resync)));
        let target = dir.path().join("notes.md");
        // FSEvents needs a moment to start; keep writing until an event arrives.
        let mut seen = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !seen
            .iter()
            .any(|c: &Change| c.path == "notes.md" && !c.removed)
        {
            std::fs::write(&target, "hello").unwrap();
            if let Ok(Some(WatchEvent::Changes { changes })) =
                tokio::time::timeout(Duration::from_millis(500), rx.recv()).await
            {
                seen.extend(changes);
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no create event, saw {seen:?}"
            );
        }
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/x.js"), "").unwrap();
        std::fs::remove_file(&target).unwrap();
        let seen = until(&mut rx, |c| c.path == "notes.md" && c.removed).await;
        assert!(
            seen.iter().all(|c| !c.path.starts_with("node_modules/")),
            "{seen:?}"
        );
        task.abort();
    }
}
