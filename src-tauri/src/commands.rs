//! Tauri commands: thin wrappers over `MachineManager`.
use crate::{
    attach::{attach_argv, AttachEvent, AttachKey, AttachManager, Sink},
    complete::{self, SlashCommand},
    error::AppError,
    herdr::rpc,
    layout::LayoutStore,
    machines::MachineManager,
    sshconfig,
    transcript::{self, ChatEvent, ChatItem, ChatManager, Located},
    transport::{self, ssh::master_argv},
    view::{MachineView, PaneRef, PaneView},
};
use serde_json::Value;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

type Mgr<'a> = State<'a, Arc<MachineManager>>;

#[tauri::command]
pub async fn machines_list(mgr: Mgr<'_>) -> Result<Vec<MachineView>, AppError> {
    Ok(mgr.views())
}

#[tauri::command]
pub async fn machine_connect(mgr: Mgr<'_>, id: String) -> Result<(), AppError> {
    mgr.connect(&id).await
}

#[tauri::command]
pub async fn machine_disconnect(mgr: Mgr<'_>, id: String) -> Result<(), AppError> {
    mgr.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn machine_add(
    mgr: Mgr<'_>,
    ssh_target: String,
    label: Option<String>,
    herdr_path: Option<String>,
) -> Result<MachineView, AppError> {
    mgr.add(ssh_target, label, herdr_path).await
}

#[tauri::command]
pub async fn machine_remove(mgr: Mgr<'_>, id: String) -> Result<(), AppError> {
    mgr.remove(&id).await
}

#[tauri::command]
pub async fn machine_update(
    mgr: Mgr<'_>,
    id: String,
    herdr_path: Option<String>,
) -> Result<MachineView, AppError> {
    mgr.update(&id, herdr_path).await
}

#[tauri::command]
pub async fn machine_master_alive(mgr: Mgr<'_>, id: String) -> Result<bool, AppError> {
    Ok(mgr.master_alive(&id).await)
}

#[tauri::command]
pub async fn ssh_hosts() -> Result<Vec<String>, AppError> {
    Ok(sshconfig::read_hosts())
}

#[tauri::command]
pub async fn sessions_refresh(mgr: Mgr<'_>, machine_id: String) -> Result<(), AppError> {
    mgr.refresh_sessions(&machine_id).await
}

#[tauri::command]
pub async fn session_start(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
) -> Result<(), AppError> {
    mgr.start_session(&machine_id, &session).await
}

#[tauri::command]
pub async fn session_delete(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
) -> Result<(), AppError> {
    mgr.delete_session(&machine_id, &session).await
}

#[tauri::command]
pub async fn session_stop(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
) -> Result<(), AppError> {
    mgr.stop_session(&machine_id, &session).await
}

#[tauri::command]
pub async fn herdr_call(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
    method: String,
    params: Value,
) -> Result<Value, AppError> {
    mgr.call(&machine_id, &session, &method, params).await
}

/// Shows a desktop notification for `pane`; clicking it emits `notify://activate`.
#[tauri::command]
pub fn notify_pane(
    app: tauri::AppHandle,
    pane: crate::view::PaneRef,
    title: String,
    body: String,
) -> Result<(), AppError> {
    crate::notify::show(&app, pane, title, body)
}

/// Saves a pasted image on the Machine and returns its path there. The body is the raw
/// image bytes; `x-machine-id` and `x-image-ext` headers name the Machine and file type.
#[tauri::command]
pub async fn image_save_temp(
    mgr: Mgr<'_>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, AppError> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| AppError::new("invalid", format!("missing {name} header")))
    };
    let (machine_id, ext) = (header("x-machine-id")?, header("x-image-ext")?);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new("invalid", "expected raw image bytes"));
    };
    let t = mgr.transport(&machine_id)?;
    transport::save_image_in(t.as_ref(), bytes, &ext, None).await
}

type Att<'a> = State<'a, Arc<AttachManager>>;

/// Forwards PTY output and attach events to the UI over Tauri channels.
struct ChannelSink {
    data: Channel<InvokeResponseBody>,
    events: Channel<AttachEvent>,
    /// ssh's own failure code (255) means the connection dropped, not that herdr exited.
    ssh: bool,
}

impl Sink for ChannelSink {
    fn data(&self, bytes: Vec<u8>) {
        if let Err(e) = self.data.send(InvokeResponseBody::Raw(bytes)) {
            tracing::warn!("terminal data send failed: {e}");
        }
    }
    fn event(&self, e: AttachEvent) {
        let e = match e {
            AttachEvent::Exited { code: Some(255) } if self.ssh => AttachEvent::Detached,
            other => other,
        };
        if let Err(err) = self.events.send(e) {
            tracing::warn!("terminal event send failed: {err}");
        }
    }
}

/// The interactive ssh master's PTY: output and events go to the Connect dialog, and a
/// clean exit (`ssh -f` backgrounded after authenticating) connects the Machine.
struct MasterSink {
    inner: ChannelSink,
    mgr: Arc<MachineManager>,
    machine_id: String,
}

impl Sink for MasterSink {
    fn data(&self, bytes: Vec<u8>) {
        self.inner.data(bytes);
    }
    fn event(&self, e: AttachEvent) {
        if e == (AttachEvent::Exited { code: Some(0) }) {
            let (mgr, id) = (self.mgr.clone(), self.machine_id.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(err) = mgr.connect(&id).await {
                    tracing::warn!("connect {id} after ssh auth: {err}");
                }
            });
        }
        self.inner.event(e);
    }
}

pub const SSH_MASTER_TERMINAL: &str = "ssh-master";

/// Run the interactive (non-batch) ssh master on a PTY for the Connect dialog.
#[tauri::command]
pub async fn connect_open(
    mgr: Mgr<'_>,
    att: Att<'_>,
    machine_id: String,
    cols: u16,
    rows: u16,
    data: Channel<InvokeResponseBody>,
    events: Channel<AttachEvent>,
) -> Result<(), AppError> {
    // The user is authenticating by hand: no automatic retry may race the interactive master.
    mgr.cancel_reconnect(&machine_id);
    let (ctl, target) = mgr.ssh_master(&machine_id)?;
    crate::transport::ssh::clear_stale_ctl(&ctl, &target).await;
    let argv = master_argv(&ctl, &target, false);
    let key = AttachKey {
        machine_id: machine_id.clone(),
        session: String::new(),
        terminal_id: SSH_MASTER_TERMINAL.into(),
    };
    let sink = MasterSink {
        inner: ChannelSink {
            data,
            events,
            ssh: false,
        },
        mgr: Arc::clone(&mgr),
        machine_id,
    };
    att.open(key, argv, cols, rows, Arc::new(sink))
}

fn master_key(machine_id: String) -> AttachKey {
    AttachKey {
        machine_id,
        session: String::new(),
        terminal_id: SSH_MASTER_TERMINAL.into(),
    }
}

#[tauri::command]
pub async fn connect_write(att: Att<'_>, machine_id: String, data: String) -> Result<(), AppError> {
    att.inner()
        .write_async(master_key(machine_id), data.into_bytes())
        .await
}

#[tauri::command]
pub async fn connect_resize(
    att: Att<'_>,
    machine_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    att.resize(&master_key(machine_id), cols, rows)
}

#[tauri::command]
pub async fn connect_close(att: Att<'_>, machine_id: String) -> Result<(), AppError> {
    att.close(&master_key(machine_id));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn term_open(
    mgr: Mgr<'_>,
    att: Att<'_>,
    machine_id: String,
    session: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
    takeover: bool,
    data: Channel<InvokeResponseBody>,
    events: Channel<AttachEvent>,
) -> Result<(), AppError> {
    let info = mgr.info(&machine_id)?;
    let transport = mgr.transport(&machine_id)?;
    let argv = transport.wrap(&attach_argv(&info, &session, &terminal_id, takeover), true);
    let ssh = mgr.is_ssh(&machine_id);
    let key = AttachKey {
        machine_id,
        session,
        terminal_id,
    };
    att.open(
        key,
        argv,
        cols,
        rows,
        Arc::new(ChannelSink { data, events, ssh }),
    )
}

#[tauri::command]
pub async fn term_write(att: Att<'_>, key: AttachKey, data: String) -> Result<(), AppError> {
    att.inner().write_async(key, data.into_bytes()).await
}

#[tauri::command]
pub async fn term_resize(
    att: Att<'_>,
    key: AttachKey,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    att.resize(&key, cols, rows)
}

#[tauri::command]
pub async fn term_ack(att: Att<'_>, key: AttachKey, bytes: usize) -> Result<(), AppError> {
    att.ack(&key, bytes);
    Ok(())
}

#[tauri::command]
pub async fn term_release(att: Att<'_>, key: AttachKey) -> Result<(), AppError> {
    att.release(&key);
    Ok(())
}

#[tauri::command]
pub async fn term_close(att: Att<'_>, key: AttachKey) -> Result<(), AppError> {
    att.close(&key);
    Ok(())
}

type Chats<'a> = State<'a, Arc<ChatManager>>;

const CHAT_PAGE: usize = 200;

fn find_pane(mgr: &MachineManager, r: &PaneRef) -> Result<PaneView, AppError> {
    let views = mgr.views();
    let session = views
        .iter()
        .find(|m| m.id == r.machine_id)
        .and_then(|m| m.sessions.iter().find(|s| s.name == r.session))
        .ok_or_else(|| {
            AppError::new(
                "not_found",
                format!("unknown session {}/{}", r.machine_id, r.session),
            )
        })?;
    session
        .workspaces
        .iter()
        .flat_map(|w| &w.tabs)
        .flat_map(|t| &t.panes)
        .find(|p| p.pane_id == r.pane_id)
        .cloned()
        .ok_or_else(|| AppError::new("not_found", format!("unknown pane {}", r.pane_id)))
}

/// How long to wait for herdr to report a just-started Claude agent's session.
const SESSION_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// The directory the agent in a Pane runs from, which may differ from the shell's cwd (best-effort).
async fn foreground_cwd(mgr: &MachineManager, pane_ref: &PaneRef) -> Option<String> {
    let PaneRef {
        machine_id,
        session,
        pane_id,
    } = pane_ref;
    let transport = mgr.transport(machine_id).ok()?;
    let entry = mgr.session(machine_id, session).ok()?;
    let socket = transport.local_socket(&entry).await.ok()?;
    rpc::snapshot(&socket)
        .await
        .ok()
        .and_then(|s| s.panes.into_iter().find(|p| p.pane_id == *pane_id))
        .and_then(|p| p.foreground_cwd)
}

/// The transcript of the agent in a Pane: `path` when given (the user's choice), else located.
async fn locate_pane(
    mgr: &MachineManager,
    pane_ref: &PaneRef,
    path: Option<String>,
) -> Result<Located, AppError> {
    let PaneRef {
        machine_id,
        session,
        pane_id,
    } = pane_ref;
    let pane = find_pane(mgr, pane_ref)?;
    let transport = mgr.transport(machine_id)?;
    let fetch_agent = || {
        mgr.call(
            machine_id,
            session,
            "agent.get",
            serde_json::json!({ "target": pane_id }),
        )
    };
    let mut agent_get = match fetch_agent().await {
        Ok(v) => v,
        Err(_) if path.is_some() => Value::Null,
        Err(e) => return Err(e),
    };
    // Without its session, a just-started Claude would get another pane's transcript.
    if path.is_none() {
        let deadline = tokio::time::Instant::now() + SESSION_WAIT;
        while transcript::locate::awaiting_session(&agent_get)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            agent_get = fetch_agent().await?;
        }
    }
    Ok(match path {
        Some(p) => Located {
            agent: agent_get["agent"]["agent"]
                .as_str()
                .map(str::to_string)
                .or_else(|| pane.agent.clone())
                .unwrap_or_default(),
            path: p,
            ambiguous: false,
            candidates: Vec::new(),
        },
        None => {
            let info = mgr.info(machine_id)?;
            let fg = foreground_cwd(mgr, pane_ref).await;
            transcript::locate::locate_in(&*transport, &info, &agent_get, &pane, fg.as_deref())
                .await?
        }
    })
}

/// Locates a Pane's transcript without opening it (the Terminal fallback probes with this).
#[tauri::command]
pub async fn chat_locate(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
) -> Result<Located, AppError> {
    let pane_ref = PaneRef {
        machine_id,
        session,
        pane_id,
    };
    locate_pane(&mgr, &pane_ref, None).await
}

/// The Slash commands the Agent in a Pane offers, read on the Pane's Machine.
#[tauri::command]
pub async fn complete_commands(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
) -> Result<Vec<SlashCommand>, AppError> {
    let pane_ref = PaneRef {
        machine_id,
        session,
        pane_id,
    };
    let pane = find_pane(&mgr, &pane_ref)?;
    let agent = pane.agent.clone().unwrap_or_default();
    if agent.is_empty() {
        return Ok(Vec::new());
    }
    let info = mgr.info(&pane_ref.machine_id)?;
    let transport = mgr.transport(&pane_ref.machine_id)?;
    let cwd = foreground_cwd(&mgr, &pane_ref).await.or(pane.cwd);
    complete::list_commands(&*transport, &agent, &info.home, cwd.as_deref()).await
}

/// The files under a Pane's working directory, read on the Pane's Machine.
#[tauri::command]
pub async fn complete_files(
    mgr: Mgr<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
) -> Result<Vec<String>, AppError> {
    let pane_ref = PaneRef {
        machine_id,
        session,
        pane_id,
    };
    let pane = find_pane(&mgr, &pane_ref)?;
    let Some(cwd) = foreground_cwd(&mgr, &pane_ref).await.or(pane.cwd) else {
        return Ok(Vec::new());
    };
    let info = mgr.info(&pane_ref.machine_id)?;
    let transport = mgr.transport(&pane_ref.machine_id)?;
    complete::list_files(&*transport, &info.home, &cwd).await
}

#[tauri::command]
pub async fn chat_open(
    mgr: Mgr<'_>,
    chats: Chats<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
    path: Option<String>,
    events: Channel<ChatEvent>,
) -> Result<Located, AppError> {
    let pane_ref = PaneRef {
        machine_id: machine_id.clone(),
        session,
        pane_id,
    };
    let located = locate_pane(&mgr, &pane_ref, path).await?;
    let transport = mgr.transport(&machine_id)?;
    let parser = transcript::parser_for(&located.agent).ok_or_else(|| {
        AppError::new(
            "not_found",
            format!("no transcript parser for agent '{}'", located.agent),
        )
    })?;
    let sink = Arc::new(move |e: ChatEvent| {
        if let Err(err) = events.send(e) {
            tracing::warn!("chat event send failed: {err}");
        }
    });
    chats.insert(
        pane_ref,
        transcript::spawn_tail(transport, located.path.clone(), parser, sink),
    );
    Ok(located)
}

#[tauri::command]
pub async fn chat_page(
    chats: Chats<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
    before: usize,
) -> Result<Vec<ChatItem>, AppError> {
    chats
        .page(
            &PaneRef {
                machine_id,
                session,
                pane_id,
            },
            before,
            CHAT_PAGE,
        )
        .ok_or_else(|| AppError::new("not_found", "no open chat for this pane"))
}

#[tauri::command]
pub async fn chat_image(
    chats: Chats<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
    r#ref: String,
) -> Result<tauri::ipc::Response, AppError> {
    chats
        .image(
            &PaneRef {
                machine_id,
                session,
                pane_id,
            },
            &r#ref,
        )
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn chat_close(
    chats: Chats<'_>,
    machine_id: String,
    session: String,
    pane_id: String,
) -> Result<(), AppError> {
    chats.close(&PaneRef {
        machine_id,
        session,
        pane_id,
    });
    Ok(())
}

/// Installed monospace font families (empty off macOS).
#[tauri::command]
pub async fn system_fonts() -> Result<Vec<String>, AppError> {
    tokio::task::spawn_blocking(crate::fonts::installed_monospace)
        .await
        .map_err(|e| AppError::new("io", e.to_string()))
}

/// Raw bytes of `family`'s `style` face, for registering it as a web font; `not_found` when
/// the face is missing or the WebView renders it natively (see `fonts::face_file`).
#[tauri::command]
pub async fn font_face(family: String, style: String) -> Result<tauri::ipc::Response, AppError> {
    tokio::task::spawn_blocking(move || {
        let path = crate::fonts::face_file(&family, &style).ok_or_else(|| {
            AppError::new("not_found", format!("no web-loadable {family} {style}"))
        })?;
        std::fs::read(&path)
            .map(tauri::ipc::Response::new)
            .map_err(|e| AppError::new("io", e.to_string()))
    })
    .await
    .map_err(|e| AppError::new("io", e.to_string()))?
}

#[tauri::command]
pub async fn quota_fetch(
    provider: crate::quota::Provider,
) -> Result<crate::quota::QuotaOutcome, AppError> {
    Ok(crate::quota::fetch(provider).await)
}

/// The saved sidebar layout, or `null` when none was saved yet.
#[tauri::command]
pub async fn layout_load(store: State<'_, Arc<LayoutStore>>) -> Result<Option<Value>, AppError> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.load())
        .await
        .map_err(|e| AppError::new("io", e.to_string()))
}

#[tauri::command]
pub async fn layout_save(
    store: State<'_, Arc<LayoutStore>>,
    layout: Value,
) -> Result<(), AppError> {
    let store = store.inner().clone();
    tokio::task::spawn_blocking(move || store.save(&layout))
        .await
        .map_err(|e| AppError::new("io", e.to_string()))?
}
