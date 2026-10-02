pub mod error;
pub mod herdr;

use tauri::Manager;
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            init_logging(app.path().app_log_dir()?)?;
            tracing::info!("herdr-app starting");
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
