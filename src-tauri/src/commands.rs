//! Tauri commands: thin wrappers over `MachineManager`.
use crate::{
    attach::{attach_argv, AttachEvent, AttachKey, AttachManager, Sink},
    error::AppError,
    machines::MachineManager,
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
}

impl Sink for ChannelSink {
    fn data(&self, bytes: Vec<u8>) {
        if let Err(e) = self.data.send(InvokeResponseBody::Raw(bytes)) {
            tracing::warn!("terminal data send failed: {e}");
        }
    }
    fn event(&self, e: AttachEvent) {
        if let Err(err) = self.events.send(e) {
            tracing::warn!("terminal event send failed: {err}");
        }
    }
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
    let key = AttachKey { machine_id, session, terminal_id };
    att.open(key, argv, cols, rows, Arc::new(ChannelSink { data, events }))
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
