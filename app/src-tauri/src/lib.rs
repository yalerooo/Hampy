//! Hampy desktop shell (Tauri 2).
//!
//! Wires the Rust core crates to the React frontend: bootstraps logging and
//! shared [`state::AppState`], registers the IPC [`commands`], and runs the
//! event loop. Kept in a library so integration tests and the binary entry
//! point (`main.rs`) share one `run` function.

mod commands;
mod state;

use state::AppState;
use hampy_settings::logging;

/// Build and run the Tauri application. Blocks until the last window closes.
pub fn run() {
    let state = AppState::bootstrap().expect("failed to bootstrap application state");

    // Hold the log guard for the process lifetime so the file sink keeps
    // flushing; it is dropped when `run` returns.
    let _log_guard = logging::init(&state.paths);
    tracing::info!("starting Hampy {}", env!("CARGO_PKG_VERSION"));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::list_folders,
            commands::save_folder,
            commands::delete_folder,
            commands::rename_folder,
            commands::list_sessions,
            commands::save_session,
            commands::delete_session,
            commands::set_secret,
            commands::get_secret,
            commands::delete_secret,
            commands::read_text_file,
            commands::write_text_file,
            commands::open_terminal,
            commands::terminal_input,
            commands::terminal_resize,
            commands::close_terminal,
            commands::open_ssh,
            commands::list_serial_ports,
            commands::open_serial,
            commands::sftp_connect,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_copy,
            commands::sftp_download,
            commands::sftp_download_dir,
            commands::sftp_upload,
            commands::sftp_disconnect,
            commands::machine_telemetry,
            commands::open_rdp,
            commands::rdp_input,
            commands::close_rdp,
            commands::open_vnc,
            commands::vnc_input,
            commands::close_vnc,
            commands::ftp_connect,
            commands::ftp_list,
            commands::ftp_mkdir,
            commands::ftp_remove,
            commands::ftp_rename,
            commands::ftp_download,
            commands::ftp_upload,
            commands::ftp_disconnect,
            commands::open_docker,
            commands::open_kubernetes,
            commands::list_docker_containers,
            commands::list_kubernetes_pods,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hampy");
}
