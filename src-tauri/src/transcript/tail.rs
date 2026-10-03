//! Stream a transcript file with `tail -F` on the Machine and feed a parser.
use super::images::{ImageStore, IMAGE_BUDGET};
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
const INITIAL_CAP: Duration = Duration::from_millis(300);
const MAX_LINE: usize = 32 * 1024 * 1024;

type Sink = Arc<dyn Fn(ChatEvent) + Send + Sync>;

/// A running tail. Dropping it ends the `tail` process.
pub struct TailHandle {
    items: Arc<Mutex<Vec<ChatItem>>>,
    images: Arc<Mutex<ImageStore>>,
    task: JoinHandle<()>,
}

impl TailHandle {
    /// The last `limit` items whose absolute index is `< before`.
    pub fn page(&self, before: usize, limit: usize) -> Vec<ChatItem> {
        let items = self.items.lock().unwrap();
        let end = before.min(items.len());
        items[end.saturating_sub(limit)..end].to_vec()
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
    sink: Sink,
    /// Events of the current batch, in order.
    events: Vec<ChatEvent>,
    /// Items appended since the last event was queued.
    appended: Vec<ChatItem>,
    sent_first: bool,
    /// Bytes arrived since the previous tick.
    got_bytes: bool,
    ever_got_bytes: bool,
    started: Instant,
}

impl State {
    fn reset_event(items: &[ChatItem]) -> ChatEvent {
        ChatEvent::Reset {
            items: items[items.len().saturating_sub(RESET_ITEMS)..].to_vec(),
            total: items.len(),
        }
    }

    fn line(&mut self, line: &str) {
        let out = {
            let mut images = self.images.lock().unwrap();
            self.parser.push_line(line, &mut *images)
        };
        match out {
            ParserOutput::None => {}
            ParserOutput::Append(v) => {
                self.items.lock().unwrap().extend(v.iter().cloned());
                self.appended.extend(v);
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
        let got = std::mem::take(&mut self.got_bytes);
        if !self.sent_first {
            // Wait until the backlog has been read (a quiet interval after data) or the cap
            // passes (empty or missing file), then send one Reset covering everything.
            let caught_up = (self.ever_got_bytes && !got) || self.started.elapsed() >= INITIAL_CAP;
            if !caught_up {
                return;
            }
            let ev = Self::reset_event(&self.items.lock().unwrap());
            self.events.clear();
            self.appended.clear();
            self.sent_first = true;
            (self.sink)(ev);
            self.send_meta_if_changed();
            return;
        }
        if !self.appended.is_empty() {
            self.events.push(ChatEvent::Append {
                items: std::mem::take(&mut self.appended),
            });
        }
        for ev in self.events.drain(..) {
            (self.sink)(ev);
        }
        self.send_meta_if_changed();
    }

    fn send_meta_if_changed(&mut self) {
        let meta = self.parser.meta();
        if meta != self.last_meta {
            self.last_meta = meta.clone();
            (self.sink)(ChatEvent::Meta {
                model: meta.model,
                effort: meta.effort,
                context_tokens: meta.context_tokens,
            });
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
        sink,
        events: Vec::new(),
        appended: Vec::new(),
        sent_first: false,
        got_bytes: false,
        ever_got_bytes: false,
        started: Instant::now(),
    };
    let task = tokio::spawn(run(t, path, state));
    TailHandle {
        items,
        images,
        task,
    }
}

async fn run(t: Arc<dyn Transport>, path: String, mut st: State) {
    // The remote command ends (and kills tail) when its stdin reaches EOF, i.e. when the
    // handle drops: closing stdin is the only reliable cleanup over ssh without a tty.
    let script = r#"tail -n +1 -F "$1" & p=$!; cat >/dev/null; kill $p 2>/dev/null"#;
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
            (st.sink)(ChatEvent::Error { error: e.into() });
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
    loop {
        tokio::select! {
            n = stdout.read(&mut chunk) => {
                let n = match n { Ok(0) | Err(_) => break, Ok(n) => n };
                st.got_bytes = true;
                st.ever_got_bytes = true;
                for part in chunk[..n].split_inclusive(|b| *b == b'\n') {
                    let complete = part.ends_with(b"\n");
                    if !dropping {
                        buf.extend_from_slice(part.strip_suffix(b"\n").unwrap_or(part));
                        if buf.len() > MAX_LINE {
                            dropping = true;
                            buf.clear();
                        }
                    }
                    if complete {
                        if !dropping {
                            let mut bytes = std::mem::take(&mut buf);
                            if bytes.last() == Some(&b'\r') { bytes.pop(); }
                            st.line(&String::from_utf8_lossy(&bytes));
                        }
                        dropping = false;
                        buf.clear();
                    }
                }
            }
            _ = tick.tick() => st.flush(),
        }
    }
    st.flush();
    (st.sink)(ChatEvent::Error {
        error: AppError::new("io", "transcript tail exited"),
    });
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
}
