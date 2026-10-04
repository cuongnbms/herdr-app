pub mod attach;
pub mod commands;
pub mod complete;
pub mod error;
pub mod fonts;
pub mod git;
pub mod herdr;
pub mod layout;
pub mod machines;
pub mod notify;
pub mod quota;
pub mod sshconfig;
pub mod transcript;
pub mod transport;
pub mod view;

use std::sync::Arc;
use tauri::{Emitter, Manager};

use attach::AttachManager;
use machines::{MachineManager, UiEvent};
use tracing_appender::rolling::{Builder, Rotation};
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::machines_list,
            commands::machine_connect,
            commands::machine_disconnect,
            commands::machine_add,
            commands::machine_remove,
            commands::machine_update,
            commands::machine_master_alive,
            commands::ssh_hosts,
            commands::connect_open,
            commands::connect_write,
            commands::connect_ack,
            commands::connect_resize,
            commands::connect_close,
            commands::sessions_refresh,
            commands::session_start,
            commands::session_stop,
            commands::session_delete,
            commands::herdr_call,
            commands::notify_pane,
            commands::image_save_temp,
            commands::term_open,
            commands::term_write,
            commands::term_resize,
            commands::term_ack,
            commands::term_release,
            commands::term_close,
            commands::chat_open,
            commands::chat_locate,
            commands::chat_page,
            commands::chat_image,
            commands::chat_close,
            commands::complete_commands,
            commands::complete_files,
            commands::chat_git_status,
            commands::system_fonts,
            commands::font_face,
            commands::quota_fetch,
            commands::layout_load,
            commands::layout_save,
        ])
        .setup(|app| {
            init_logging(app.path().app_log_dir()?)?;
            tracing::info!("herdr-app starting");
            notify::init(app.handle());
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Arc::new(layout::LayoutStore::new(
                dir.join("sidebar-layout.json"),
            )));
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
            let attach = AttachManager::new(std::time::Duration::from_secs(15));
            mgr.set_attach_manager(attach.clone());
            let chats = Arc::new(transcript::ChatManager::default());
            mgr.set_chat_manager(chats.clone());
            app.manage(mgr.clone());
            app.manage(attach);
            app.manage(chats);
            tauri::async_runtime::spawn(async move { mgr.connect_at_startup().await });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // ControlPersist masters outlive us: end every ssh master on the way out.
                if let Some(mgr) = app.try_state::<Arc<MachineManager>>() {
                    let mgr = mgr.inner().clone();
                    tauri::async_runtime::block_on(async move { mgr.disconnect_all_ssh().await });
                }
            }
        });
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
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(appender)
        .with_ansi(false)
        .try_init()
        .map_err(|e| e.to_string())?;
    Ok(())
}
