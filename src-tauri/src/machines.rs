//! Machine manager: owns Machines, their Sessions and watchers, and the UI event stream.
use crate::{
    attach::AttachManager,
    error::{AppError, AppResult},
    herdr::{
        rpc,
        types::AgentStatus,
        watcher::{spawn_watcher, WatchEvent},
    },
    transport::{
        exec, herdr_argv, local::LocalTransport, parse_probe, parse_session_list, probe_argv,
        ssh::{classify_ssh_error, clear_stale_ctl, master_alive, master_exit, start_master, SshTransport},
        MachineInfo, SessionEntry, Transport,
    },
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
    /// The ssh Machine's one transport (its forward cache lives here); created lazily.
    ssh: Option<Arc<SshTransport>>,
    sessions: Vec<Sess>,
    /// Backoff retry task after an unexpected drop.
    reconnect: Option<JoinHandle<()>>,
    /// Serializes connects of this Machine.
    gate: Arc<tokio::sync::Mutex<()>>,
}

impl Machine {
    fn new(cfg: MachineConfig) -> Self {
        Machine {
            cfg,
            state: MachineState::Disconnected,
            error: None,
            info: None,
            transport: None,
            ssh: None,
            sessions: Vec::new(),
            reconnect: None,
            gate: Arc::default(),
        }
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
    registry: PathBuf,
    attach: Mutex<Option<Arc<AttachManager>>>,
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
            registry: registry_path,
            attach: Mutex::new(None),
            machines: Mutex::new(machines),
            emit,
            factory: Mutex::new(None),
            throttle: Mutex::new(HashMap::new()),
        })
    }

    /// Terminals are closed through this when a Machine disconnects.
    pub fn set_attach_manager(&self, a: Arc<AttachManager>) {
        *self.attach.lock().unwrap() = Some(a);
    }

    #[cfg_attr(not(test), allow(dead_code))] // test seam: replaces the default local/ssh transports
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
            Ok(self.ssh_for(cfg)?)
        }
    }

    /// The Machine's single `SshTransport`, created on first use. `None` when a test
    /// factory supplies the transport.
    fn ssh_for(&self, cfg: &MachineConfig) -> AppResult<Arc<SshTransport>> {
        let mut ms = self.machines.lock().unwrap();
        let m = ms.iter_mut().find(|m| m.cfg.id == cfg.id).ok_or_else(|| not_found(format!("unknown machine {}", cfg.id)))?;
        if m.ssh.is_none() {
            m.ssh = Some(Arc::new(SshTransport::new(&cfg.id, &cfg.ssh_target)?));
        }
        Ok(m.ssh.clone().expect("just set"))
    }

    fn ssh_of(&self, id: &str) -> Option<Arc<SshTransport>> {
        self.with_machine(id, |m| m.ssh.clone()).ok().flatten()
    }

    /// Control socket path and target for an ssh Machine (for the interactive master).
    pub fn ssh_master(&self, id: &str) -> AppResult<(PathBuf, String)> {
        if id == LOCAL {
            return Err(AppError::new("invalid", "the local machine has no ssh connection"));
        }
        let cfg = self.with_machine(id, |m| m.cfg.clone())?;
        let s = self.ssh_for(&cfg)?;
        Ok((s.ctl.clone(), s.target.clone()))
    }

    pub async fn master_alive(&self, id: &str) -> bool {
        match self.ssh_of(id) {
            Some(s) => master_alive(&s.ctl, &s.target).await,
            None => false,
        }
    }

    pub fn is_ssh(&self, id: &str) -> bool {
        id != LOCAL
    }

    fn persist(&self) -> AppResult<()> {
        let list: Vec<MachineConfig> =
            self.machines.lock().unwrap().iter().filter(|m| m.cfg.id != LOCAL).map(|m| m.cfg.clone()).collect();
        save_registry(&self.registry, &list)
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

    pub(crate) fn cancel_reconnect(&self, id: &str) {
        let _ = self.with_machine(id, |m| {
            if let Some(h) = m.reconnect.take() {
                h.abort();
            }
        });
    }

    pub async fn connect(&self, id: &str) -> AppResult<()> {
        let cfg = self.with_machine(id, |m| m.cfg.clone())?;
        if !cfg.enabled {
            return Err(AppError::new("invalid", format!("machine {id} is disabled")));
        }
        self.cancel_reconnect(id);
        let gate = self.with_machine(id, |m| m.gate.clone())?;
        let _g = gate.lock().await;
        // Reconnecting: stop watchers and release the old sockets first.
        self.teardown(id, false).await;
        self.connect_core(&cfg).await
    }

    async fn connect_core(&self, cfg: &MachineConfig) -> AppResult<()> {
        let id = cfg.id.as_str();
        let result = self.connect_inner(cfg).await;
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
        let ssh = if id != LOCAL && self.factory.lock().unwrap().is_none() { Some(self.ssh_for(cfg)?) } else { None };
        let transport: Arc<dyn Transport> = match &ssh {
            Some(s) => s.clone(),
            None => self.make_transport(cfg)?,
        };
        self.with_machine(id, |m| {
            m.transport = Some(transport.clone());
            m.info = None;
        })?;
        if let Some(s) = &ssh {
            self.set_state(id, MachineState::Authenticating, None);
            if !master_alive(&s.ctl, &s.target).await {
                clear_stale_ctl(&s.ctl, &s.target).await;
                start_master(id, &s.ctl, &s.target).await?;
            }
            // Whatever the master's history, its forwards are not the cached ones.
            s.forget_forwards();
        }
        self.set_state(id, MachineState::Probing, None);
        let out = exec(transport.as_ref(), &probe_argv(cfg.herdr_path.as_deref())).await?;
        let info = parse_probe(&out.stdout)?;
        self.with_machine(id, |m| m.info = Some(info))?;
        let list = self.list_sessions(id).await?;
        self.apply_list(id, list)
    }

    /// Stop watchers, close terminals and release forwarded sockets. `clear` also forgets the Sessions.
    async fn teardown(&self, id: &str, clear: bool) {
        let released = self
            .with_machine(id, |m| {
                m.abort_supervisors();
                let t = m.transport.take();
                let entries: Vec<SessionEntry> = if clear {
                    m.sessions.drain(..).map(|s| s.entry).collect()
                } else {
                    m.sessions.iter().map(|s| s.entry.clone()).collect()
                };
                m.info = None;
                (t, entries)
            })
            .ok();
        if let Some(a) = self.attach.lock().unwrap().clone() {
            a.close_machine(id);
        }
        if let Some((Some(t), entries)) = released {
            for e in entries.into_iter().filter(|e| e.running) {
                if let Err(err) = t.release_socket(&e).await {
                    tracing::warn!("release_socket {id}/{}: {err}", e.name);
                }
            }
        }
    }

    /// Explicit disconnect: forgets the Sessions and, for ssh, ends the master.
    pub async fn disconnect(&self, id: &str) {
        self.cancel_reconnect(id);
        self.teardown(id, true).await;
        if let Some(s) = self.ssh_of(id) {
            master_exit(&s.ctl, &s.target).await;
        }
        let _ = self.with_machine(id, |m| {
            m.state = MachineState::Disconnected;
            m.error = None;
        });
        self.notify(id);
    }

    /// Disconnect every ssh Machine (app exit).
    pub async fn disconnect_all_ssh(&self) {
        let ids: Vec<String> =
            self.machines.lock().unwrap().iter().filter(|m| m.cfg.id != LOCAL).map(|m| m.cfg.id.clone()).collect();
        for id in ids {
            self.disconnect(&id).await;
        }
    }

    /// The ssh master died under a connected Machine: grey it out, keep its last
    /// snapshot, close its terminals, and retry with backoff.
    pub(crate) async fn on_master_lost(&self, id: &str) {
        let go = self
            .with_machine(id, |m| {
                if m.state == MachineState::Disconnected || m.reconnect.as_ref().is_some_and(|h| !h.is_finished()) {
                    return false;
                }
                m.state = MachineState::Disconnected;
                m.error = None;
                true
            })
            .unwrap_or(false);
        if !go {
            return;
        }
        self.teardown(id, false).await;
        self.notify(id);
        if let Some(me) = self.me.upgrade() {
            let h = tokio::spawn(me.reconnect_loop(id.to_string()));
            let _ = self.with_machine(id, |m| m.reconnect = Some(h));
        }
    }

    /// Retry the connection with `backoff`; an auth failure (or any state that needs the
    /// user) ends the retries.
    async fn reconnect_loop(self: Arc<Self>, id: String) {
        let mut attempt = 0u32;
        loop {
            tokio::time::sleep(backoff(attempt)).await;
            attempt = attempt.saturating_add(1);
            let Ok((cfg, gate)) = self.with_machine(&id, |m| (m.cfg.clone(), m.gate.clone())) else { return };
            let _g = gate.lock().await;
            match self.connect_core(&cfg).await {
                Ok(()) => return,
                Err(e) if matches!(e.code.as_str(), "ssh_auth" | "incompatible" | "herdr_not_found") => return,
                Err(e) => self.set_state(&id, MachineState::Disconnected, Some(e)),
            }
        }
    }

    // ---- registry ------------------------------------------------------

    pub async fn add(&self, ssh_target: String, label: Option<String>, herdr_path: Option<String>) -> AppResult<MachineView> {
        let target = ssh_target.trim().to_string();
        if target.is_empty() || target.starts_with('-') || target.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(AppError::new("invalid", format!("invalid ssh target {ssh_target:?}")));
        }
        let label = label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).unwrap_or_else(|| target.clone());
        let herdr_path = herdr_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        let id = {
            let mut ms = self.machines.lock().unwrap();
            let taken: Vec<String> = ms.iter().map(|m| m.cfg.id.clone()).collect();
            let id = slug(&label, &taken);
            ms.push(Machine::new(MachineConfig { id: id.clone(), label, ssh_target: target, herdr_path, enabled: true }));
            id
        };
        if let Err(e) = self.persist() {
            self.machines.lock().unwrap().retain(|m| m.cfg.id != id);
            return Err(e);
        }
        self.emit_now(&id);
        self.with_machine(&id, |m| m.view())
    }

    pub async fn remove(&self, id: &str) -> AppResult<()> {
        if id == LOCAL {
            return Err(AppError::new("invalid", "the local machine cannot be removed"));
        }
        self.with_machine(id, |_| ())?;
        self.disconnect(id).await;
        if let Some(s) = self.ssh_of(id) {
            let _ = std::fs::remove_file(&s.ctl);
        }
        self.machines.lock().unwrap().retain(|m| m.cfg.id != id);
        self.throttle.lock().unwrap().remove(id);
        self.persist()
    }

    /// Set the herdr path override, persist it and reconnect.
    pub async fn update(&self, id: &str, herdr_path: Option<String>) -> AppResult<MachineView> {
        if id == LOCAL {
            return Err(AppError::new("invalid", "the local machine has no settings to update"));
        }
        let herdr_path = herdr_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        self.with_machine(id, |m| m.cfg.herdr_path = herdr_path)?;
        self.persist()?;
        // A failed connect is reported through the Machine's state and error.
        let _ = self.connect(id).await;
        self.with_machine(id, |m| m.view())
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
        // Transient errors (an ssh hiccup, a socket not yet there) never end the wait early.
        let mut last_err: Option<AppError> = None;
        loop {
            match self.probe_started(id, name, t.as_ref()).await {
                Ok(true) => break,
                Ok(false) => {}
                Err(e) => last_err = Some(e),
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(last_err
                    .unwrap_or_else(|| AppError::new("timeout", format!("session {name} did not start within {}s", START_WAIT.as_secs()))));
            }
            tokio::time::sleep(START_POLL).await;
        }
        self.refresh_sessions(id).await
    }

    /// One poll of `start_session`: is `name` listed running and answering a snapshot?
    async fn probe_started(&self, id: &str, name: &str, t: &dyn Transport) -> AppResult<bool> {
        let Some(entry) = self.list_sessions(id).await?.into_iter().find(|e| e.name == name && e.running) else {
            return Ok(false);
        };
        let socket = t.local_socket(&entry).await?;
        match rpc::call(&socket, "session.snapshot", json!({})).await {
            Ok(_) => Ok(true),
            Err(e) => Err(self.forward_refusal(id, e)),
        }
    }

    /// Over ssh, a peer that closes before any frame means sshd refused the socket forward.
    fn forward_refusal(&self, id: &str, e: AppError) -> AppError {
        if id != LOCAL && rpc::closed_early(&e) {
            classify_ssh_error("administratively prohibited")
        } else {
            e
        }
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
            let mut got_view = false;
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
                                got_view = true;
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
            // The first snapshot over a freshly forwarded socket ending in EOF: sshd refused it.
            let err = if !got_view { self.forward_refusal(&id, err) } else { err };
            self.update_session(&id, &name, |s| s.error = Some(err));
            if let Some(ssh) = self.ssh_of(&id) {
                if !master_alive(&ssh.ctl, &ssh.target).await {
                    let me = self.clone();
                    let id = id.clone();
                    tokio::spawn(async move { me.on_master_lost(&id).await });
                    return;
                }
            }
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

    struct RecT { inner: FakeT, released: Arc<Mutex<Vec<String>>> }
    #[async_trait::async_trait]
    impl Transport for RecT {
        fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> { self.inner.wrap(argv, tty) }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> { self.inner.local_socket(s).await }
        async fn release_socket(&self, s: &SessionEntry) -> AppResult<()> { self.released.lock().unwrap().push(s.name.clone()); Ok(()) }
    }

    #[test]
    fn backoff_schedule() {
        let s: Vec<u64> = (0..9).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(s, vec![1, 2, 4, 8, 16, 32, 60, 60, 60]);
    }
    #[tokio::test]
    async fn add_and_remove_persist() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("m.json");
        let mgr = MachineManager::new(p.clone(), Arc::new(|_| {}));
        let v = mgr.add("cuong@devtuf.lan".into(), Some("Dev Tuf".into()), None).await.unwrap();
        assert_eq!((v.id.as_str(), v.kind.as_str(), v.state.clone()), ("dev-tuf", "ssh", MachineState::Disconnected));
        assert_eq!(load_registry(&p)[0].ssh_target, "cuong@devtuf.lan");
        mgr.remove("dev-tuf").await.unwrap();
        assert!(load_registry(&p).is_empty());
        assert!(mgr.views().iter().all(|m| m.id != "dev-tuf"));
    }
    #[tokio::test]
    async fn add_rejects_option_like_targets() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        assert_eq!(mgr.add("-oProxyCommand=x".into(), None, None).await.unwrap_err().code, "invalid");
        assert_eq!(mgr.add("  ".into(), None, None).await.unwrap_err().code, "invalid");
    }

    async fn wait_for(mut cond: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if cond() { return true; }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test]
    async fn forward_refusal_marks_the_session() {
        // sshd refuses the forward: the local socket accepts, then closes with no frame.
        let d = tempfile::Builder::new().prefix("hr").tempdir_in("/tmp").unwrap();
        let sock = d.path().join("x.sock");
        let l = tokio::net::UnixListener::bind(&sock).unwrap();
        tokio::spawn(async move { while let Ok((s, _)) = l.accept().await { drop(s); } });
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let s = sock.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| Arc::new(FakeT { sock: s.clone() }) as Arc<dyn Transport>));
        mgr.add("box".into(), None, None).await.unwrap();
        mgr.connect("box").await.unwrap();
        let m = mgr.clone();
        assert!(wait_for(move || m.views().iter().find(|v| v.id == "box").unwrap().sessions[0].error.as_ref().is_some_and(|e| e.code == "ssh_forward_denied")).await);
        mgr.disconnect("box").await;
    }

    #[tokio::test]
    async fn dropped_connection_keeps_last_snapshot_and_closes_terminals() {
        use crate::attach::{AttachEvent, AttachKey, AttachManager, Sink};
        struct Rec(Arc<Mutex<Vec<AttachEvent>>>);
        impl Sink for Rec {
            fn data(&self, _: Vec<u8>) {}
            fn event(&self, e: AttachEvent) { self.0.lock().unwrap().push(e); }
        }
        let snap: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| if m == "session.snapshot" { Ok(json!({"type":"session_snapshot","snapshot": snap.clone()})) } else { Ok(json!({"type":"ok"})) }));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>));
        let att = AttachManager::new(std::time::Duration::from_secs(15));
        mgr.set_attach_manager(att.clone());
        mgr.add("box".into(), None, None).await.unwrap();
        mgr.connect("box").await.unwrap();
        let m = mgr.clone();
        assert!(wait_for(move || !m.views().iter().find(|v| v.id == "box").unwrap().sessions[0].workspaces.is_empty()).await);
        let events = Arc::new(Mutex::new(Vec::new()));
        att.open(AttachKey { machine_id: "box".into(), session: "default".into(), terminal_id: "t".into() }, vec!["cat".into()], 80, 24, Arc::new(Rec(events.clone()))).unwrap();

        mgr.on_master_lost("box").await;
        let v = mgr.views().into_iter().find(|v| v.id == "box").unwrap();
        assert_eq!(v.state, MachineState::Disconnected);
        assert_eq!(v.sessions.len(), 2);
        assert!(!v.sessions[0].workspaces.is_empty(), "last snapshot is kept");
        assert!(wait_for(|| events.lock().unwrap().contains(&AttachEvent::Detached)).await);
        // An explicit disconnect clears it.
        mgr.disconnect("box").await;
        assert!(mgr.views().into_iter().find(|v| v.id == "box").unwrap().sessions.is_empty());
    }

    /// `session list` fails on calls 1..=3 (call 0 is the connect); start_session must keep polling.
    struct FlakyT { inner: FakeT, lists: std::sync::atomic::AtomicU32 }
    #[async_trait::async_trait]
    impl Transport for FlakyT {
        fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
            if argv.join(" ").contains("session list") {
                let n = self.lists.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if (1..=3).contains(&n) {
                    return vec!["sh".into(), "-c".into(), "echo boom >&2; exit 1".into()];
                }
            }
            self.inner.wrap(argv, tty)
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> { self.inner.local_socket(s).await }
        async fn release_socket(&self, s: &SessionEntry) -> AppResult<()> { self.inner.release_socket(s).await }
    }

    #[tokio::test]
    async fn start_session_polls_through_transient_errors() {
        let snap: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| if m == "session.snapshot" { Ok(json!({"type":"session_snapshot","snapshot": snap.clone()})) } else { Ok(json!({"type":"ok"})) }));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| Arc::new(FlakyT { inner: FakeT { sock: sock.clone() }, lists: Default::default() }) as Arc<dyn Transport>));
        // Initial connect would hit the failing list; the first call (count 0) passes.
        mgr.connect("local").await.unwrap();
        mgr.start_session("local", "default").await.unwrap();
    }

    #[tokio::test]
    async fn reconnect_releases_old_sockets() {
        let snap: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| if m == "session.snapshot" { Ok(json!({"type":"session_snapshot","snapshot": snap.clone()})) } else { Ok(json!({"type":"ok"})) }));
        let released: Arc<Mutex<Vec<String>>> = Arc::default();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (sock, rel) = (f.path.to_string_lossy().to_string(), released.clone());
        mgr.with_transport_factory(Arc::new(move |_| Arc::new(RecT { inner: FakeT { sock: sock.clone() }, released: rel.clone() }) as Arc<dyn Transport>));
        mgr.connect("local").await.unwrap();
        assert!(released.lock().unwrap().is_empty());
        mgr.connect("local").await.unwrap();
        assert!(released.lock().unwrap().contains(&"default".to_string()), "{:?}", released.lock().unwrap());
        assert_eq!(mgr.views()[0].state, MachineState::Connected);
    }
}
