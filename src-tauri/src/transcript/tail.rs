//! Stream a transcript file with `tail -F` on the Machine and feed a parser.
use super::images::{ImageSink, ImageStore, IMAGE_BUDGET, PARKED_IMAGE_BUDGET};
use super::{ChatEvent, ChatItem, ChatMeta, Parser, ParserOutput};
use crate::error::AppError;
use crate::transport::Transport;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::task::JoinHandle;

const BATCH: Duration = Duration::from_millis(50);
const RESET_ITEMS: usize = 500;
/// Silence that ends the first backlog when the size header is unreadable.
const QUIET: Duration = if cfg!(test) { Duration::from_secs(1) } else { Duration::from_secs(2) };
const MAX_LINE: usize = 32 * 1024 * 1024;

pub type Sink = Arc<dyn Fn(ChatEvent) + Send + Sync>;

/// Where a tail's events go. `sink` is None while the tail is parked; `attach` leaves the
/// new sink in `pending` for the parse thread to adopt, so attaching never blocks.
struct Link {
    sink: Option<Sink>,
    pending: Option<Sink>,
}

type SharedLink = Arc<Mutex<Link>>;

/// Sends `ev` to the current sink, if any. The sink is cloned out so it runs unlocked.
fn emit(link: &SharedLink, ev: ChatEvent) {
    let sink = link.lock().unwrap().sink.clone();
    if let Some(sink) = sink {
        sink(ev);
    }
}

/// A running tail. Dropping it ends the `tail` process.
pub struct TailHandle {
    items: Arc<Mutex<Vec<ChatItem>>>,
    images: Arc<Mutex<ImageStore>>,
    link: SharedLink,
    task: JoinHandle<()>,
}

impl TailHandle {
    /// The last `limit` items whose absolute index is `< before`.
    pub fn page(&self, before: usize, limit: usize) -> Vec<ChatItem> {
        let items = self.items.lock().unwrap();
        let end = before.min(items.len());
        items[end.saturating_sub(limit)..end].to_vec()
    }

    /// Parks the tail: it keeps reading but emits nothing, and keeps fewer images.
    pub fn detach(&self) {
        {
            let mut link = self.link.lock().unwrap();
            link.sink = None;
            link.pending = None;
        }
        self.images.lock().unwrap().set_budget(PARKED_IMAGE_BUDGET);
    }

    /// Sends later events to `sink`, starting with a Reset of what the tail kept. The
    /// parse thread takes it over within a tick (50 ms).
    pub fn attach(&self, sink: Sink) {
        self.images.lock().unwrap().set_budget(IMAGE_BUDGET);
        self.link.lock().unwrap().pending = Some(sink);
    }

    /// Whether the reader task has not finished (the `tail` process is still up).
    pub fn is_running(&self) -> bool {
        !self.task.is_finished()
    }

    /// The tail's image store, shared: lock it after letting go of any other lock.
    pub fn images(&self) -> Arc<Mutex<ImageStore>> {
        self.images.clone()
    }
}

impl Drop for TailHandle {
    fn drop(&mut self) {
        // Aborting drops the future, closing the child's stdin; the wrapper then kills tail.
        self.task.abort();
    }
}

struct State {
    items: Arc<Mutex<Vec<ChatItem>>>,
    images: Arc<Mutex<ImageStore>>,
    /// The Model and Reasoning effort last sent to the sink.
    last_meta: ChatMeta,
    parser: Box<dyn Parser>,
    link: SharedLink,
    /// Events of the current batch, in order.
    events: Vec<ChatEvent>,
    /// Items appended since the last event was queued.
    appended: Vec<ChatItem>,
    sent_first: bool,
    /// The file's size when the tail started, from the header line.
    size: Option<u64>,
    /// Bytes of the stream read after the header.
    consumed: u64,
    /// When the last byte arrived; None until the first.
    last_byte: Option<Instant>,
}

/// The header line is `wc -c` output: the size, maybe space-padded.
fn parse_header(line: &[u8]) -> Option<u64> {
    std::str::from_utf8(line).ok()?.trim().parse().ok()
}

impl State {
    fn reset_event(items: &[ChatItem]) -> ChatEvent {
        ChatEvent::Reset {
            items: items[items.len().saturating_sub(RESET_ITEMS)..].to_vec(),
            total: items.len(),
        }
    }

    fn line(&mut self, line: &str) {
        // Parse into a local list so the store is locked only to put, never during a parse.
        let mut found: Vec<(String, String, Vec<u8>)> = Vec::new();
        let out = self.parser.push_line(line, &mut found);
        if !found.is_empty() {
            let mut images = self.images.lock().unwrap();
            for (r, media_type, bytes) in found {
                images.put(r, media_type, bytes);
            }
        }
        match out {
            ParserOutput::None => {}
            ParserOutput::Append(v) => {
                // Before the first Reset, `items` is all that is needed: that Reset snapshots it.
                if self.sent_first {
                    self.appended.extend(v.iter().cloned());
                }
                self.items.lock().unwrap().extend(v);
            }
            ParserOutput::Reset(v) => {
                if !self.appended.is_empty() {
                    self.events.push(ChatEvent::Append {
                        items: std::mem::take(&mut self.appended),
                    });
                }
                let mut items = self.items.lock().unwrap();
                *items = v;
                self.events.push(Self::reset_event(&items));
            }
        }
    }

    fn flush(&mut self) {
        if !self.sent_first {
            // Wait until the backlog's bytes have all been read (or, with no usable size,
            // the stream goes quiet), then send one Reset covering everything.
            let caught_up = self.size.is_some_and(|s| self.consumed >= s)
                || self.last_byte.is_some_and(|t| t.elapsed() >= QUIET);
            if !caught_up {
                return;
            }
            let ev = Self::reset_event(&self.items.lock().unwrap());
            self.events.clear();
            self.appended.clear();
            self.sent_first = true;
            emit(&self.link, ev);
            self.send_meta_if_changed();
            return;
        }
        if !self.appended.is_empty() {
            self.events.push(ChatEvent::Append {
                items: std::mem::take(&mut self.appended),
            });
        }
        for ev in self.events.drain(..) {
            emit(&self.link, ev);
        }
        self.send_meta_if_changed();
    }

    fn send_meta_if_changed(&mut self) {
        let meta = self.parser.meta();
        if meta != self.last_meta {
            self.last_meta = meta.clone();
            emit(
                &self.link,
                ChatEvent::Meta {
                    model: meta.model,
                    effort: meta.effort,
                    context_tokens: meta.context_tokens,
                },
            );
        }
    }

    /// Moves a pending sink in. What was queued for the old sink is dropped: the Reset
    /// below covers it. Before the first Reset there is nothing more to do, as that
    /// Reset goes to the new sink.
    fn adopt_pending(&mut self) {
        {
            let mut link = self.link.lock().unwrap();
            let Some(s) = link.pending.take() else { return };
            link.sink = Some(s);
        }
        self.events.clear();
        self.appended.clear();
        if self.sent_first {
            let ev = Self::reset_event(&self.items.lock().unwrap());
            emit(&self.link, ev);
            self.last_meta = ChatMeta::default();
            self.send_meta_if_changed();
        }
    }
}

pub fn spawn_tail(
    t: Arc<dyn Transport>,
    path: String,
    parser: Box<dyn Parser>,
    sink: Sink,
) -> TailHandle {
    let items: Arc<Mutex<Vec<ChatItem>>> = Arc::default();
    let images = Arc::new(Mutex::new(ImageStore::new(IMAGE_BUDGET)));
    let state = State {
        items: items.clone(),
        images: images.clone(),
        last_meta: ChatMeta::default(),
        parser,
        link: Arc::new(Mutex::new(Link { sink: Some(sink), pending: None })),
        events: Vec::new(),
        appended: Vec::new(),
        sent_first: false,
        size: None,
        consumed: 0,
        last_byte: None,
    };
    let link = state.link.clone();
    let (tx, rx) = tokio::sync::mpsc::channel(16);
    // Parsing is CPU-bound (lines reach 32 MiB), so it gets a thread of its own. It ends
    // when the reader is aborted and the channel closes.
    let spawned = std::thread::Builder::new()
        .name("chat-parse".into())
        .spawn(move || parse_loop(state, rx));
    if let Err(e) = spawned {
        emit(&link, ChatEvent::Error { error: AppError::new("io", e.to_string()) });
    }
    let task = tokio::spawn(read(t, path, link.clone(), tx));
    TailHandle {
        items,
        images,
        link,
        task,
    }
}

/// What the reader tells the parse thread.
enum Msg {
    /// The size header line, parsed.
    Header(Option<u64>),
    /// One line, without its newline.
    Line(Vec<u8>),
    /// Raw bytes read after the header, sent once the chunk's lines are.
    Bytes(usize),
    Tick,
    /// The tail's output ended.
    Eof,
}

fn parse_loop(mut st: State, mut rx: tokio::sync::mpsc::Receiver<Msg>) {
    while let Some(m) = rx.blocking_recv() {
        st.adopt_pending();
        match m {
            Msg::Header(size) => {
                st.size = size;
                st.last_byte = Some(Instant::now());
            }
            Msg::Line(mut bytes) => {
                if bytes.last() == Some(&b'\r') {
                    bytes.pop();
                }
                st.line(&String::from_utf8_lossy(&bytes));
            }
            Msg::Bytes(n) => {
                st.consumed += n as u64;
                st.last_byte = Some(Instant::now());
            }
            Msg::Tick => st.flush(),
            Msg::Eof => {
                st.flush();
                emit(
                    &st.link,
                    ChatEvent::Error {
                        error: AppError::new("io", "transcript tail exited"),
                    },
                );
                return;
            }
        }
    }
}

async fn read(
    t: Arc<dyn Transport>,
    path: String,
    link: SharedLink,
    tx: tokio::sync::mpsc::Sender<Msg>,
) {
    // The remote command ends (and kills tail) when its stdin reaches EOF, i.e. when the
    // handle drops: closing stdin is the only reliable cleanup over ssh without a tty.
    let script = r#"wc -c < "$1" 2>/dev/null || echo 0; tail -c +1 -F "$1" & p=$!; cat >/dev/null; kill $p 2>/dev/null"#;
    let argv = t.wrap(
        &["sh".into(), "-c".into(), script.into(), "sh".into(), path],
        false,
    );
    let spawned = Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            emit(&link, ChatEvent::Error { error: e.into() });
            return;
        }
    };
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let _stdin = child.stdin.take();
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + BATCH, BATCH);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut chunk = vec![0u8; 64 * 1024];
    let mut buf: Vec<u8> = Vec::new();
    let mut dropping = false;
    let mut header = true;
    loop {
        tokio::select! {
            n = stdout.read(&mut chunk) => {
                let n = match n { Ok(0) | Err(_) => break, Ok(n) => n };
                // Header bytes are not counted: they are not part of the file.
                let mut raw = 0usize;
                for part in chunk[..n].split_inclusive(|b| *b == b'\n') {
                    let complete = part.ends_with(b"\n");
                    if header {
                        buf.extend_from_slice(part.strip_suffix(b"\n").unwrap_or(part));
                        if complete {
                            let size = parse_header(&buf);
                            buf.clear();
                            header = false;
                            if tx.send(Msg::Header(size)).await.is_err() { return; }
                        }
                        continue;
                    }
                    raw += part.len();
                    if !dropping {
                        buf.extend_from_slice(part.strip_suffix(b"\n").unwrap_or(part));
                        if buf.len() > MAX_LINE {
                            dropping = true;
                            buf.clear();
                        }
                    }
                    if complete {
                        if !dropping && tx.send(Msg::Line(std::mem::take(&mut buf))).await.is_err() {
                            return;
                        }
                        dropping = false;
                        buf.clear();
                    }
                }
                // Sent even when 0, so a header still arriving starts the quiet clock.
                if tx.send(Msg::Bytes(raw)).await.is_err() { return; }
            }
            _ = tick.tick() => {
                if tx.send(Msg::Tick).await.is_err() { return; }
            }
        }
    }
    let _ = tx.send(Msg::Eof).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::images::ImageSink;
    use std::sync::{Arc, Mutex};
    struct Lines;
    impl Parser for Lines {
        fn push_line(&mut self, line: &str, _images: &mut dyn ImageSink) -> ParserOutput {
            if line == "RESET" {
                ParserOutput::Reset(vec![ChatItem::System {
                    ts: None,
                    text: "reset".into(),
                }])
            } else {
                ParserOutput::Append(vec![ChatItem::User {
                    images: vec![],
                    skills: vec![],
                    ts: None,
                    text: line.into(),
                }])
            }
        }
    }
    struct MetaLines {
        model: Option<String>,
    }
    impl Parser for MetaLines {
        fn push_line(&mut self, line: &str, images: &mut dyn ImageSink) -> ParserOutput {
            if let Some(m) = line.strip_prefix("MODEL ") {
                self.model = Some(m.into());
                return ParserOutput::None;
            }
            if let Some(r) = line.strip_prefix("IMG ") {
                images.put(r.into(), "image/png".into(), vec![7, 7]);
                return ParserOutput::None;
            }
            ParserOutput::Append(vec![ChatItem::User {
                ts: None,
                text: line.into(),
                images: vec![],
                skills: vec![],
            }])
        }
        fn meta(&self) -> crate::transcript::ChatMeta {
            crate::transcript::ChatMeta {
                model: self.model.clone(),
                ..Default::default()
            }
        }
    }

    /// Blocks inside `push_line` until released, reporting when it got there.
    struct Stuck {
        entered: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    }
    impl Parser for Stuck {
        fn push_line(&mut self, _: &str, images: &mut dyn ImageSink) -> ParserOutput {
            self.entered.send(()).unwrap();
            self.release.recv().unwrap();
            images.put("r".into(), "image/png".into(), vec![1]);
            ParserOutput::None
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_image_store_is_free_while_a_line_parses() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let (entered_tx, entered) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(Stuck { entered: entered_tx, release: release_rx }),
            Arc::new(|_| {}),
        );
        let store = h.images();
        tokio::task::spawn_blocking(move || entered.recv_timeout(std::time::Duration::from_secs(3)))
            .await.unwrap().expect("parser never ran");
        assert!(store.try_lock().is_ok(), "the store is locked during the parse");
        release.send(()).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(store.lock().unwrap().get("r"), Some(("image/png".to_string(), vec![1])));
    }

    #[tokio::test]
    async fn meta_sent_after_reset_and_on_change() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(MetaLines { model: None }),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        {
            let ev = got.lock().unwrap();
            assert_eq!(ev.len(), 1, "{ev:?}");
            assert!(matches!(ev[0], ChatEvent::Reset { .. }));
        }
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        writeln!(f, "MODEL m1\nb\nIMG r1").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        writeln!(f, "c").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let ev = got.lock().unwrap();
        let metas: Vec<_> = ev
            .iter()
            .filter_map(|e| match e {
                ChatEvent::Meta { model, .. } => Some(model.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(metas, vec![Some("m1".to_string())]);
        let store = h.images();
        assert_eq!(
            store.lock().unwrap().get("r1"),
            Some(("image/png".to_string(), vec![7, 7]))
        );
        assert_eq!(store.lock().unwrap().get("nope"), None);
        drop(ev);
        drop(h);
    }

    #[tokio::test]
    async fn meta_known_at_open_follows_the_reset() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "MODEL m0\na\n").unwrap();
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let _h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(MetaLines { model: None }),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(ev[0], ChatEvent::Reset { .. }));
        assert!(matches!(&ev[1], ChatEvent::Meta { model: Some(m), .. } if m == "m0"));
    }

    #[tokio::test]
    async fn streams_reset_then_appends() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nb\n").unwrap();
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(Lines),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"c\nRESET\n").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { items, total: 2 } if items.len() == 2));
        assert!(ev.iter().any(|e| matches!(e, ChatEvent::Append { items } if items == &vec![ChatItem::User { ts: None, text: "c".into(), images: vec![], skills: vec![] }])));
        assert!(matches!(ev.last().unwrap(), ChatEvent::Reset { items, .. } if items.len() == 1));
        drop(ev);
        drop(h);
    }
    #[tokio::test]
    async fn invalid_utf8_lines_do_not_stop_the_stream() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, b"a\n\xff\xfe\xfd\nb\n").unwrap();
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let _h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(Lines),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(
            matches!(&got.lock().unwrap()[0], ChatEvent::Reset { items, total: 3 } if items[0] == ChatItem::User { ts: None, text: "a".into(), images: vec![], skills: vec![] } && items[2] == ChatItem::User { ts: None, text: "b".into(), images: vec![], skills: vec![] })
        );
    }
    #[tokio::test]
    async fn empty_and_missing_files_still_reset() {
        let d = tempfile::tempdir().unwrap();
        for name in ["empty.jsonl", "missing.jsonl"] {
            let p = d.path().join(name);
            if name == "empty.jsonl" {
                std::fs::write(&p, "").unwrap();
            }
            let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
            let g = got.clone();
            let _h = spawn_tail(
                Arc::new(crate::transport::local::LocalTransport),
                p.to_string_lossy().into(),
                Box::new(Lines),
                Arc::new(move |e| g.lock().unwrap().push(e)),
            );
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
            assert!(
                matches!(&got.lock().unwrap()[0], ChatEvent::Reset { items, total: 0 } if items.is_empty()),
                "{name}"
            );
        }
    }
    fn tail_running(path: &str) -> bool {
        std::process::Command::new("pgrep")
            .args(["-f", "--", &format!("-F {path}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[tokio::test]
    async fn dropping_the_handle_ends_tail() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("drop-me.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let path: String = p.to_string_lossy().into();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            path.clone(),
            Box::new(Lines),
            Arc::new(|_| {}),
        );
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(tail_running(&path), "tail should be running");
        drop(h);
        for _ in 0..40 {
            if !tail_running(&path) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("tail still running after drop");
    }
    #[tokio::test]
    async fn pages_older_items() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, (0..700).map(|i| format!("m{i}\n")).collect::<String>()).unwrap();
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = spawn_tail(
            Arc::new(crate::transport::local::LocalTransport),
            p.to_string_lossy().into(),
            Box::new(Lines),
            Arc::new(move |e| g.lock().unwrap().push(e)),
        );
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        assert!(
            matches!(&got.lock().unwrap()[0], ChatEvent::Reset { items, total: 700 } if items.len() == 500 && items[0] == ChatItem::User { ts: None, text: "m200".into(), images: vec![], skills: vec![] })
        );
        let older = h.page(200, 200);
        assert_eq!(older.len(), 200);
        assert_eq!(
            older[0],
            ChatItem::User {
                images: vec![],
                skills: vec![],
                ts: None,
                text: "m0".into()
            }
        );
    }

    /// Starts the command only after `delay`, like a slow ssh: nothing arrives at first.
    struct Slow(&'static str);
    #[async_trait::async_trait]
    impl crate::transport::Transport for Slow {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let mut v: Vec<String> = vec!["sh".into(), "-c".into(), format!("sleep {}; exec \"$@\"", self.0), "sh".into()];
            v.extend(argv.iter().cloned());
            v
        }
        async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
        async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
    }
    /// Prints a junk first line before the command: the size header is unreadable.
    struct Junk;
    #[async_trait::async_trait]
    impl crate::transport::Transport for Junk {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let mut v: Vec<String> = vec!["sh".into(), "-c".into(), "echo ' junk'; exec \"$@\"".into(), "sh".into()];
            v.extend(argv.iter().cloned());
            v
        }
        async fn local_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<std::path::PathBuf> { unreachable!() }
        async fn release_socket(&self, _: &crate::transport::SessionEntry) -> crate::error::AppResult<()> { unreachable!() }
    }
    fn collect(t: Arc<dyn crate::transport::Transport>, p: &std::path::Path) -> (TailHandle, Arc<Mutex<Vec<ChatEvent>>>) {
        let got: Arc<Mutex<Vec<ChatEvent>>> = Arc::default();
        let g = got.clone();
        let h = spawn_tail(t, p.to_string_lossy().into(), Box::new(Lines), Arc::new(move |e| g.lock().unwrap().push(e)));
        (h, got)
    }

    fn state(parser: Box<dyn Parser>) -> State {
        State {
            items: Arc::default(),
            images: Arc::new(Mutex::new(ImageStore::new(IMAGE_BUDGET))),
            last_meta: ChatMeta::default(),
            parser,
            link: Arc::new(Mutex::new(Link { sink: None, pending: None })),
            events: Vec::new(),
            appended: Vec::new(),
            sent_first: false,
            size: None,
            consumed: 0,
            last_byte: None,
        }
    }

    #[test]
    fn the_backlog_is_not_queued_twice_before_the_first_reset() {
        let mut st = state(Box::new(Lines));
        st.line("a");
        st.line("b");
        assert_eq!(st.items.lock().unwrap().len(), 2);
        assert!(st.appended.is_empty(), "the first Reset already carries the backlog");
        st.sent_first = true;
        st.line("c");
        assert_eq!(st.appended.len(), 1);
    }

    #[test]
    fn reads_the_size_header() {
        assert_eq!(parse_header(b"   1234"), Some(1234));
        assert_eq!(parse_header(b"0"), Some(0));
        assert_eq!(parse_header(b" junk"), None);
    }

    #[tokio::test]
    async fn a_slow_start_still_sends_the_whole_backlog_as_one_reset() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, (0..50).map(|i| format!("m{i}\n")).collect::<String>()).unwrap();
        // Slower than QUIET (1 s in tests): the quiet clock must not run before the first byte.
        let (_h, got) = collect(Arc::new(Slow("1.3")), &p);
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
        let ev = got.lock().unwrap();
        assert!(matches!(&ev[0], ChatEvent::Reset { total: 50, .. }), "{ev:?}");
        assert!(!ev.iter().any(|e| matches!(e, ChatEvent::Append { .. })), "{ev:?}");
    }

    #[tokio::test]
    async fn a_last_line_without_newline_follows_the_reset() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\nb").unwrap();
        let (_h, got) = collect(Arc::new(crate::transport::local::LocalTransport), &p);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(matches!(&got.lock().unwrap()[0], ChatEvent::Reset { total: 1, .. }));
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(b"\n").unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let ev = got.lock().unwrap();
        assert!(ev.iter().any(|e| matches!(e, ChatEvent::Append { items } if items.len() == 1)), "{ev:?}");
    }

    #[tokio::test]
    async fn an_unreadable_header_falls_back_to_quiet() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "a\n").unwrap();
        let (_h, got) = collect(Arc::new(Junk), &p);
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        assert!(got.lock().unwrap().is_empty(), "sent before QUIET");
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        // The real size line becomes an item: only the quiet rule could have sent this Reset.
        assert!(matches!(&got.lock().unwrap()[0], ChatEvent::Reset { total: 2, .. }));
    }
}
