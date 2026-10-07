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

/// The one live Files watch: starting a watch replaces the running one.
#[derive(Default)]
pub struct FilesWatch {
    current: std::sync::Mutex<Option<(u64, tokio::task::JoinHandle<()>)>>,
    last_id: std::sync::atomic::AtomicU64,
}

impl FilesWatch {
    /// Abort the running watch and start one on `root`; the returned id is for `stop`.
    pub fn start(&self, t: Arc<dyn Transport>, local: bool, root: String, sink: WatchSink) -> u64 {
        let id = self.last_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut current = self.current.lock().unwrap();
        if let Some((_, old)) = current.take() {
            old.abort();
        }
        *current = Some((id, tokio::spawn(run_watch(t, local, root, sink))));
        id
    }

    /// Abort the watch, unless a newer one has replaced the one `id` names.
    pub fn stop(&self, id: u64) {
        let mut current = self.current.lock().unwrap();
        if current.as_ref().is_some_and(|(cur, _)| *cur == id) {
            if let Some((_, task)) = current.take() {
                task.abort();
            }
        }
    }

    /// Whether a current watch is held (set by `start`, cleared by `stop` of its id).
    pub fn is_running(&self) -> bool {
        self.current.lock().unwrap().is_some()
    }
}

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
                // Only a definite yes/no is cached: an unreachable Machine is probed again.
                match probe_inotify(&*t).await {
                    Ok(found) => has_inotify = Some(found),
                    Err(e) => {
                        sink(WatchEvent::Error { message: e.message });
                        pause(&mut backoff).await;
                        continue;
                    }
                }
            }
            if has_inotify == Some(true) && !poll_only {
                inotify = true;
                watch_inotify(&*t, &root, &tracked, &mut backoff).await
            } else {
                watch_poll(&*t, &root, &tracked, &mut backoff).await
            }
        };
        // Only consecutive inotify sessions that failed without an event count.
        if inotify {
            if got_event.load(Ordering::Relaxed) {
                silent_failures = 0;
            } else if result.is_err() {
                silent_failures += 1;
                if silent_failures >= INOTIFY_FAILURES {
                    poll_only = true;
                }
            }
        }
        if let Err(e) = result {
            sink(WatchEvent::Error { message: e.message });
            pause(&mut backoff).await;
        }
    }
}

/// Backoff sleep; tests do not wait.
async fn pause(backoff: &mut Backoff) {
    let delay = backoff.next_delay();
    if !cfg!(test) {
        tokio::time::sleep(delay).await;
    }
}

/// Whether the Machine has `inotifywait`; an error when the answer is not a definite yes/no
/// (e.g. ssh could not connect).
async fn probe_inotify(t: &dyn Transport) -> AppResult<bool> {
    let script = "command -v inotifywait >/dev/null 2>&1 && echo yes || echo no";
    let out = exec(t, &["sh".into(), "-c".into(), script.into()]).await?;
    match out.stdout.trim() {
        "yes" => Ok(true),
        "no" => Ok(false),
        _ => Err(AppError::new("io", exit_message(&out.stderr))),
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
            Some(Ok(None)) => {
                // Events read just before the session ended still count.
                if !batch.is_empty() {
                    sink(WatchEvent::Changes {
                        changes: dedupe(std::mem::take(&mut batch)),
                    });
                }
                return Err(ended(&mut child).await);
            }
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

    /// A Machine whose probe, inotify sessions and poll sessions are canned `sh` commands,
    /// counting how often each started.
    #[derive(Default)]
    struct Fake {
        probes: std::sync::atomic::AtomicUsize,
        inotify: std::sync::atomic::AtomicUsize,
        poll: std::sync::atomic::AtomicUsize,
        /// The first probe fails like an unreachable ssh.
        first_probe_fails: bool,
        /// Every n-th inotify session (1-based) delivers an event before ending.
        event_every: Option<usize>,
        /// Inotify sessions stay up instead of failing, so the run never moves on.
        hold_inotify: bool,
    }

    #[async_trait::async_trait]
    impl crate::transport::Transport for Fake {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            use std::sync::atomic::Ordering::SeqCst;
            let script = if argv[2].contains("command -v") {
                if self.probes.fetch_add(1, SeqCst) == 0 && self.first_probe_fails {
                    "echo 'ssh: connect failed' >&2; exit 255"
                } else {
                    "echo yes"
                }
            } else if argv[2].contains("inotifywait") {
                let n = self.inotify.fetch_add(1, SeqCst) + 1;
                if self.hold_inotify {
                    "sleep 30"
                } else if self.event_every.is_some_and(|k| n % k == 0) {
                    "echo 'CLOSE_WRITE,CLOSE|/r/a.md'; echo 'no space' >&2; exit 1"
                } else {
                    "echo 'no space' >&2; exit 1"
                }
            } else {
                self.poll.fetch_add(1, SeqCst);
                "sleep 30"
            };
            vec!["sh".into(), "-c".into(), script.into()]
        }
        async fn local_socket(
            &self,
            _: &crate::transport::SessionEntry,
        ) -> crate::error::AppResult<std::path::PathBuf> {
            unimplemented!()
        }
        async fn release_socket(
            &self,
            _: &crate::transport::SessionEntry,
        ) -> crate::error::AppResult<()> {
            unimplemented!()
        }
    }

    /// Run `run_watch` on `fake` until `done` holds (failing after 15 s); the events seen so far.
    async fn run_until(fake: Arc<Fake>, done: impl Fn(&Fake) -> bool) -> Vec<WatchEvent> {
        let (sink, mut rx) = collect();
        let t: Arc<dyn crate::transport::Transport> = fake.clone();
        let task = tokio::spawn(run_watch(t, false, "/r".into(), sink));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !done(&fake) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "condition never met"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        task.abort();
        let mut seen = Vec::new();
        while let Ok(e) = rx.try_recv() {
            seen.push(e);
        }
        seen
    }

    #[tokio::test]
    async fn three_silent_inotify_failures_switch_to_poll() {
        use std::sync::atomic::Ordering::SeqCst;
        let fake = Arc::new(Fake::default());
        let seen = run_until(fake.clone(), |f| f.poll.load(SeqCst) >= 1).await;
        assert_eq!(fake.inotify.load(SeqCst), 3);
        assert_eq!(fake.probes.load(SeqCst), 1);
        let errors = seen
            .iter()
            .filter(|e| matches!(e, WatchEvent::Error { .. }))
            .count();
        assert_eq!(errors, 3, "{seen:?}");
    }

    #[tokio::test]
    async fn inotify_sessions_with_events_in_between_do_not_switch_to_poll() {
        use std::sync::atomic::Ordering::SeqCst;
        let fake = Arc::new(Fake {
            event_every: Some(3),
            ..Default::default()
        });
        run_until(fake.clone(), |f| f.inotify.load(SeqCst) >= 12).await;
        assert_eq!(fake.poll.load(SeqCst), 0);
    }

    #[tokio::test]
    async fn a_failed_probe_is_retried_not_cached_as_absent() {
        use std::sync::atomic::Ordering::SeqCst;
        let fake = Arc::new(Fake {
            first_probe_fails: true,
            hold_inotify: true,
            ..Default::default()
        });
        let seen = run_until(fake.clone(), |f| f.inotify.load(SeqCst) >= 1).await;
        assert_eq!(fake.probes.load(SeqCst), 2);
        assert_eq!(fake.poll.load(SeqCst), 0);
        assert!(
            matches!(seen.first(), Some(WatchEvent::Error { message }) if message == "ssh: connect failed"),
            "{seen:?}"
        );
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

    #[tokio::test]
    async fn a_stale_stop_leaves_the_newer_watch_running() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let w = FilesWatch::default();
        let (sink, _rx) = collect();
        let first = w.start(Arc::new(LocalTransport), true, root.clone(), sink.clone());
        let second = w.start(Arc::new(LocalTransport), true, root, sink);
        assert!(second > first);
        w.stop(first);
        assert!(w.is_running());
        w.stop(second);
        assert!(!w.is_running());
    }
}
