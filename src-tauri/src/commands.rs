//! Tauri commands: thin wrappers over `MachineManager`.
use crate::{error::AppError, machines::MachineManager, view::MachineView};
use serde_json::Value;
use std::sync::Arc;
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
