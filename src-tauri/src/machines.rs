//! Machine manager: owns Machines, their Sessions and watchers, and the UI event stream.
use crate::{
    error::{AppError, AppResult},
    herdr::{
        rpc,
        types::AgentStatus,
        watcher::{spawn_watcher, WatchEvent},
    },
    transport::{exec, herdr_argv, local::LocalTransport, parse_probe, parse_session_list, probe_argv, MachineInfo, SessionEntry, Transport},
    view::{MachineState, MachineView, PaneRef, PaneStatusEvent, SessionView},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tokio::{sync::mpsc, task::JoinHandle};

pub const ALLOWED_METHODS: &[&str] = &[
    "pane.split", "pane.close", "pane.rename", "pane.read", "pane.scroll",
    "tab.create", "tab.close", "tab.rename",
    "workspace.create", "workspace.close", "workspace.rename",
    "agent.start", "agent.prompt", "agent.send_keys", "agent.get",
];

const EMIT_THROTTLE: Duration = Duration::from_millis(100);
const START_WAIT: Duration = Duration::from_secs(10);
const START_POLL: Duration = Duration::from_millis(200);
const LOCAL: &str = "local";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MachineConfig {
    pub id: String,
    pub label: String,
    pub ssh_target: String,
    pub herdr_path: Option<String>,
    pub enabled: bool,
}

/// Missing or corrupt file gives an empty list (corruption is logged).
pub fn load_registry(path: &Path) -> Vec<MachineConfig> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("cannot read {}: {e}", path.display());
            }
            return Vec::new();
        }
    };
    serde_json::from_str(&text).unwrap_or_else(|e| {
        tracing::error!("corrupt machine registry {}: {e}", path.display());
        Vec::new()
    })
}

/// Write to a temp file next to `path`, then rename over it.
pub fn save_registry(path: &Path, list: &[MachineConfig]) -> AppResult<()> {
    let json = serde_json::to_string_pretty(list).map_err(|e| AppError::new("io", e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Lowercase `[a-z0-9-]`, at most 16 chars, unique against `taken` (and never `local`).
pub fn slug(label: &str, taken: &[String]) -> String {
    let mut base = String::new();
    for c in label.to_lowercase().chars() {
        let c = if c.is_ascii_alphanumeric() { c } else { '-' };
        if c == '-' && (base.is_empty() || base.ends_with('-')) {
            continue;
        }
        base.push(c);
    }
    let trim = |s: &str, n: usize| s.chars().take(n).collect::<String>().trim_end_matches('-').to_string();
    let base = match trim(&base, 16) {
        b if b.is_empty() => "machine".to_string(),
        b => b,
    };
    let is_taken = |s: &str| s == LOCAL || taken.iter().any(|t| t == s);
    if !is_taken(&base) {
        return base;
    }
    (2u32..)
        .map(|n| {
            let suffix = format!("-{n}");
            format!("{}{suffix}", trim(&base, 16 - suffix.len()))
        })
        .find(|c| !is_taken(c))
        .expect("unbounded range")
}

/// Watcher retry delay: 1, 2, 4, 8, 16, 32, then 60 s.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(if attempt >= 6 { 60 } else { 1u64 << attempt })
}

pub enum UiEvent {
    Machine(MachineView),
    PaneStatus(PaneStatusEvent),
}
pub type Emit = Arc<dyn Fn(UiEvent) + Send + Sync>;
type Factory = Arc<dyn Fn(&MachineConfig) -> Arc<dyn Transport> + Send + Sync>;

struct Sess {
    entry: SessionEntry,
    view: Option<SessionView>,
    error: Option<AppError>,
    supervisor: Option<JoinHandle<()>>,
}

struct Machine {
    cfg: MachineConfig,
    state: MachineState,
    error: Option<AppError>,
    info: Option<MachineInfo>,
    transport: Option<Arc<dyn Transport>>,
    sessions: Vec<Sess>,
}

impl Machine {
    fn new(cfg: MachineConfig) -> Self {
        Machine { cfg, state: MachineState::Disconnected, error: None, info: None, transport: None, sessions: Vec::new() }
    }

    fn view(&self) -> MachineView {
        let sessions: Vec<SessionView> = self
            .sessions
            .iter()
            .map(|s| {
                let mut v = match (&s.view, s.entry.running) {
                    (Some(v), true) => v.clone(),
                    _ => SessionView {
                        name: s.entry.name.clone(),
                        running: s.entry.running,
                        status: AgentStatus::Unknown,
                        error: None,
                        workspaces: Vec::new(),
                    },
                };
                v.name = s.entry.name.clone();
                v.running = s.entry.running;
                v.error = s.error.clone();
                v
            })
            .collect();
        MachineView {
            id: self.cfg.id.clone(),
            label: self.cfg.label.clone(),
            kind: if self.cfg.id == LOCAL { "local" } else { "ssh" }.into(),
            state: self.state,
            error: self.error.clone(),
            version: self.info.as_ref().map(|i| i.version.clone()),
            status: AgentStatus::rollup(sessions.iter().map(|s| s.status)),
            sessions,
        }
    }

    fn abort_supervisors(&mut self) {
        for s in &mut self.sessions {
            if let Some(h) = s.supervisor.take() {
                h.abort();
            }
        }
    }
}

/// Aborts the wrapped task when dropped (so cancelling a supervisor stops its watcher).
struct AbortOnDrop(JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Default)]
struct Throttle {
    last: Option<Instant>,
    pending: bool,
}

pub struct MachineManager {
    me: Weak<MachineManager>,
    machines: Mutex<Vec<Machine>>,
    emit: Emit,
    factory: Mutex<Option<Factory>>,
    throttle: Mutex<HashMap<String, Throttle>>,
}

fn not_found(what: impl std::fmt::Display) -> AppError {
    AppError::new("not_found", what.to_string())
}

impl MachineManager {
    pub fn new(registry_path: PathBuf, emit: Emit) -> Arc<Self> {
        let mut machines = vec![Machine::new(MachineConfig {
            id: LOCAL.into(),
            label: "local".into(),
            ssh_target: String::new(),
            herdr_path: None,
            enabled: true,
        })];
        machines.extend(load_registry(&registry_path).into_iter().filter(|c| c.id != LOCAL).map(Machine::new));
        Arc::new_cyclic(|me| MachineManager {
            me: me.clone(),
            machines: Mutex::new(machines),
            emit,
            factory: Mutex::new(None),
            throttle: Mutex::new(HashMap::new()),
        })
    }

    #[cfg_attr(not(test), allow(dead_code))] // test seam; Task 13 adds the ssh factory
    pub(crate) fn with_transport_factory(self: &Arc<Self>, f: Factory) {
        *self.factory.lock().unwrap() = Some(f);
    }

    fn make_transport(&self, cfg: &MachineConfig) -> AppResult<Arc<dyn Transport>> {
        if let Some(f) = self.factory.lock().unwrap().clone() {
            return Ok(f(cfg));
        }
        if cfg.id == LOCAL {
            Ok(Arc::new(LocalTransport))
        } else {
            Err(AppError::new("invalid", "ssh machines are not supported yet"))
        }
    }

    fn with_machine<R>(&self, id: &str, f: impl FnOnce(&mut Machine) -> R) -> AppResult<R> {
        let mut ms = self.machines.lock().unwrap();
        ms.iter_mut().find(|m| m.cfg.id == id).map(f).ok_or_else(|| not_found(format!("unknown machine {id}")))
    }

    // ---- queries -------------------------------------------------------

    pub fn views(&self) -> Vec<MachineView> {
        self.machines.lock().unwrap().iter().map(Machine::view).collect()
    }

    pub fn transport(&self, id: &str) -> AppResult<Arc<dyn Transport>> {
        self.with_machine(id, |m| m.transport.clone())?
            .ok_or_else(|| not_found(format!("machine {id} is not connected")))
    }

    pub fn info(&self, id: &str) -> AppResult<MachineInfo> {
        self.with_machine(id, |m| m.info.clone())?.ok_or_else(|| not_found(format!("no herdr info for machine {id}")))
    }

    pub fn session(&self, id: &str, name: &str) -> AppResult<SessionEntry> {
        self.with_machine(id, |m| m.sessions.iter().find(|s| s.entry.name == name).map(|s| s.entry.clone()))?
            .ok_or_else(|| not_found(format!("unknown session {id}/{name}")))
    }

    // ---- events --------------------------------------------------------

    fn emit_now(&self, id: &str) {
        let view = self.machines.lock().unwrap().iter().find(|m| m.cfg.id == id).map(Machine::view);
        if let Some(v) = view {
            (self.emit)(UiEvent::Machine(v));
        }
    }

    /// Emit the Machine's view at most once per `EMIT_THROTTLE`; the latest state wins
    /// and a trailing emit guarantees the final state is delivered.
    fn notify(&self, id: &str) {
        let wait = {
            let mut t = self.throttle.lock().unwrap();
            let e = t.entry(id.to_string()).or_default();
            if e.pending {
                return;
            }
            match e.last {
                Some(l) if l.elapsed() < EMIT_THROTTLE => {
                    e.pending = true;
                    Some(EMIT_THROTTLE - l.elapsed())
                }
                _ => {
                    e.last = Some(Instant::now());
                    None
                }
            }
        };
        match wait {
            None => self.emit_now(id),
            Some(d) => {
                let Some(me) = self.me.upgrade() else { return };
                let id = id.to_string();
                tokio::spawn(async move {
                    tokio::time::sleep(d).await;
                    {
                        let mut t = me.throttle.lock().unwrap();
                        let e = t.entry(id.clone()).or_default();
                        e.pending = false;
                        e.last = Some(Instant::now());
                    }
                    me.emit_now(&id);
                });
            }
        }
    }

    fn set_state(&self, id: &str, state: MachineState, error: Option<AppError>) {
        let _ = self.with_machine(id, |m| {
            m.state = state;
            m.error = error;
        });
        self.notify(id);
    }

    // ---- connection ----------------------------------------------------

    pub async fn connect(&self, id: &str) -> AppResult<()> {
        let cfg = self.with_machine(id, |m| {
            m.abort_supervisors();
            m.sessions.clear();
            m.cfg.clone()
        })?;
        if !cfg.enabled {
            return Err(AppError::new("invalid", format!("machine {id} is disabled")));
        }
        let result = self.connect_inner(&cfg).await;
        match &result {
            Ok(()) => self.set_state(id, MachineState::Connected, None),
            Err(e) => {
                let state = if e.code == "incompatible" { MachineState::Incompatible } else { MachineState::Error };
                self.set_state(id, state, Some(e.clone()));
            }
        }
        result
    }

    async fn connect_inner(&self, cfg: &MachineConfig) -> AppResult<()> {
        let id = cfg.id.as_str();
        let transport = self.make_transport(cfg)?;
        self.with_machine(id, |m| {
            m.transport = Some(transport.clone());
            m.info = None;
        })?;
        self.set_state(id, MachineState::Probing, None);
        let out = exec(transport.as_ref(), &probe_argv(cfg.herdr_path.as_deref())).await?;
        let info = parse_probe(&out.stdout)?;
        self.with_machine(id, |m| m.info = Some(info))?;
        let list = self.list_sessions(id).await?;
        self.apply_list(id, list)
    }

    pub async fn disconnect(&self, id: &str) {
        let released = self
            .with_machine(id, |m| {
                m.abort_supervisors();
                let t = m.transport.take();
                let entries: Vec<SessionEntry> = m.sessions.drain(..).map(|s| s.entry).collect();
                m.info = None;
                m.state = MachineState::Disconnected;
                m.error = None;
                (t, entries)
            })
            .ok();
        if let Some((Some(t), entries)) = released {
            for e in entries {
                if let Err(err) = t.release_socket(&e).await {
                    tracing::warn!("release_socket {id}/{}: {err}", e.name);
                }
            }
        }
        self.notify(id);
    }

    // ---- sessions ------------------------------------------------------

    async fn list_sessions(&self, id: &str) -> AppResult<Vec<SessionEntry>> {
        let (info, t) = (self.info(id)?, self.transport(id)?);
        let out = exec(t.as_ref(), &herdr_argv(&info, "default", &["session", "list"])).await?;
        if out.status != 0 {
            return Err(AppError::new("herdr_error", format!("session list failed: {}", out.stderr.trim())));
        }
        Ok(parse_session_list(&out.stdout))
    }

    /// Reconcile the Machine's sessions with `list`; start watchers for newly running ones.
    fn apply_list(&self, id: &str, list: Vec<SessionEntry>) -> AppResult<()> {
        self.with_machine(id, |m| {
            let Some(transport) = m.transport.clone() else { return };
            let mut old: Vec<Sess> = std::mem::take(&mut m.sessions);
            let mut next = Vec::new();
            for entry in list {
                let mut s = match old.iter().position(|s| s.entry.name == entry.name) {
                    Some(i) => old.remove(i),
                    None => Sess { entry: entry.clone(), view: None, error: None, supervisor: None },
                };
                s.entry = entry;
                if s.entry.running {
                    if s.supervisor.is_none() {
                        if let Some(me) = self.me.upgrade() {
                            let (id, name) = (m.cfg.id.clone(), s.entry.name.clone());
                            s.supervisor = Some(tokio::spawn(me.supervise(id, name, transport.clone())));
                        }
                    }
                } else {
                    if let Some(h) = s.supervisor.take() {
                        h.abort();
                    }
                    s.view = None;
                    s.error = None;
                }
                next.push(s);
            }
            for s in old {
                if let Some(h) = s.supervisor {
                    h.abort();
                }
            }
            m.sessions = next;
        })?;
        self.notify(id);
        Ok(())
    }

    pub async fn refresh_sessions(&self, id: &str) -> AppResult<()> {
        let list = self.list_sessions(id).await?;
        self.apply_list(id, list)
    }

    fn valid_session_name(name: &str) -> bool {
        !name.is_empty()
            && !name.starts_with('-')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    }

    pub async fn start_session(&self, id: &str, name: &str) -> AppResult<()> {
        if !Self::valid_session_name(name) {
            return Err(AppError::new("invalid", format!("invalid session name {name:?}")));
        }
        let (info, t) = (self.info(id)?, self.transport(id)?);
        let mut argv: Vec<String> =
            ["sh", "-c", r#"nohup "$@" >/dev/null 2>&1 &"#, "herdr-start"].iter().map(|s| s.to_string()).collect();
        argv.extend(herdr_argv(&info, name, &["server"]));
        let out = exec(t.as_ref(), &argv).await?;
        if out.status != 0 {
            return Err(AppError::new("herdr_error", format!("could not start {name}: {}", out.stderr.trim())));
        }
        let deadline = tokio::time::Instant::now() + START_WAIT;
        loop {
            if let Some(entry) = self.list_sessions(id).await?.into_iter().find(|e| e.name == name) {
                let socket = t.local_socket(&entry).await?;
                if rpc::call(&socket, "session.snapshot", json!({})).await.is_ok() {
                    break;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(AppError::new("timeout", format!("session {name} did not start within {}s", START_WAIT.as_secs())));
            }
            tokio::time::sleep(START_POLL).await;
        }
        self.refresh_sessions(id).await
    }

    pub async fn stop_session(&self, id: &str, name: &str) -> AppResult<()> {
        let entry = self.session(id, name)?;
        let t = self.transport(id)?;
        let socket = t.local_socket(&entry).await?;
        match rpc::call(&socket, "server.stop", json!({})).await {
            Ok(_) => {}
            // herdr may close the socket before replying: judge by the session list.
            Err(e) if e.code == "io" => {
                let list = self.list_sessions(id).await?;
                if list.iter().any(|s| s.name == name && s.running) {
                    return Err(e);
                }
            }
            Err(e) => return Err(e),
        }
        if let Err(e) = t.release_socket(&entry).await {
            tracing::warn!("release_socket {id}/{name}: {e}");
        }
        self.refresh_sessions(id).await
    }

    pub async fn call(&self, pane_machine: &str, session: &str, method: &str, params: Value) -> AppResult<Value> {
        if !ALLOWED_METHODS.contains(&method) {
            return Err(AppError::new("invalid", format!("method {method} is not allowed")));
        }
        let entry = self.session(pane_machine, session)?;
        let socket = self.transport(pane_machine)?.local_socket(&entry).await?;
        rpc::call(&socket, method, params).await
    }

    // ---- per-session supervisor ---------------------------------------

    fn update_session(&self, id: &str, name: &str, f: impl FnOnce(&mut Sess)) {
        let _ = self.with_machine(id, |m| {
            if let Some(s) = m.sessions.iter_mut().find(|s| s.entry.name == name) {
                f(s);
            }
        });
        self.notify(id);
    }

    fn session_running(&self, id: &str, name: &str) -> bool {
        self.session(id, name).map(|e| e.running).unwrap_or(false)
    }

    /// Keep a watcher alive for one running session; reconnect (fresh snapshot) with backoff.
    async fn supervise(self: Arc<Self>, id: String, name: String, transport: Arc<dyn Transport>) {
        let mut attempt = 0u32;
        loop {
            let Ok(entry) = self.session(&id, &name) else { return };
            let err = match transport.local_socket(&entry).await {
                Err(e) => e,
                Ok(socket) => {
                    let (tx, mut rx) = mpsc::unbounded_channel();
                    let _guard = AbortOnDrop(spawn_watcher(name.clone(), socket, tx));
                    let mut closed = None;
                    while let Some(ev) = rx.recv().await {
                        match ev {
                            WatchEvent::View(v) => {
                                attempt = 0;
                                self.update_session(&id, &name, |s| {
                                    s.view = Some(v);
                                    s.error = None;
                                });
                            }
                            WatchEvent::Status { pane_id, status, previous, title } => {
                                (self.emit)(UiEvent::PaneStatus(PaneStatusEvent {
                                    pane: PaneRef { machine_id: id.clone(), session: name.clone(), pane_id },
                                    status,
                                    previous,
                                    title,
                                }));
                            }
                            WatchEvent::Closed(e) => {
                                closed = Some(e);
                                break;
                            }
                        }
                    }
                    closed.unwrap_or_else(|| AppError::new("io", "watcher ended"))
                }
            };
            self.update_session(&id, &name, |s| s.error = Some(err));
            if let Ok(list) = self.list_sessions(&id).await {
                if self.apply_list(&id, list).is_err() || !self.session_running(&id, &name) {
                    return; // stopped (apply_list already marked it) or machine gone
                }
            }
            tokio::time::sleep(backoff(attempt)).await;
            attempt = attempt.saturating_add(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{herdr::fake::FakeHerdr, transport::{local::LocalTransport, Transport}};
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn registry_roundtrip_and_corrupt_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("machines.json");
        assert!(load_registry(&p).is_empty());
        let list = vec![MachineConfig { id: "devtuf".into(), label: "devtuf".into(), ssh_target: "devtuf".into(), herdr_path: None, enabled: true }];
        save_registry(&p, &list).unwrap();
        assert_eq!(load_registry(&p), list);
        std::fs::write(&p, "{oops").unwrap();
        assert!(load_registry(&p).is_empty());
    }
    #[test]
    fn slugs_are_short_unique_and_safe() {
        assert_eq!(slug("Dev Tuf!", &[]), "dev-tuf");
        assert_eq!(slug("devtuf", &["devtuf".into()]), "devtuf-2");
        assert!(slug("a-machine-label-that-is-way-too-long", &[]).len() <= 16);
        assert_eq!(slug("local", &[]), "local-2");
    }

    /// Fake transport: probe/session-list answered by a script, socket = FakeHerdr.
    struct FakeT { sock: String }
    #[async_trait::async_trait]
    impl Transport for FakeT {
        fn wrap(&self, argv: &[String], _tty: bool) -> Vec<String> {
            let joined = argv.join(" ");
            let out = if joined.contains("session list") {
                format!("name status directory socket\ndefault running /x {}\nold stopped /y /y/herdr.sock\n", self.sock)
            } else {
                "HOME=/h\nHERDR=/h/herdr\nPI_DIR=/h/.pi/agent/sessions\nVERSION=0.9.3\nPROTOCOL=22\n".to_string()
            };
            vec!["printf".into(), "%s".into(), out]
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> { Ok(s.socket.clone().into()) }
        async fn release_socket(&self, _: &SessionEntry) -> AppResult<()> { Ok(()) }
    }

    #[tokio::test]
    async fn connects_local_and_emits_views() {
        let snap: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| if m == "session.snapshot" { Ok(json!({"type":"session_snapshot","snapshot": snap.clone()})) } else { Ok(json!({"type":"ok"})) }));
        let events: Arc<Mutex<Vec<MachineView>>> = Arc::default();
        let ev = events.clone();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(move |e| if let UiEvent::Machine(v) = e { ev.lock().unwrap().push(v) }));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>));
        mgr.connect("local").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let v = mgr.views().into_iter().find(|v| v.id == "local").unwrap();
        assert_eq!(v.state, MachineState::Connected);
        assert_eq!(v.version.as_deref(), Some("0.9.3"));
        assert_eq!(v.sessions.iter().map(|s| (s.name.as_str(), s.running)).collect::<Vec<_>>(), [("default", true), ("old", false)]);
        assert_eq!(v.sessions[0].workspaces.len(), 2);
        assert_eq!(v.status, crate::herdr::types::AgentStatus::Blocked);
        assert!(!events.lock().unwrap().is_empty());
        assert_eq!(mgr.call("local", "default", "server.stop", json!({})).await.unwrap_err().code, "invalid");
        mgr.call("local", "default", "pane.close", json!({"pane_id":"w1:p2"})).await.unwrap();
        assert_eq!(f.calls_of("pane.close"), 1);
        let _ = LocalTransport; // default factory type exists
    }
}
