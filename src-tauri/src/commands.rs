//! Tauri commands: thin wrappers over `MachineManager`.
use crate::{
    attach::{attach_argv, AttachEvent, AttachKey, AttachManager, Sink},
    error::AppError,
    machines::MachineManager,
    sshconfig,
    transport::ssh::master_argv,
    view::MachineView,
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
pub async fn machine_add(mgr: Mgr<'_>, ssh_target: String, label: Option<String>, herdr_path: Option<String>) -> Result<MachineView, AppError> {
    mgr.add(ssh_target, label, herdr_path).await
}

#[tauri::command]
pub async fn machine_remove(mgr: Mgr<'_>, id: String) -> Result<(), AppError> {
    mgr.remove(&id).await
}

#[tauri::command]
pub async fn machine_update(mgr: Mgr<'_>, id: String, herdr_path: Option<String>) -> Result<MachineView, AppError> {
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
pub async fn session_start(mgr: Mgr<'_>, machine_id: String, session: String) -> Result<(), AppError> {
    mgr.start_session(&machine_id, &session).await
}

#[tauri::command]
pub async fn session_stop(mgr: Mgr<'_>, machine_id: String, session: String) -> Result<(), AppError> {
    mgr.stop_session(&machine_id, &session).await
}

#[tauri::command]
pub async fn herdr_call(mgr: Mgr<'_>, machine_id: String, session: String, method: String, params: Value) -> Result<Value, AppError> {
    mgr.call(&machine_id, &session, &method, params).await
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
    let (ctl, target) = mgr.ssh_master(&machine_id)?;
    crate::transport::ssh::clear_stale_ctl(&ctl, &target).await;
    let argv = master_argv(&ctl, &target, false);
    let key = AttachKey { machine_id: machine_id.clone(), session: String::new(), terminal_id: SSH_MASTER_TERMINAL.into() };
    let sink = MasterSink { inner: ChannelSink { data, events, ssh: false }, mgr: Arc::clone(&mgr), machine_id };
    att.open(key, argv, cols, rows, Arc::new(sink))
}

fn master_key(machine_id: String) -> AttachKey {
    AttachKey { machine_id, session: String::new(), terminal_id: SSH_MASTER_TERMINAL.into() }
}

#[tauri::command]
pub async fn connect_write(att: Att<'_>, machine_id: String, data: String) -> Result<(), AppError> {
    att.write(&master_key(machine_id), data.as_bytes())
}

#[tauri::command]
pub async fn connect_resize(att: Att<'_>, machine_id: String, cols: u16, rows: u16) -> Result<(), AppError> {
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
    let key = AttachKey { machine_id, session, terminal_id };
    att.open(key, argv, cols, rows, Arc::new(ChannelSink { data, events, ssh }))
}

#[tauri::command]
pub async fn term_write(att: Att<'_>, key: AttachKey, data: String) -> Result<(), AppError> {
    att.write(&key, data.as_bytes())
}

#[tauri::command]
pub async fn term_resize(att: Att<'_>, key: AttachKey, cols: u16, rows: u16) -> Result<(), AppError> {
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
