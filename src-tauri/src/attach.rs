//! Terminal attach manager: one PTY-backed `herdr terminal attach` child per Terminal,
//! with ack-based flow control, held-attach detection and idle detach.
use crate::error::{AppError, AppResult};
use crate::transport::{herdr_argv, MachineInfo};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const READ_CHUNK: usize = 64 * 1024;
const HIGH_WATER: usize = 1 << 20;
const LOW_WATER: usize = 512 * 1024;
const WRITE_CHUNK: usize = 16 * 1024;
const HELD_SCAN: usize = 4096;
const HELD_MARKER: &[u8] = b"already has an attached client";
/// How long the exit watcher waits for the reader to drain trailing output.
const DRAIN_GRACE: Duration = Duration::from_millis(250);
/// `Attached` waits this long after the first byte so a refusal message (which follows
/// terminal-reset escape sequences) can still be recognised as `Held`.
const ATTACH_SETTLE: Duration = Duration::from_millis(400);

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AttachKey {
    pub machine_id: String,
    pub session: String,
    pub terminal_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AttachEvent {
    Attached,
    Held,
    Exited { code: Option<i32> },
    Detached,
}

pub trait Sink: Send + Sync {
    fn data(&self, bytes: Vec<u8>);
    fn event(&self, e: AttachEvent);
}

/// `herdr [--session S] terminal attach [--takeover] <terminal_id>`.
pub fn attach_argv(info: &MachineInfo, session: &str, terminal_id: &str, takeover: bool) -> Vec<String> {
    let mut args = vec!["terminal", "attach"];
    if takeover {
        args.push("--takeover");
    }
    args.push(terminal_id);
    herdr_argv(info, session, &args)
}

type Entries = Arc<Mutex<HashMap<AttachKey, Arc<Entry>>>>;

struct Entry {
    key: AttachKey,
    sink: Mutex<Arc<dyn Sink>>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Bytes forwarded to the sink and not yet acknowledged.
    unacked: Mutex<usize>,
    resume: Condvar,
    /// Set once by whoever ends the attach (detach or child exit).
    closed: AtomicBool,
    held: AtomicBool,
    /// `Attached` has been emitted (at most once per child).
    attached: AtomicBool,
    /// Bumped by `open`/`release` so a stale idle timer does nothing.
    generation: AtomicU64,
    handle: Option<tokio::runtime::Handle>,
}

impl Entry {
    fn sink(&self) -> Arc<dyn Sink> {
        self.sink.lock().unwrap().clone()
    }
    /// Emit `Attached` once, unless the attach was refused or has ended.
    fn emit_attached(&self) {
        if !self.held.load(Ordering::SeqCst) && !self.closed.load(Ordering::SeqCst) && !self.attached.swap(true, Ordering::SeqCst) {
            self.sink().event(AttachEvent::Attached);
        }
    }
    fn wake_reader(&self) {
        // Take the lock so a reader between its check and its wait cannot miss the wakeup.
        let _g = self.unacked.lock().unwrap();
        self.resume.notify_all();
    }
}

pub struct AttachManager {
    idle: Duration,
    entries: Entries,
}

impl AttachManager {
    pub fn new(idle: Duration) -> Arc<Self> {
        Arc::new(Self { idle, entries: Arc::new(Mutex::new(HashMap::new())) })
    }

    fn get(&self, key: &AttachKey) -> AppResult<Arc<Entry>> {
        self.entries
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| AppError::new("not_found", format!("terminal {} is not attached", key.terminal_id)))
    }

    /// Spawn `argv` verbatim on a PTY, or reuse the live attach for `key`.
    pub fn open(&self, key: AttachKey, argv: Vec<String>, cols: u16, rows: u16, sink: Arc<dyn Sink>) -> AppResult<()> {
        // Held across check + spawn + insert so concurrent opens of one key cannot both spawn.
        let mut map = self.entries.lock().unwrap();
        if let Some(e) = map.get(&key).cloned() {
            if e.held.load(Ordering::SeqCst) || e.closed.load(Ordering::SeqCst) {
                // Refused or ending: the old child is useless, respawn with the new argv.
                map.remove(&key);
                retire(&e);
            } else {
                *e.sink.lock().unwrap() = sink.clone();
                e.generation.fetch_add(1, Ordering::SeqCst);
                // Output sent to the previous (gone) sink was never acked; start fresh.
                *e.unacked.lock().unwrap() = 0;
                e.resume.notify_all();
                if let Some(m) = e.master.lock().unwrap().as_ref() {
                    let _ = m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                }
                // Not yet attached: the settle thread will announce it to the new sink.
                if e.attached.load(Ordering::SeqCst) {
                    sink.event(AttachEvent::Attached);
                }
                return Ok(());
            }
        }
        let program = argv.first().ok_or_else(|| AppError::new("invalid", "empty command"))?;
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::new("io", e.to_string()))?;
        let mut cmd = CommandBuilder::new(program);
        cmd.args(&argv[1..]);
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| AppError::new("io", e.to_string()))?;
        drop(pair.slave);
        let io = pair
            .master
            .try_clone_reader()
            .and_then(|r| pair.master.take_writer().map(|w| (r, w)))
            .map_err(|e| AppError::new("io", e.to_string()));
        let (reader, writer) = match io {
            Ok(rw) => rw,
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        };
        let entry = Arc::new(Entry {
            key: key.clone(),
            sink: Mutex::new(sink),
            writer: Mutex::new(writer),
            master: Mutex::new(Some(pair.master)),
            killer: Mutex::new(child.clone_killer()),
            unacked: Mutex::new(0),
            resume: Condvar::new(),
            closed: AtomicBool::new(false),
            held: AtomicBool::new(false),
            attached: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            handle: tokio::runtime::Handle::try_current().ok(),
        });
        map.insert(key, entry.clone());
        drop(map);

        let (done_tx, done_rx) = mpsc::channel::<()>();
        let e = entry.clone();
        std::thread::spawn(move || {
            read_loop(&e, reader);
            let _ = done_tx.send(());
        });
        // Exit is detected by waiting on the child, not on reader EOF: a forked
        // descendant (`ssh -f`) can keep the PTY slave open indefinitely.
        let e = entry;
        let entries = self.entries.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            let _ = done_rx.recv_timeout(DRAIN_GRACE);
            if !e.closed.swap(true, Ordering::SeqCst) {
                remove_if_same(&entries, &e);
                if !e.held.load(Ordering::SeqCst) {
                    if !e.attached.swap(true, Ordering::SeqCst) {
                        e.sink().event(AttachEvent::Attached);
                    }
                    e.sink().event(AttachEvent::Exited { code });
                }
            }
            e.master.lock().unwrap().take();
            e.wake_reader();
        });
        Ok(())
    }

    pub fn write(&self, key: &AttachKey, data: &[u8]) -> AppResult<()> {
        let e = self.get(key)?;
        let mut w = e.writer.lock().unwrap();
        for chunk in data.chunks(WRITE_CHUNK) {
            w.write_all(chunk)?;
        }
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, key: &AttachKey, cols: u16, rows: u16) -> AppResult<()> {
        let e = self.get(key)?;
        let master = e.master.lock().unwrap();
        let m = master.as_ref().ok_or_else(|| AppError::new("not_found", "terminal has exited"))?;
        m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::new("io", e.to_string()))
    }

    pub fn ack(&self, key: &AttachKey, bytes: usize) {
        if let Ok(e) = self.get(key) {
            let mut n = e.unacked.lock().unwrap();
            *n = n.saturating_sub(bytes);
            e.resume.notify_all();
        }
    }

    /// Detach after the idle period unless the key is reopened meanwhile.
    pub fn release(&self, key: &AttachKey) {
        let Ok(e) = self.get(key) else { return };
        let generation = e.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let entries = self.entries.clone();
        let idle = self.idle;
        let fire = move |e: Arc<Entry>| {
            if e.generation.load(Ordering::SeqCst) == generation {
                detach(&entries, &e);
            }
        };
        match tokio::runtime::Handle::try_current().ok().or_else(|| e.handle.clone()) {
            Some(h) => {
                h.spawn(async move {
                    tokio::time::sleep(idle).await;
                    fire(e);
                });
            }
            None => {
                std::thread::spawn(move || {
                    std::thread::sleep(idle);
                    fire(e);
                });
            }
        }
    }

    pub fn close(&self, key: &AttachKey) {
        if let Ok(e) = self.get(key) {
            detach(&self.entries, &e);
        }
    }

    pub fn close_machine(&self, machine_id: &str) {
        let list: Vec<Arc<Entry>> =
            self.entries.lock().unwrap().values().filter(|e| e.key.machine_id == machine_id).cloned().collect();
        for e in list {
            detach(&self.entries, &e);
        }
    }
}

fn remove_if_same(entries: &Entries, e: &Arc<Entry>) {
    let mut map = entries.lock().unwrap();
    if map.get(&e.key).is_some_and(|cur| Arc::ptr_eq(cur, e)) {
        map.remove(&e.key);
    }
}

/// End an entry that is already out of the map, without emitting events.
fn retire(e: &Arc<Entry>) {
    e.closed.store(true, Ordering::SeqCst);
    let _ = e.killer.lock().unwrap().kill();
    e.master.lock().unwrap().take();
    e.wake_reader();
}

fn detach(entries: &Entries, e: &Arc<Entry>) {
    if e.closed.swap(true, Ordering::SeqCst) {
        return;
    }
    remove_if_same(entries, e);
    let _ = e.killer.lock().unwrap().kill();
    e.sink().event(AttachEvent::Detached);
    e.master.lock().unwrap().take();
    e.wake_reader();
}

fn read_loop(e: &Arc<Entry>, mut reader: Box<dyn Read + Send>) {
    let mut buf = vec![0u8; READ_CHUNK];
    let mut head: Vec<u8> = Vec::new();
    let mut first = true;
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        if e.closed.load(Ordering::SeqCst) {
            return;
        }
        let sink = e.sink();
        if head.len() < HELD_SCAN {
            head.extend_from_slice(&buf[..n.min(HELD_SCAN - head.len())]);
            if !e.held.load(Ordering::SeqCst) && head.windows(HELD_MARKER.len()).any(|w| w == HELD_MARKER) {
                e.held.store(true, Ordering::SeqCst);
                sink.event(AttachEvent::Held);
            }
        }
        if first {
            first = false;
            let e = e.clone();
            std::thread::spawn(move || {
                std::thread::sleep(ATTACH_SETTLE);
                e.emit_attached();
            });
        } else if head.len() >= HELD_SCAN {
            e.emit_attached();
        }
        sink.data(buf[..n].to_vec());
        let mut unacked = e.unacked.lock().unwrap();
        *unacked += n;
        if *unacked > HIGH_WATER {
            while *unacked >= LOW_WATER && !e.closed.load(Ordering::SeqCst) {
                unacked = e.resume.wait(unacked).unwrap();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    #[derive(Default)]
    struct Rec { bytes: Mutex<Vec<u8>>, events: Mutex<Vec<AttachEvent>> }
    impl Sink for Rec {
        fn data(&self, b: Vec<u8>) { self.bytes.lock().unwrap().extend(b) }
        fn event(&self, e: AttachEvent) { self.events.lock().unwrap().push(e) }
    }
    fn key(t: &str) -> AttachKey { AttachKey { machine_id: "local".into(), session: "default".into(), terminal_id: t.into() } }
    fn sh(cmd: &str) -> Vec<String> { vec!["sh".into(), "-c".into(), cmd.into()] }
    async fn wait_for(cond: impl Fn() -> bool) { for _ in 0..100 { if cond() { return; } tokio::time::sleep(Duration::from_millis(30)).await; } panic!("timed out"); }

    #[tokio::test]
    async fn echoes_input_and_reports_exit() {
        let m = AttachManager::new(Duration::from_millis(200));
        let rec = Arc::new(Rec::default());
        m.open(key("a"), sh("read l; echo got:$l; exit 3"), 80, 24, rec.clone()).unwrap();
        m.write(&key("a"), b"hello\n").unwrap();
        wait_for(|| rec.events.lock().unwrap().iter().any(|e| matches!(e, AttachEvent::Exited { .. }))).await;
        assert!(String::from_utf8_lossy(&rec.bytes.lock().unwrap()).contains("got:hello"));
        assert!(rec.events.lock().unwrap().contains(&AttachEvent::Attached));
        assert!(rec.events.lock().unwrap().contains(&AttachEvent::Exited { code: Some(3) }));
    }
    #[tokio::test]
    async fn detects_held_attach() {
        let m = AttachManager::new(Duration::from_millis(200));
        let rec = Arc::new(Rec::default());
        m.open(key("b"), sh("echo 'herdr: server shut down: terminal attach failed: terminal term_b already has an attached client; retry with --takeover'; exit 1"), 80, 24, rec.clone()).unwrap();
        wait_for(|| rec.events.lock().unwrap().contains(&AttachEvent::Held)).await;
        assert!(!rec.events.lock().unwrap().contains(&AttachEvent::Attached));
    }
    #[tokio::test]
    async fn reader_pauses_without_acks() {
        let m = AttachManager::new(Duration::from_secs(5));
        let rec = Arc::new(Rec::default());
        m.open(key("c"), sh("yes 0123456789abcdef | head -c 8000000"), 80, 24, rec.clone()).unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        let got = rec.bytes.lock().unwrap().len();
        assert!(got <= (1 << 20) + 65536, "read {got} bytes without acks");
        m.ack(&key("c"), got);
        wait_for(|| rec.bytes.lock().unwrap().len() > got).await;
        m.close(&key("c"));
    }
    #[tokio::test]
    async fn release_detaches_after_idle_unless_reopened() {
        let m = AttachManager::new(Duration::from_millis(200));
        let rec = Arc::new(Rec::default());
        m.open(key("d"), sh("sleep 30"), 80, 24, rec.clone()).unwrap();
        m.release(&key("d"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        m.open(key("d"), sh("sleep 30"), 100, 30, rec.clone()).unwrap(); // reuse, no second process
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!rec.events.lock().unwrap().contains(&AttachEvent::Detached));
        m.release(&key("d"));
        wait_for(|| rec.events.lock().unwrap().contains(&AttachEvent::Detached)).await;
    }
    #[tokio::test]
    async fn reopen_after_unacked_backlog_still_delivers() {
        let m = AttachManager::new(Duration::from_secs(5));
        let old = Arc::new(Rec::default());
        m.open(key("e"), sh("yes 0123456789abcdef | head -c 8000000"), 80, 24, old.clone()).unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(old.bytes.lock().unwrap().len() > (1 << 20));
        m.release(&key("e"));
        let new = Arc::new(Rec::default());
        m.open(key("e"), sh("sleep 30"), 80, 24, new.clone()).unwrap();
        wait_for(|| !new.bytes.lock().unwrap().is_empty()).await;
        m.close(&key("e"));
    }
    #[tokio::test]
    async fn reopen_of_held_key_respawns_with_new_argv() {
        let m = AttachManager::new(Duration::from_secs(5));
        let old = Arc::new(Rec::default());
        m.open(key("f"), sh("echo 'already has an attached client'; sleep 2"), 80, 24, old.clone()).unwrap();
        wait_for(|| old.events.lock().unwrap().contains(&AttachEvent::Held)).await;
        let new = Arc::new(Rec::default());
        m.open(key("f"), sh("echo fresh; sleep 5"), 80, 24, new.clone()).unwrap();
        wait_for(|| String::from_utf8_lossy(&new.bytes.lock().unwrap()).contains("fresh")).await;
        wait_for(|| new.events.lock().unwrap().contains(&AttachEvent::Attached)).await;
        assert!(!new.events.lock().unwrap().contains(&AttachEvent::Held));
        m.close(&key("f"));
    }
    #[tokio::test]
    async fn close_while_reader_paused_detaches() {
        let m = AttachManager::new(Duration::from_secs(5));
        let rec = Arc::new(Rec::default());
        m.open(key("g"), sh("yes 0123456789abcdef | head -c 8000000"), 80, 24, rec.clone()).unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        m.close(&key("g"));
        wait_for(|| rec.events.lock().unwrap().contains(&AttachEvent::Detached)).await;
    }
    #[test]
    fn builds_attach_argv() {
        let info = crate::transport::MachineInfo { home: "/h".into(), herdr: "/h/herdr".into(), pi_dir: "/p".into(), version: "0.9.3".into(), protocol: 22 };
        assert_eq!(attach_argv(&info, "ai", "term_x", true), vec!["/h/herdr", "--session", "ai", "terminal", "attach", "--takeover", "term_x"]);
        assert_eq!(attach_argv(&info, "default", "term_x", false), vec!["/h/herdr", "terminal", "attach", "term_x"]);
    }
}
