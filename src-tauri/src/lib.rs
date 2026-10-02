pub mod commands;
pub mod error;
pub mod herdr;
pub mod machines;
pub mod transport;
pub mod view;

use std::sync::Arc;
use tauri::{Emitter, Manager};

use machines::{MachineManager, UiEvent};
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::machines_list,
            commands::machine_connect,
            commands::machine_disconnect,
            commands::sessions_refresh,
            commands::session_start,
            commands::session_stop,
            commands::herdr_call,
        ])
        .setup(|app| {
            init_logging(app.path().app_log_dir()?)?;
            tracing::info!("herdr-app starting");
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let handle = app.handle().clone();
            let mgr = MachineManager::new(
                dir.join("machines.json"),
                Arc::new(move |e| {
                    let res = match e {
                        UiEvent::Machine(v) => handle.emit("sidebar://machine", v),
                        UiEvent::PaneStatus(p) => handle.emit("pane://status", p),
                    };
                    if let Err(err) = res {
                        tracing::warn!("emit failed: {err}");
                    }
                }),
            );
            app.manage(mgr.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(e) = mgr.connect("local").await {
                    tracing::error!("connect local: {e}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Daily-rotating log files under `dir`, keeping the 5 most recent.
fn init_logging(dir: std::path::PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&dir)?;
    let appender = Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix("herdr-app")
        .filename_suffix("log")
        .max_log_files(5)
        .build(&dir)?;
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(appender)
        .with_ansi(false)
        .try_init()
        .map_err(|e| e.to_string())?;
    Ok(())
}
