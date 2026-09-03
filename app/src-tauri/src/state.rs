//! Shared application state held by Tauri and injected into every command.

use std::collections::HashMap;
use std::sync::Mutex;

use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

use hampy_core::EventBus;
use hampy_ftp::FtpClient;
use hampy_rdp::{RdpEvent, RdpSession};
use hampy_serial::SerialSession;
use hampy_settings::{AppPaths, Config, Store};
use hampy_sftp::SftpClient;
use hampy_ssh::{SshClient, SshShell};
use hampy_terminal::PtySession;
use hampy_vnc::VncSession;

/// A live SSH shell tab: the connection kept alive alongside its shell handle.
pub struct SshShellEntry {
    /// Held to keep the underlying connection open for the shell's lifetime.
    pub _client: SshClient,
    pub shell: SshShell,
}

/// A live SFTP browser session: the connection plus the negotiated SFTP client.
pub struct SftpEntry {
    pub _client: SshClient,
    pub sftp: Arc<SftpClient>,
    /// uid → user name, resolved once over SSH (SFTP v3 only carries numeric
    /// ids). Used to turn numeric owners into names for the file browser.
    pub users: HashMap<u32, String>,
    /// gid → group name, resolved the same way.
    pub groups: HashMap<u32, String>,
}

/// An authenticated RDP session whose event stream is held until the frontend
/// confirms that its listener is ready. This prevents initial frames from
/// racing the IPC response.
pub struct RdpEntry {
    pub session: RdpSession,
    pub events: Option<tokio::sync::mpsc::Receiver<RdpEvent>>,
}

/// The single piece of managed state. Cloning is not needed — Tauri shares it
/// behind an `Arc` via `app.manage`.
pub struct AppState {
    /// Resolved per-OS directories.
    pub paths: AppPaths,
    /// In-memory copy of the user config, persisted on change.
    pub config: Mutex<Config>,
    /// SQLite repository, serialized through an async mutex.
    pub store: AsyncMutex<Store>,
    /// Application-wide event bus.
    pub _bus: EventBus,
    /// Live local terminal sessions keyed by their string id.
    pub terminals: Mutex<HashMap<String, PtySession>>,
    /// Live serial console sessions keyed by their string id.
    pub serials: Mutex<HashMap<String, SerialSession>>,
    /// Live SSH shell sessions keyed by their string id.
    pub ssh_shells: AsyncMutex<HashMap<String, SshShellEntry>>,
    /// Live SFTP browser sessions keyed by their string id.
    pub sftp_sessions: AsyncMutex<HashMap<String, SftpEntry>>,
    /// Live FTP browser sessions keyed by their string id (blocking client
    /// behind an `Arc` so commands can run it on blocking tasks).
    pub ftp_sessions: AsyncMutex<HashMap<String, Arc<FtpClient>>>,
    /// Live RDP sessions keyed by their string id.
    pub rdp_sessions: AsyncMutex<HashMap<String, RdpEntry>>,
    /// Live VNC sessions keyed by their string id.
    pub vnc_sessions: AsyncMutex<HashMap<String, VncSession>>,
}

impl AppState {
    /// Bootstrap state: resolve paths, load config, open the database.
    pub fn bootstrap() -> hampy_core::Result<Self> {
        let paths = AppPaths::resolve()?;
        let config = Config::load(paths.config_file())?;
        let store = Store::open(paths.database_file())?;
        Ok(AppState {
            paths,
            config: Mutex::new(config),
            store: AsyncMutex::new(store),
            _bus: EventBus::default(),
            terminals: Mutex::new(HashMap::new()),
            serials: Mutex::new(HashMap::new()),
            ssh_shells: AsyncMutex::new(HashMap::new()),
            sftp_sessions: AsyncMutex::new(HashMap::new()),
            ftp_sessions: AsyncMutex::new(HashMap::new()),
            rdp_sessions: AsyncMutex::new(HashMap::new()),
            vnc_sessions: AsyncMutex::new(HashMap::new()),
        })
    }
}
