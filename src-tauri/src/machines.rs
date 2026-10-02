//! Machine manager: owns Machines, their Sessions and watchers, and the UI event stream.
use crate::{
    attach::AttachManager,
    error::{AppError, AppResult},
    herdr::{
        rpc,
        types::AgentStatus,
        watcher::{spawn_watcher, WatchEvent},
    },
    transcript::ChatManager,
    transport::{
        exec, herdr_argv,
        local::LocalTransport,
        parse_probe, parse_session_list, probe_argv,
        ssh::{
            classify_ssh_error, clear_stale_ctl, master_alive, master_exit, start_master,
            SshTransport,
        },
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
    "pane.split",
    "pane.close",
    "pane.rename",
    "pane.read",
    "pane.scroll",
    "tab.create",
    "tab.close",
    "tab.rename",
    "workspace.create",
    "workspace.close",
    "workspace.rename",
    "agent.start",
    "agent.prompt",
    "agent.send_keys",
    "agent.get",
];

const EMIT_THROTTLE: Duration = Duration::from_millis(100);
const START_WAIT: Duration = Duration::from_secs(10);
const START_POLL: Duration = Duration::from_millis(200);
/// How often a connected ssh Machine's master is checked.
const HEALTH_EVERY: Duration = Duration::from_secs(15);
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
    let json =
        serde_json::to_string_pretty(list).map_err(|e| AppError::new("io", e.to_string()))?;
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
    let trim = |s: &str, n: usize| {
        s.chars()
            .take(n)
            .collect::<String>()
            .trim_end_matches('-')
            .to_string()
    };
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

/// Remove any forwarded-socket files (`<id>-<8 hex>.sock`) left in the runtime dir.
fn sweep_sockets(id: &str) {
    let Ok(rd) = std::fs::read_dir(crate::transport::runtime_dir()) else {
        return;
    };
    let prefix = format!("{id}-");
    for f in rd.flatten() {
        let name = f.file_name().to_string_lossy().into_owned();
        let hex = name
            .strip_prefix(&prefix)
            .and_then(|r| r.strip_suffix(".sock"));
        if hex.is_some_and(|h| h.len() == 8 && h.chars().all(|c| c.is_ascii_hexdigit())) {
            let _ = std::fs::remove_file(f.path());
        }
    }
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
/// Test seam: replaces starting the batch ssh master.
type MasterStart = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send>>
        + Send
        + Sync,
>;
/// Test seam: replaces asking the ssh master to exit.
type MasterExit = Arc<dyn Fn() + Send + Sync>;
/// Test seam: replaces the health task's `master_alive` check.
type AliveCheck = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>> + Send + Sync,
>;
type Factory = Arc<dyn Fn(&MachineConfig) -> Arc<dyn Transport> + Send + Sync>;

struct Sess {
    entry: SessionEntry,
    view: Option<SessionView>,
    error: Option<AppError>,
    supervisor: Option<JoinHandle<()>>,
    /// Asks this Session's watcher for a fresh snapshot.
    refetch: Arc<tokio::sync::Notify>,
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
    /// Bumped by disconnect/remove; a connect that started under an older epoch is abandoned.
    epoch: u64,
    /// Periodic master check while an ssh Machine is connected.
    health: Option<JoinHandle<()>>,
    /// Being removed: its views are no longer emitted.
    removing: bool,
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
            epoch: 0,
            health: None,
            removing: false,
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
    chats: Mutex<Option<Arc<ChatManager>>>,
    machines: Mutex<Vec<Machine>>,
    emit: Emit,
    factory: Mutex<Option<Factory>>,
    master_start: Mutex<Option<MasterStart>>,
    master_exit: Mutex<Option<MasterExit>>,
    alive_check: Mutex<Option<AliveCheck>>,
    health_every: Mutex<Duration>,
    throttle: Mutex<HashMap<String, Throttle>>,
}

/// Why a connect attempt ended without connecting.
enum Fail {
    /// The Machine was disconnected or removed meanwhile.
    Stale,
    Err(AppError),
}

impl From<AppError> for Fail {
    fn from(e: AppError) -> Self {
        Fail::Err(e)
    }
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
        machines.extend(
            load_registry(&registry_path)
                .into_iter()
                .filter(|c| c.id != LOCAL)
                .map(Machine::new),
        );
        Arc::new_cyclic(|me| MachineManager {
            me: me.clone(),
            registry: registry_path,
            attach: Mutex::new(None),
            chats: Mutex::new(None),
            machines: Mutex::new(machines),
            emit,
            factory: Mutex::new(None),
            master_start: Mutex::new(None),
            master_exit: Mutex::new(None),
            alive_check: Mutex::new(None),
            health_every: Mutex::new(HEALTH_EVERY),
            throttle: Mutex::new(HashMap::new()),
        })
    }

    /// Terminals are closed through this when a Machine disconnects.
    pub fn set_attach_manager(&self, a: Arc<AttachManager>) {
        *self.attach.lock().unwrap() = Some(a);
    }

    /// Chat tails are closed through this when a Machine is disconnected or removed.
    pub fn set_chat_manager(&self, c: Arc<ChatManager>) {
        *self.chats.lock().unwrap() = Some(c);
    }

    #[cfg_attr(not(test), allow(dead_code))] // test seam: replaces the default local/ssh transports
    pub(crate) fn with_transport_factory(self: &Arc<Self>, f: Factory) {
        *self.factory.lock().unwrap() = Some(f);
    }

    #[cfg(test)]
    fn with_master_start(&self, f: MasterStart) {
        *self.master_start.lock().unwrap() = Some(f);
    }

    #[cfg(test)]
    fn with_master_exit(&self, f: MasterExit) {
        *self.master_exit.lock().unwrap() = Some(f);
    }

    #[cfg(test)]
    fn with_health_check(&self, every: Duration, f: AliveCheck) {
        *self.health_every.lock().unwrap() = every;
        *self.alive_check.lock().unwrap() = Some(f);
    }

    async fn end_master(&self, s: &SshTransport) {
        let seam = self.master_exit.lock().unwrap().clone();
        match seam {
            Some(f) => f(),
            None => master_exit(&s.ctl, &s.target).await,
        }
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
        let m = ms
            .iter_mut()
            .find(|m| m.cfg.id == cfg.id)
            .ok_or_else(|| not_found(format!("unknown machine {}", cfg.id)))?;
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
            return Err(AppError::new(
                "invalid",
                "the local machine has no ssh connection",
            ));
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
        let list: Vec<MachineConfig> = self
            .machines
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.cfg.id != LOCAL)
            .map(|m| m.cfg.clone())
            .collect();
        save_registry(&self.registry, &list)
    }

    fn with_machine<R>(&self, id: &str, f: impl FnOnce(&mut Machine) -> R) -> AppResult<R> {
        let mut ms = self.machines.lock().unwrap();
        ms.iter_mut()
            .find(|m| m.cfg.id == id)
            .map(f)
            .ok_or_else(|| not_found(format!("unknown machine {id}")))
    }

    // ---- queries -------------------------------------------------------

    pub fn views(&self) -> Vec<MachineView> {
        self.machines
            .lock()
            .unwrap()
            .iter()
            .map(Machine::view)
            .collect()
    }

    pub fn transport(&self, id: &str) -> AppResult<Arc<dyn Transport>> {
        self.with_machine(id, |m| m.transport.clone())?
            .ok_or_else(|| not_found(format!("machine {id} is not connected")))
    }

    pub fn info(&self, id: &str) -> AppResult<MachineInfo> {
        self.with_machine(id, |m| m.info.clone())?
            .ok_or_else(|| not_found(format!("no herdr info for machine {id}")))
    }

    pub fn session(&self, id: &str, name: &str) -> AppResult<SessionEntry> {
        self.with_machine(id, |m| {
            m.sessions
                .iter()
                .find(|s| s.entry.name == name)
                .map(|s| s.entry.clone())
        })?
        .ok_or_else(|| not_found(format!("unknown session {id}/{name}")))
    }

    // ---- events --------------------------------------------------------

    fn emit_now(&self, id: &str) {
        let view = self
            .machines
            .lock()
            .unwrap()
            .iter()
            .find(|m| m.cfg.id == id && !m.removing)
            .map(Machine::view);
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

    /// A state change is emitted at once (the Terminal lens must see every transition);
    /// anything else goes through the throttle.
    fn set_state(&self, id: &str, state: MachineState, error: Option<AppError>) {
        let changed = self
            .with_machine(id, |m| {
                let changed = m.state != state;
                m.state = state;
                m.error = error;
                changed
            })
            .unwrap_or(false);
        self.emit_state(id, changed);
    }

    /// `set_state`, but only while the Machine is still at `epoch`. False when stale.
    fn set_state_at(
        &self,
        id: &str,
        epoch: u64,
        state: MachineState,
        error: Option<AppError>,
    ) -> bool {
        let r = self
            .with_machine(id, |m| {
                if m.epoch != epoch {
                    return None;
                }
                let changed = m.state != state;
                m.state = state;
                m.error = error;
                Some(changed)
            })
            .ok()
            .flatten();
        match r {
            Some(changed) => {
                self.emit_state(id, changed);
                true
            }
            None => false,
        }
    }

    fn emit_state(&self, id: &str, changed: bool) {
        if changed {
            self.emit_now(id);
        } else {
            self.notify(id);
        }
    }

    fn is_current(&self, id: &str, epoch: u64) -> bool {
        self.with_machine(id, |m| m.epoch == epoch).unwrap_or(false)
    }

    fn current(&self, id: &str, epoch: u64) -> Result<(), Fail> {
        if self.is_current(id, epoch) {
            Ok(())
        } else {
            Err(Fail::Stale)
        }
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
            return Err(AppError::new(
                "invalid",
                format!("machine {id} is disabled"),
            ));
        }
        self.cancel_reconnect(id);
        // Captured before waiting: a disconnect while we wait cancels this connect.
        let (gate, epoch) = self.with_machine(id, |m| (m.gate.clone(), m.epoch))?;
        let _g = gate.lock().await;
        if !self.is_current(id, epoch) {
            return Ok(());
        }
        // Reconnecting: stop watchers and release the old sockets first.
        self.teardown(id, false, false).await;
        self.connect_core(&cfg, epoch).await
    }

    /// One connect attempt under the Machine's gate. When the Machine was disconnected or
    /// removed meanwhile (`epoch` moved on), any master this attempt started is ended,
    /// the Machine's state is left alone and the result is `Ok`.
    async fn connect_core(&self, cfg: &MachineConfig, epoch: u64) -> AppResult<()> {
        let id = cfg.id.as_str();
        let ssh = if id != LOCAL && self.factory.lock().unwrap().is_none() {
            Some(self.ssh_for(cfg)?)
        } else {
            None
        };
        match self.connect_inner(cfg, ssh.as_deref(), epoch).await {
            Ok(()) if self.set_state_at(id, epoch, MachineState::Connected, None) => {
                self.start_health(id);
                Ok(())
            }
            Err(Fail::Err(e)) => {
                let state = if e.code == "incompatible" {
                    MachineState::Incompatible
                } else {
                    MachineState::Error
                };
                if self.set_state_at(id, epoch, state, Some(e.clone())) {
                    return Err(e);
                }
                self.abandon(id, ssh.as_deref()).await;
                Ok(())
            }
            Ok(()) | Err(Fail::Stale) => {
                self.abandon(id, ssh.as_deref()).await;
                Ok(())
            }
        }
    }

    /// Undo a stale connect: end the master it may have started and drop what it set up.
    async fn abandon(&self, id: &str, ssh: Option<&SshTransport>) {
        tracing::info!("connect of {id} abandoned: disconnected meanwhile");
        if let Some(s) = ssh {
            self.end_master(s).await;
        }
        let _ = self.with_machine(id, |m| {
            m.abort_supervisors();
            m.sessions.clear();
            m.transport = None;
            m.info = None;
        });
        self.notify(id);
    }

    async fn connect_inner(
        &self,
        cfg: &MachineConfig,
        ssh: Option<&SshTransport>,
        epoch: u64,
    ) -> Result<(), Fail> {
        let id = cfg.id.as_str();
        let transport: Arc<dyn Transport> = match ssh {
            Some(_) => self.ssh_for(cfg)?,
            None => self.make_transport(cfg)?,
        };
        self.with_machine(id, |m| {
            m.transport = Some(transport.clone());
            m.info = None;
        })?;
        if let Some(s) = ssh {
            if !self.set_state_at(id, epoch, MachineState::Authenticating, None) {
                return Err(Fail::Stale);
            }
            let alive = master_alive(&s.ctl, &s.target).await;
            self.current(id, epoch)?;
            if !alive {
                clear_stale_ctl(&s.ctl, &s.target).await;
                self.current(id, epoch)?;
                let seam = self.master_start.lock().unwrap().clone();
                match seam {
                    Some(f) => f().await?,
                    None => start_master(id, &s.ctl, &s.target).await?,
                }
                self.current(id, epoch)?;
            }
            // Whatever the master's history, its forwards are not the cached ones.
            s.forget_forwards();
        }
        if !self.set_state_at(id, epoch, MachineState::Probing, None) {
            return Err(Fail::Stale);
        }
        let out = exec(transport.as_ref(), &probe_argv(cfg.herdr_path.as_deref())).await?;
        self.current(id, epoch)?;
        let info = parse_probe(&out.stdout)?;
        self.with_machine(id, |m| m.info = Some(info))?;
        let list = self.list_sessions(id).await?;
        self.current(id, epoch)?;
        Ok(self.apply_list(id, list)?)
    }

    /// Watch a connected ssh Machine's master so a dead one is noticed even with no
    /// running Session (whose watcher would otherwise notice).
    fn start_health(&self, id: &str) {
        if id == LOCAL {
            return;
        }
        let Some(me) = self.me.upgrade() else { return };
        let h = tokio::spawn(me.health_loop(id.to_string()));
        let _ = self.with_machine(id, |m| {
            if let Some(old) = m.health.replace(h) {
                old.abort();
            }
        });
    }

    async fn health_loop(self: Arc<Self>, id: String) {
        loop {
            let every = *self.health_every.lock().unwrap();
            tokio::time::sleep(every).await;
            if !self.health_ok(&id).await {
                // Spawned: on_master_lost's teardown aborts this task.
                let me = self.clone();
                tokio::spawn(async move { me.on_master_lost(&id).await });
                return;
            }
        }
    }

    async fn health_ok(&self, id: &str) -> bool {
        let seam = self.alive_check.lock().unwrap().clone();
        if let Some(f) = seam {
            return f().await;
        }
        match self.ssh_of(id) {
            Some(s) => master_alive(&s.ctl, &s.target).await,
            None => true, // a test transport: nothing to check
        }
    }

    /// Stop watchers, close terminals and release forwarded sockets. `clear` also forgets the Sessions.
    /// `close_all` also closes Machine-level terminals (the interactive ssh master);
    /// a connect must not kill the master the user just authenticated.
    async fn teardown(&self, id: &str, clear: bool, close_all: bool) {
        let released = self
            .with_machine(id, |m| {
                m.abort_supervisors();
                if let Some(h) = m.health.take() {
                    h.abort();
                }
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
            if close_all {
                a.close_machine(id);
            } else {
                a.close_machine_sessions(id);
            }
        }
        if let Some((Some(t), entries)) = released {
            // Every Session, running or not: one that stopped outside the app may still hold a forward.
            for e in entries {
                if let Err(err) = t.release_socket(&e).await {
                    tracing::warn!("release_socket {id}/{}: {err}", e.name);
                }
            }
        }
    }

    /// Explicit disconnect: forgets the Sessions and, for ssh, ends the master.
    /// Bumps the epoch first, so a connect in flight abandons itself (and its master).
    pub async fn disconnect(&self, id: &str) {
        let _ = self.with_machine(id, |m| m.epoch += 1);
        self.cancel_reconnect(id);
        self.teardown(id, true, true).await;
        if let Some(c) = self.chats.lock().unwrap().clone() {
            c.close_machine(id);
        }
        if let Some(s) = self.ssh_of(id) {
            self.end_master(&s).await;
        }
        self.set_state(id, MachineState::Disconnected, None);
    }

    /// Connect every enabled ssh Machine concurrently (app start). Batch mode only: one
    /// that needs a password or passphrase ends in `ssh_auth` and offers Connect….
    pub async fn connect_enabled_ssh(self: &Arc<Self>) {
        let ids: Vec<String> = self
            .machines
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.cfg.id != LOCAL && m.cfg.enabled)
            .map(|m| m.cfg.id.clone())
            .collect();
        let tasks: Vec<_> = ids
            .into_iter()
            .map(|id| {
                let me = self.clone();
                tokio::spawn(async move {
                    if let Err(e) = me.connect(&id).await {
                        tracing::warn!("connect {id} at startup: {e}");
                    }
                })
            })
            .collect();
        for t in tasks {
            let _ = t.await;
        }
    }

    /// Disconnect every ssh Machine (app exit).
    pub async fn disconnect_all_ssh(&self) {
        let ids: Vec<String> = self
            .machines
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m.cfg.id != LOCAL)
            .map(|m| m.cfg.id.clone())
            .collect();
        for id in ids {
            self.disconnect(&id).await;
        }
    }

    /// The ssh master died under a connected Machine: grey it out, keep its last
    /// snapshot, close its terminals, and retry with backoff.
    pub(crate) async fn on_master_lost(&self, id: &str) {
        let go = self
            .with_machine(id, |m| {
                if m.state == MachineState::Disconnected
                    || m.reconnect.as_ref().is_some_and(|h| !h.is_finished())
                {
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
        self.teardown(id, false, false).await;
        self.emit_now(id);
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
            let Ok((cfg, gate, epoch)) =
                self.with_machine(&id, |m| (m.cfg.clone(), m.gate.clone(), m.epoch))
            else {
                return;
            };
            let _g = gate.lock().await;
            match self.connect_core(&cfg, epoch).await {
                Ok(()) => return,
                Err(e)
                    if matches!(
                        e.code.as_str(),
                        "ssh_auth" | "incompatible" | "herdr_not_found"
                    ) =>
                {
                    return
                }
                Err(e) => self.set_state(&id, MachineState::Disconnected, Some(e)),
            }
        }
    }

    // ---- registry ------------------------------------------------------

    pub async fn add(
        &self,
        ssh_target: String,
        label: Option<String>,
        herdr_path: Option<String>,
    ) -> AppResult<MachineView> {
        let target = ssh_target.trim().to_string();
        if target.is_empty()
            || target.starts_with('-')
            || target.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(AppError::new(
                "invalid",
                format!("invalid ssh target {ssh_target:?}"),
            ));
        }
        let label = label
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| target.clone());
        let herdr_path = herdr_path
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
        let id = {
            let mut ms = self.machines.lock().unwrap();
            let taken: Vec<String> = ms.iter().map(|m| m.cfg.id.clone()).collect();
            let id = slug(&label, &taken);
            ms.push(Machine::new(MachineConfig {
                id: id.clone(),
                label,
                ssh_target: target,
                herdr_path,
                enabled: true,
            }));
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
            return Err(AppError::new(
                "invalid",
                "the local machine cannot be removed",
            ));
        }
        // From here on nothing about this Machine reaches the UI (no ghost row).
        self.with_machine(id, |m| m.removing = true)?;
        self.disconnect(id).await;
        // Wait out a connect in flight: it abandons itself and ends its master through the
        // control socket, which must still exist when it does.
        let gate = self.with_machine(id, |m| m.gate.clone())?;
        let _g = gate.lock().await;
        if let Some(s) = self.ssh_of(id) {
            let _ = std::fs::remove_file(&s.ctl);
        }
        sweep_sockets(id);
        self.machines.lock().unwrap().retain(|m| m.cfg.id != id);
        self.throttle.lock().unwrap().remove(id);
        self.persist()
    }

    /// Set the herdr path override, persist it and reconnect.
    pub async fn update(&self, id: &str, herdr_path: Option<String>) -> AppResult<MachineView> {
        if id == LOCAL {
            return Err(AppError::new(
                "invalid",
                "the local machine has no settings to update",
            ));
        }
        let herdr_path = herdr_path
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty());
        self.with_machine(id, |m| m.cfg.herdr_path = herdr_path)?;
        self.persist()?;
        // A failed connect is reported through the Machine's state and error.
        let _ = self.connect(id).await;
        self.with_machine(id, |m| m.view())
    }

    // ---- sessions ------------------------------------------------------

    async fn list_sessions(&self, id: &str) -> AppResult<Vec<SessionEntry>> {
        let (info, t) = (self.info(id)?, self.transport(id)?);
        let out = exec(
            t.as_ref(),
            &herdr_argv(&info, "default", &["session", "list"]),
        )
        .await?;
        if out.status != 0 {
            return Err(AppError::new(
                "herdr_error",
                format!("session list failed: {}", out.stderr.trim()),
            ));
        }
        Ok(parse_session_list(&out.stdout))
    }

    /// Reconcile the Machine's sessions with `list`; start watchers for newly running ones.
    fn apply_list(&self, id: &str, list: Vec<SessionEntry>) -> AppResult<()> {
        self.with_machine(id, |m| {
            let Some(transport) = m.transport.clone() else {
                return;
            };
            let mut old: Vec<Sess> = std::mem::take(&mut m.sessions);
            let mut next = Vec::new();
            for entry in list {
                let mut s = match old.iter().position(|s| s.entry.name == entry.name) {
                    Some(i) => old.remove(i),
                    None => Sess {
                        entry: entry.clone(),
                        view: None,
                        error: None,
                        supervisor: None,
                        refetch: Arc::default(),
                    },
                };
                s.entry = entry;
                if s.entry.running {
                    if s.supervisor.is_none() {
                        if let Some(me) = self.me.upgrade() {
                            let (id, name) = (m.cfg.id.clone(), s.entry.name.clone());
                            s.supervisor = Some(tokio::spawn(me.supervise(
                                id,
                                name,
                                transport.clone(),
                                s.refetch.clone(),
                            )));
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
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    }

    pub async fn start_session(&self, id: &str, name: &str) -> AppResult<()> {
        if !Self::valid_session_name(name) {
            return Err(AppError::new(
                "invalid",
                format!("invalid session name {name:?}"),
            ));
        }
        let (info, t) = (self.info(id)?, self.transport(id)?);
        let mut argv: Vec<String> = ["sh", "-c", r#"nohup "$@" >/dev/null 2>&1 &"#, "herdr-start"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        argv.extend(herdr_argv(&info, name, &["server"]));
        let out = exec(t.as_ref(), &argv).await?;
        if out.status != 0 {
            return Err(AppError::new(
                "herdr_error",
                format!("could not start {name}: {}", out.stderr.trim()),
            ));
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
                return Err(last_err.unwrap_or_else(|| {
                    AppError::new(
                        "timeout",
                        format!(
                            "session {name} did not start within {}s",
                            START_WAIT.as_secs()
                        ),
                    )
                }));
            }
            tokio::time::sleep(START_POLL).await;
        }
        self.refresh_sessions(id).await
    }

    /// One poll of `start_session`: is `name` listed running and answering a snapshot?
    async fn probe_started(&self, id: &str, name: &str, t: &dyn Transport) -> AppResult<bool> {
        let Some(entry) = self
            .list_sessions(id)
            .await?
            .into_iter()
            .find(|e| e.name == name && e.running)
        else {
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

    pub async fn call(
        &self,
        pane_machine: &str,
        session: &str,
        method: &str,
        params: Value,
    ) -> AppResult<Value> {
        if !ALLOWED_METHODS.contains(&method) {
            return Err(AppError::new(
                "invalid",
                format!("method {method} is not allowed"),
            ));
        }
        let entry = self.session(pane_machine, session)?;
        let socket = self.transport(pane_machine)?.local_socket(&entry).await?;
        let result = rpc::call(&socket, method, params).await?;
        if method == "pane.rename" {
            // herdr reports a rename only as `pane.updated`, which the watcher does not subscribe to.
            let _ = self.with_machine(pane_machine, |m| {
                if let Some(s) = m.sessions.iter().find(|s| s.entry.name == session) {
                    s.refetch.notify_one();
                }
            });
        }
        Ok(result)
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
    async fn supervise(
        self: Arc<Self>,
        id: String,
        name: String,
        transport: Arc<dyn Transport>,
        refetch: Arc<tokio::sync::Notify>,
    ) {
        let mut attempt = 0u32;
        loop {
            let Ok(entry) = self.session(&id, &name) else {
                return;
            };
            let mut got_view = false;
            let err = match transport.local_socket(&entry).await {
                Err(e) => e,
                Ok(socket) => {
                    let (tx, mut rx) = mpsc::unbounded_channel();
                    let _guard =
                        AbortOnDrop(spawn_watcher(name.clone(), socket, tx, refetch.clone()));
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
                            WatchEvent::Status {
                                pane_id,
                                status,
                                previous,
                                title,
                            } => {
                                (self.emit)(UiEvent::PaneStatus(PaneStatusEvent {
                                    pane: PaneRef {
                                        machine_id: id.clone(),
                                        session: name.clone(),
                                        pane_id,
                                    },
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
            let err = if !got_view {
                self.forward_refusal(&id, err)
            } else {
                err
            };
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
    use crate::{
        herdr::fake::FakeHerdr,
        transport::{local::LocalTransport, Transport},
    };
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn registry_roundtrip_and_corrupt_file() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("machines.json");
        assert!(load_registry(&p).is_empty());
        let list = vec![MachineConfig {
            id: "devtuf".into(),
            label: "devtuf".into(),
            ssh_target: "devtuf".into(),
            herdr_path: None,
            enabled: true,
        }];
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
    struct FakeT {
        sock: String,
    }
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
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            Ok(s.socket.clone().into())
        }
        async fn release_socket(&self, _: &SessionEntry) -> AppResult<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn connects_local_and_emits_views() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let events: Arc<Mutex<Vec<MachineView>>> = Arc::default();
        let ev = events.clone();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(
            d.path().join("m.json"),
            Arc::new(move |e| {
                if let UiEvent::Machine(v) = e {
                    ev.lock().unwrap().push(v)
                }
            }),
        );
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let v = mgr.views().into_iter().find(|v| v.id == "local").unwrap();
        assert_eq!(v.state, MachineState::Connected);
        assert_eq!(v.version.as_deref(), Some("0.9.3"));
        assert_eq!(
            v.sessions
                .iter()
                .map(|s| (s.name.as_str(), s.running))
                .collect::<Vec<_>>(),
            [("default", true), ("old", false)]
        );
        assert_eq!(v.sessions[0].workspaces.len(), 2);
        assert_eq!(v.status, crate::herdr::types::AgentStatus::Blocked);
        assert!(!events.lock().unwrap().is_empty());
        assert_eq!(
            mgr.call("local", "default", "server.stop", json!({}))
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
        mgr.call("local", "default", "pane.close", json!({"pane_id":"w1:p2"}))
            .await
            .unwrap();
        assert_eq!(f.calls_of("pane.close"), 1);
        let _ = LocalTransport; // default factory type exists
    }

    struct RecT {
        inner: FakeT,
        released: Arc<Mutex<Vec<String>>>,
    }
    #[async_trait::async_trait]
    impl Transport for RecT {
        fn wrap(&self, argv: &[String], tty: bool) -> Vec<String> {
            self.inner.wrap(argv, tty)
        }
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            self.inner.local_socket(s).await
        }
        async fn release_socket(&self, s: &SessionEntry) -> AppResult<()> {
            self.released.lock().unwrap().push(s.name.clone());
            Ok(())
        }
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
        let v = mgr
            .add("cuong@devtuf.lan".into(), Some("Dev Tuf".into()), None)
            .await
            .unwrap();
        assert_eq!(
            (v.id.as_str(), v.kind.as_str(), v.state.clone()),
            ("dev-tuf", "ssh", MachineState::Disconnected)
        );
        assert_eq!(load_registry(&p)[0].ssh_target, "cuong@devtuf.lan");
        mgr.remove("dev-tuf").await.unwrap();
        assert!(load_registry(&p).is_empty());
        assert!(mgr.views().iter().all(|m| m.id != "dev-tuf"));
    }
    #[tokio::test]
    async fn add_rejects_option_like_targets() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        assert_eq!(
            mgr.add("-oProxyCommand=x".into(), None, None)
                .await
                .unwrap_err()
                .code,
            "invalid"
        );
        assert_eq!(
            mgr.add("  ".into(), None, None).await.unwrap_err().code,
            "invalid"
        );
    }

    async fn wait_for(mut cond: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if cond() {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test]
    async fn forward_refusal_marks_the_session() {
        // sshd refuses the forward: the local socket accepts, then closes with no frame.
        let d = tempfile::Builder::new()
            .prefix("hr")
            .tempdir_in("/tmp")
            .unwrap();
        let sock = d.path().join("x.sock");
        let l = tokio::net::UnixListener::bind(&sock).unwrap();
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                drop(s);
            }
        });
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let s = sock.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: s.clone() }) as Arc<dyn Transport>
        }));
        mgr.add("box".into(), None, None).await.unwrap();
        mgr.connect("box").await.unwrap();
        let m = mgr.clone();
        assert!(
            wait_for(
                move || m.views().iter().find(|v| v.id == "box").unwrap().sessions[0]
                    .error
                    .as_ref()
                    .is_some_and(|e| e.code == "ssh_forward_denied")
            )
            .await
        );
        mgr.disconnect("box").await;
    }

    #[tokio::test]
    async fn dropped_connection_keeps_last_snapshot_and_closes_terminals() {
        use crate::attach::{AttachEvent, AttachKey, AttachManager, Sink};
        struct Rec(Arc<Mutex<Vec<AttachEvent>>>);
        impl Sink for Rec {
            fn data(&self, _: Vec<u8>) {}
            fn event(&self, e: AttachEvent) {
                self.0.lock().unwrap().push(e);
            }
        }
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        let att = AttachManager::new(std::time::Duration::from_secs(15));
        mgr.set_attach_manager(att.clone());
        mgr.add("box".into(), None, None).await.unwrap();
        mgr.connect("box").await.unwrap();
        let m = mgr.clone();
        assert!(
            wait_for(
                move || !m.views().iter().find(|v| v.id == "box").unwrap().sessions[0]
                    .workspaces
                    .is_empty()
            )
            .await
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        att.open(
            AttachKey {
                machine_id: "box".into(),
                session: "default".into(),
                terminal_id: "t".into(),
            },
            vec!["cat".into()],
            80,
            24,
            Arc::new(Rec(events.clone())),
        )
        .unwrap();

        mgr.on_master_lost("box").await;
        let v = mgr.views().into_iter().find(|v| v.id == "box").unwrap();
        assert_eq!(v.state, MachineState::Disconnected);
        assert_eq!(v.sessions.len(), 2);
        assert!(
            !v.sessions[0].workspaces.is_empty(),
            "last snapshot is kept"
        );
        assert!(wait_for(|| events.lock().unwrap().contains(&AttachEvent::Detached)).await);
        // An explicit disconnect clears it.
        mgr.disconnect("box").await;
        assert!(mgr
            .views()
            .into_iter()
            .find(|v| v.id == "box")
            .unwrap()
            .sessions
            .is_empty());
    }

    /// `session list` fails on calls 1..=3 (call 0 is the connect); start_session must keep polling.
    struct FlakyT {
        inner: FakeT,
        lists: std::sync::atomic::AtomicU32,
    }
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
        async fn local_socket(&self, s: &SessionEntry) -> AppResult<PathBuf> {
            self.inner.local_socket(s).await
        }
        async fn release_socket(&self, s: &SessionEntry) -> AppResult<()> {
            self.inner.release_socket(s).await
        }
    }

    #[tokio::test]
    async fn start_session_polls_through_transient_errors() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FlakyT {
                inner: FakeT { sock: sock.clone() },
                lists: Default::default(),
            }) as Arc<dyn Transport>
        }));
        // Initial connect would hit the failing list; the first call (count 0) passes.
        mgr.connect("local").await.unwrap();
        mgr.start_session("local", "default").await.unwrap();
    }

    #[tokio::test]
    async fn disconnect_releases_sessions_stopped_outside_the_app() {
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({"type":"ok"}))));
        let released: Arc<Mutex<Vec<String>>> = Arc::default();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (sock, rel) = (f.path.to_string_lossy().to_string(), released.clone());
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(RecT {
                inner: FakeT { sock: sock.clone() },
                released: rel.clone(),
            }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap(); // lists `old` as stopped
        mgr.disconnect("local").await;
        assert!(
            released.lock().unwrap().contains(&"old".to_string()),
            "{:?}",
            released.lock().unwrap()
        );
    }

    #[tokio::test]
    async fn connect_spares_the_ssh_master_terminal() {
        use crate::attach::{AttachEvent, AttachKey, AttachManager, Sink};
        struct Rec(Arc<Mutex<Vec<AttachEvent>>>);
        impl Sink for Rec {
            fn data(&self, _: Vec<u8>) {}
            fn event(&self, e: AttachEvent) {
                self.0.lock().unwrap().push(e);
            }
        }
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({"type":"ok"}))));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        let att = AttachManager::new(std::time::Duration::from_secs(15));
        mgr.set_attach_manager(att.clone());
        mgr.add("box".into(), None, None).await.unwrap();
        let (master_ev, term_ev) = (
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        let mk = |session: &str, terminal: &str| AttachKey {
            machine_id: "box".into(),
            session: session.into(),
            terminal_id: terminal.into(),
        };
        att.open(
            mk("", "ssh-master"),
            vec!["sh".into(), "-c".into(), "sleep 5".into()],
            80,
            24,
            Arc::new(Rec(master_ev.clone())),
        )
        .unwrap();
        att.open(
            mk("default", "t"),
            vec!["cat".into()],
            80,
            24,
            Arc::new(Rec(term_ev.clone())),
        )
        .unwrap();
        mgr.connect("box").await.unwrap();
        assert!(wait_for(|| term_ev.lock().unwrap().contains(&AttachEvent::Detached)).await);
        assert!(!master_ev.lock().unwrap().contains(&AttachEvent::Detached));
        att.write(&mk("", "ssh-master"), b"x").unwrap();
        mgr.disconnect("box").await; // an explicit disconnect closes everything
        assert!(wait_for(|| master_ev.lock().unwrap().contains(&AttachEvent::Detached)).await);
    }

    fn counting_master(
        calls: Arc<std::sync::atomic::AtomicU32>,
        code: &'static str,
    ) -> MasterStart {
        Arc::new(move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move { Err(AppError::new(code, "boom")) })
        })
    }

    #[tokio::test]
    async fn retries_stop_on_ssh_auth_failure() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let calls: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        mgr.with_master_start(counting_master(calls.clone(), "ssh_auth"));
        mgr.add("retry-auth".into(), None, None).await.unwrap();
        assert_eq!(
            mgr.connect("retry-auth").await.unwrap_err().code,
            "ssh_auth"
        );
        mgr.on_master_lost("retry-auth").await;
        tokio::time::sleep(std::time::Duration::from_millis(3500)).await;
        // connect + exactly one retry (after 1 s); the 2 s retry never happens.
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        let v = mgr
            .views()
            .into_iter()
            .find(|v| v.id == "retry-auth")
            .unwrap();
        assert_eq!(
            (v.state, v.error.map(|e| e.code)),
            (MachineState::Error, Some("ssh_auth".to_string()))
        );
        mgr.remove("retry-auth").await.unwrap();
    }

    #[tokio::test]
    async fn cancel_reconnect_stops_the_loop() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let calls: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        mgr.with_master_start(counting_master(calls.clone(), "io"));
        mgr.add("retry-cancel".into(), None, None).await.unwrap();
        assert!(mgr.connect("retry-cancel").await.is_err());
        mgr.on_master_lost("retry-cancel").await;
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "an io failure keeps retrying"
        );
        mgr.cancel_reconnect("retry-cancel");
        tokio::time::sleep(std::time::Duration::from_millis(2600)).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        mgr.remove("retry-cancel").await.unwrap();
    }

    /// A master start that takes `ms` and then succeeds, flagging `started` when done.
    fn slow_master(ms: u64, started: Arc<std::sync::atomic::AtomicBool>) -> MasterStart {
        Arc::new(move || {
            let started = started.clone();
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                started.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
        })
    }

    /// Records, per master-exit call, whether the slow master start had finished by then.
    fn recording_exit(
        started: Arc<std::sync::atomic::AtomicBool>,
        log: Arc<Mutex<Vec<bool>>>,
    ) -> MasterExit {
        Arc::new(move || {
            log.lock()
                .unwrap()
                .push(started.load(std::sync::atomic::Ordering::SeqCst))
        })
    }

    #[tokio::test]
    async fn disconnect_during_connect_ends_the_new_master() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (started, exits) = (
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Arc::new(Mutex::new(Vec::new())),
        );
        mgr.with_master_start(slow_master(400, started.clone()));
        mgr.with_master_exit(recording_exit(started.clone(), exits.clone()));
        mgr.add("i1-disc".into(), None, None).await.unwrap();
        let m = mgr.clone();
        let connect = tokio::spawn(async move { m.connect("i1-disc").await });
        let m = mgr.clone();
        assert!(
            wait_for(move || m
                .views()
                .iter()
                .any(|v| v.id == "i1-disc" && v.state == MachineState::Authenticating))
            .await
        );
        mgr.disconnect("i1-disc").await;
        connect.await.unwrap().unwrap();
        assert!(started.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            exits.lock().unwrap().contains(&true),
            "the master started after the disconnect is ended: {:?}",
            exits.lock().unwrap()
        );
        let v = mgr.views().into_iter().find(|v| v.id == "i1-disc").unwrap();
        assert_eq!((v.state, v.error), (MachineState::Disconnected, None));
        assert!(mgr.transport("i1-disc").is_err());
        mgr.remove("i1-disc").await.unwrap();
    }

    #[tokio::test]
    async fn remove_during_connect_ends_the_new_master() {
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (started, exits) = (
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Arc::new(Mutex::new(Vec::new())),
        );
        mgr.with_master_start(slow_master(400, started.clone()));
        mgr.with_master_exit(recording_exit(started.clone(), exits.clone()));
        mgr.add("i1-remove".into(), None, None).await.unwrap();
        let m = mgr.clone();
        let connect = tokio::spawn(async move { m.connect("i1-remove").await });
        let m = mgr.clone();
        assert!(
            wait_for(move || m
                .views()
                .iter()
                .any(|v| v.id == "i1-remove" && v.state == MachineState::Authenticating))
            .await
        );
        mgr.remove("i1-remove").await.unwrap();
        connect.await.unwrap().unwrap();
        assert!(
            exits.lock().unwrap().contains(&true),
            "{:?}",
            exits.lock().unwrap()
        );
        assert!(mgr.views().iter().all(|v| v.id != "i1-remove"));
    }

    fn alive_seam(alive: bool, calls: Arc<std::sync::atomic::AtomicU32>) -> AliveCheck {
        Arc::new(move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move { alive })
        })
    }

    #[tokio::test]
    async fn health_task_notices_a_dead_master_without_sessions() {
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({"type":"ok"}))));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        let calls: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        mgr.with_health_check(
            std::time::Duration::from_millis(50),
            alive_seam(false, calls.clone()),
        );
        mgr.add("health-dead".into(), None, None).await.unwrap();
        mgr.connect("health-dead").await.unwrap();
        let m = mgr.clone();
        assert!(
            wait_for(move || m
                .views()
                .iter()
                .any(|v| v.id == "health-dead" && v.state == MachineState::Disconnected))
            .await
        );
        mgr.disconnect("health-dead").await;
    }

    #[tokio::test]
    async fn health_task_stops_on_disconnect() {
        let f = FakeHerdr::start(Arc::new(|_, _| Ok(json!({"type":"ok"}))));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        let calls: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        mgr.with_health_check(
            std::time::Duration::from_millis(50),
            alive_seam(true, calls.clone()),
        );
        mgr.add("health-ok".into(), None, None).await.unwrap();
        mgr.connect("health-ok").await.unwrap();
        let c = calls.clone();
        assert!(wait_for(move || c.load(std::sync::atomic::Ordering::SeqCst) >= 2).await);
        assert_eq!(
            mgr.views()
                .into_iter()
                .find(|v| v.id == "health-ok")
                .unwrap()
                .state,
            MachineState::Connected
        );
        mgr.disconnect("health-ok").await;
        let n = calls.load(std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), n);
        // The local Machine gets no health task.
        mgr.connect("local").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), n);
    }

    #[tokio::test]
    async fn state_changes_bypass_the_throttle() {
        let states: Arc<Mutex<Vec<MachineState>>> = Arc::default();
        let st = states.clone();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(
            d.path().join("m.json"),
            Arc::new(move |e| {
                if let UiEvent::Machine(v) = e {
                    st.lock().unwrap().push(v.state)
                }
            }),
        );
        mgr.set_state("local", MachineState::Authenticating, None);
        mgr.set_state("local", MachineState::Probing, None);
        mgr.set_state("local", MachineState::Connected, None);
        assert_eq!(
            *states.lock().unwrap(),
            [
                MachineState::Authenticating,
                MachineState::Probing,
                MachineState::Connected
            ]
        );
    }

    #[tokio::test]
    async fn remove_emits_nothing_for_the_removed_machine() {
        let ids: Arc<Mutex<Vec<String>>> = Arc::default();
        let rec = ids.clone();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(
            d.path().join("m.json"),
            Arc::new(move |e| {
                if let UiEvent::Machine(v) = e {
                    rec.lock().unwrap().push(v.id)
                }
            }),
        );
        mgr.add("ghost".into(), None, None).await.unwrap();
        ids.lock().unwrap().clear();
        mgr.remove("ghost").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(250)).await; // past any trailing emit
        assert!(
            !ids.lock().unwrap().contains(&"ghost".to_string()),
            "{:?}",
            ids.lock().unwrap()
        );
    }

    #[tokio::test]
    async fn startup_connects_every_enabled_ssh_machine() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("m.json");
        let cfg = |id: &str, enabled| MachineConfig {
            id: id.into(),
            label: id.into(),
            ssh_target: id.into(),
            herdr_path: None,
            enabled,
        };
        save_registry(
            &p,
            &[cfg("i9-a", true), cfg("i9-b", true), cfg("i9-off", false)],
        )
        .unwrap();
        let mgr = MachineManager::new(p, Arc::new(|_| {}));
        let calls: Arc<std::sync::atomic::AtomicU32> = Arc::default();
        mgr.with_master_start(counting_master(calls.clone(), "ssh_auth"));
        mgr.connect_enabled_ssh().await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        let views = mgr.views();
        let state = |id: &str| {
            views
                .iter()
                .find(|v| v.id == id)
                .map(|v| (v.state, v.error.as_ref().map(|e| e.code.clone())))
        };
        assert_eq!(
            state("i9-a"),
            Some((MachineState::Error, Some("ssh_auth".into())))
        );
        assert_eq!(state("i9-off"), Some((MachineState::Disconnected, None)));
        assert_eq!(
            state("local"),
            Some((MachineState::Disconnected, None)),
            "local is connected separately"
        );
    }

    #[tokio::test]
    async fn pane_rename_refetches_the_session() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let sock = f.path.to_string_lossy().to_string();
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(FakeT { sock: sock.clone() }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        assert!(wait_for(|| f.calls_of("events.subscribe") >= 1).await);
        let before = f.calls_of("session.snapshot");
        mgr.call("local", "default", "pane.close", json!({"pane_id":"w1:p2"}))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(
            f.calls_of("session.snapshot"),
            before,
            "other calls do not refetch"
        );
        mgr.call(
            "local",
            "default",
            "pane.rename",
            json!({"pane_id":"w1:p1","label":"x"}),
        )
        .await
        .unwrap();
        assert!(wait_for(|| f.calls_of("session.snapshot") > before).await);
    }

    #[tokio::test]
    async fn disconnect_closes_the_machines_chats() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("t.jsonl");
        std::fs::write(&p, "").unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let chats = Arc::new(ChatManager::default());
        mgr.set_chat_manager(chats.clone());
        let pane = PaneRef {
            machine_id: "local".into(),
            session: "default".into(),
            pane_id: "w1:p1".into(),
        };
        let parser = crate::transcript::parser_for("claude").unwrap();
        chats.insert(
            pane.clone(),
            crate::transcript::spawn_tail(
                Arc::new(LocalTransport),
                p.to_string_lossy().into(),
                parser,
                Arc::new(|_| {}),
            ),
        );
        assert!(chats.page(&pane, 0, 1).is_some());
        mgr.disconnect("local").await;
        assert!(chats.page(&pane, 0, 1).is_none());
    }

    #[tokio::test]
    async fn reconnect_releases_old_sockets() {
        let snap: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/snapshot.json")).unwrap();
        let f = FakeHerdr::start(Arc::new(move |m, _| {
            if m == "session.snapshot" {
                Ok(json!({"type":"session_snapshot","snapshot": snap.clone()}))
            } else {
                Ok(json!({"type":"ok"}))
            }
        }));
        let released: Arc<Mutex<Vec<String>>> = Arc::default();
        let d = tempfile::tempdir().unwrap();
        let mgr = MachineManager::new(d.path().join("m.json"), Arc::new(|_| {}));
        let (sock, rel) = (f.path.to_string_lossy().to_string(), released.clone());
        mgr.with_transport_factory(Arc::new(move |_| {
            Arc::new(RecT {
                inner: FakeT { sock: sock.clone() },
                released: rel.clone(),
            }) as Arc<dyn Transport>
        }));
        mgr.connect("local").await.unwrap();
        assert!(released.lock().unwrap().is_empty());
        mgr.connect("local").await.unwrap();
        assert!(
            released.lock().unwrap().contains(&"default".to_string()),
            "{:?}",
            released.lock().unwrap()
        );
        assert_eq!(mgr.views()[0].state, MachineState::Connected);
    }
}
