//! Tauri IPC command surface — the typed boundary between the React frontend
//! and the Rust core. Every command returns `Result<_, hampy_core::Error>`,
//! which serializes to a string the frontend can surface.

use std::io::Read;

use std::sync::Arc;

use base64::Engine as _;
use hampy_core::model::{Session, SessionId};
use hampy_core::{Error, Result};
use hampy_ftp::{FtpClient, FtpConfig, FtpEntry};
use hampy_rdp::{RdpConfig, RdpEvent, RdpInput};
use hampy_serial::{SerialConfig, SerialPortInfo, SerialSession};
use hampy_settings::{Config, FolderRecord};
use hampy_sftp::{SftpClient, SftpEntry};
use hampy_ssh::{SshClient, SshConfig};
use hampy_terminal::{PtySession, Shell, TerminalSize};
use hampy_vnc::{VncConfig, VncEvent, VncInput};
use tauri::{AppHandle, Emitter, State};

use crate::state::{AppState, RdpEntry, SftpEntry as SftpSessionEntry, SshShellEntry};

/// Event channel the frontend listens on for raw terminal output.
const TERMINAL_OUTPUT_EVENT: &str = "hampy://terminal-output";

/// Event channel the frontend listens on for RDP graphics/lifecycle updates.
const RDP_EVENT: &str = "hampy://rdp-event";

/// Event channel the frontend listens on for VNC graphics/lifecycle updates.
const VNC_EVENT: &str = "hampy://vnc-event";

/// Event channel the frontend listens on for upload/download progress.
const TRANSFER_PROGRESS_EVENT: &str = "hampy://transfer-progress";

/// Payload pairing a terminal id with a chunk of output bytes.
#[derive(Clone, serde::Serialize)]
struct TerminalOutput {
    id: String,
    bytes: Vec<u8>,
}

/// Progress update for an in-flight upload or download, keyed by the owning
/// session id. Only one transfer runs at a time per session, so the id alone
/// is enough for the frontend to route the event.
#[derive(Clone, serde::Serialize)]
struct TransferProgress {
    id: String,
    path: String,
    bytes_done: u64,
    bytes_total: u64,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<Config> {
    Ok(state.config.lock().expect("config lock").clone())
}

#[tauri::command]
pub fn save_config(state: State<'_, AppState>, config: Config) -> Result<()> {
    config.save(state.paths.config_file())?;
    *state.config.lock().expect("config lock") = config;
    Ok(())
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>) -> Result<Vec<FolderRecord>> {
    let store = state.store.lock().await;
    store.list_folders()
}

#[tauri::command]
pub async fn save_folder(state: State<'_, AppState>, folder: FolderRecord) -> Result<()> {
    let store = state.store.lock().await;
    store.upsert_folder(&folder)
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, AppState>, name: String) -> Result<()> {
    let store = state.store.lock().await;
    store.delete_folder(&name)
}

/// Rename a folder and update all session references in one shot.
#[tauri::command]
pub async fn rename_folder(
    state: State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> Result<()> {
    let store = state.store.lock().await;
    store.rename_folder(&old_name, &new_name)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<Session>> {
    let store = state.store.lock().await;
    store.list_sessions()
}

#[tauri::command]
pub async fn save_session(state: State<'_, AppState>, session: Session) -> Result<()> {
    let store = state.store.lock().await;
    store.upsert_session(&session)
}

#[tauri::command]
pub async fn delete_session(state: State<'_, AppState>, id: SessionId) -> Result<()> {
    let store = state.store.lock().await;
    store.delete_session(id)
}

// ---------------------------------------------------------------------------
// Secrets (OS keychain)
// ---------------------------------------------------------------------------
//
// Credentials are kept out of the SQLite store: the frontend externalizes them
// here (keyed by session id + field) and resolves them again at connect time.
// The keychain service is a single namespace; the account encodes both parts.

const SECRET_SERVICE: &str = "hampy";

fn secret_entry(id: &str, field: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SECRET_SERVICE, &format!("{id}/{field}"))
        .map_err(|e| Error::protocol("keychain", e.to_string()))
}

/// Store a secret (e.g. an SSH password) in the OS keychain.
#[tauri::command]
pub fn set_secret(id: String, field: String, value: String) -> Result<()> {
    secret_entry(&id, &field)?
        .set_password(&value)
        .map_err(|e| Error::protocol("keychain", e.to_string()))
}

/// Fetch a previously stored secret. Returns `None` when no entry exists.
#[tauri::command]
pub fn get_secret(id: String, field: String) -> Result<Option<String>> {
    match secret_entry(&id, &field)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(Error::protocol("keychain", e.to_string())),
    }
}

/// Delete a stored secret. Missing entries are treated as success (idempotent).
#[tauri::command]
pub fn delete_secret(id: String, field: String) -> Result<()> {
    match secret_entry(&id, &field)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(Error::protocol("keychain", e.to_string())),
    }
}

// ---------------------------------------------------------------------------
// Plain text files (session import/export)
// ---------------------------------------------------------------------------

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units = bytes.chunks_exact(2).map(|pair| {
        if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        }
    });
    char::decode_utf16(units)
        .map(|result| result.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

/// Decode the legacy ANSI encoding used by MobaXterm exports. Bytes outside
/// the special 0x80..0x9f range map directly to the same Unicode code point.
fn decode_windows_1252(bytes: &[u8]) -> String {
    const C1: [char; 32] = [
        '\u{20ac}', '\u{fffd}', '\u{201a}', '\u{0192}', '\u{201e}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{02c6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{fffd}',
        '\u{017d}', '\u{fffd}', '\u{fffd}', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{02dc}', '\u{2122}', '\u{0161}', '\u{203a}',
        '\u{0153}', '\u{fffd}', '\u{017e}', '\u{0178}',
    ];

    bytes
        .iter()
        .map(|byte| match *byte {
            0x80..=0x9f => C1[usize::from(*byte - 0x80)],
            _ => char::from(*byte),
        })
        .collect()
}

fn decode_session_file(bytes: Vec<u8>) -> String {
    if let Some(body) = bytes.strip_prefix(&[0xff, 0xfe]) {
        return decode_utf16(body, true);
    }
    if let Some(body) = bytes.strip_prefix(&[0xfe, 0xff]) {
        return decode_utf16(body, false);
    }
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => decode_windows_1252(&error.into_bytes()),
    }
}

/// Read a session file. Hampy files use UTF-8; legacy MobaXterm exports may
/// use UTF-8, UTF-16, or the system ANSI encoding (Windows-1252).
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String> {
    Ok(decode_session_file(std::fs::read(&path)?))
}

/// Write a UTF-8 text file to an arbitrary path (used by session export).
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<()> {
    std::fs::write(&path, contents)?;
    Ok(())
}

#[cfg(test)]
mod session_file_tests {
    use super::decode_session_file;

    #[test]
    fn decodes_mobaxterm_windows_1252() {
        assert_eq!(
            decode_session_file(b"SubRep=Producci\xf3n\r\n".to_vec()),
            "SubRep=Producci\u{00f3}n\r\n"
        );
    }

    #[test]
    fn decodes_utf16_little_endian() {
        let mut bytes = vec![0xff, 0xfe];
        for unit in "[Bookmarks]\r\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_session_file(bytes), "[Bookmarks]\r\n");
    }
}

// ---------------------------------------------------------------------------
// Local terminal
// ---------------------------------------------------------------------------

/// Open a local shell in a new PTY and stream its output back to the frontend
/// via the [`TERMINAL_OUTPUT_EVENT`] channel. Returns the new terminal id.
#[tauri::command]
pub fn open_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    shell: String,
    rows: u16,
    cols: u16,
) -> Result<String> {
    let shell = Shell::parse(&shell);
    let size = TerminalSize { rows, cols };
    let session = PtySession::spawn(shell, size, None)?;
    Ok(register_pty(app, &state, session))
}

/// Register a freshly-spawned PTY session: drain its output on a dedicated OS
/// thread (PTY reads are blocking) onto the terminal-output channel, store it
/// keyed by a new id, and return that id. Shared by local shells and the
/// container/pod "exec" sessions, which all reuse the terminal I/O commands.
fn register_pty(app: AppHandle, state: &AppState, session: PtySession) -> String {
    let id = SessionId::new().to_string();
    let mut reader = match session.reader() {
        Ok(r) => r,
        Err(_) => return id,
    };

    let emit_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — process exited.
                Ok(n) => {
                    let payload = TerminalOutput {
                        id: emit_id.clone(),
                        bytes: buf[..n].to_vec(),
                    };
                    if app.emit(TERMINAL_OUTPUT_EVENT, payload).is_err() {
                        break; // Frontend gone; stop draining.
                    }
                }
                Err(_) => break,
            }
        }
        tracing::debug!(id = %emit_id, "terminal reader thread exited");
    });

    state
        .terminals
        .lock()
        .expect("terminals lock")
        .insert(id.clone(), session);
    id
}

// ---------------------------------------------------------------------------
// Docker / Kubernetes (shell into a container/pod via the local CLI)
// ---------------------------------------------------------------------------
//
// Rather than embedding a Docker/K8s API client, these open an interactive
// exec session through the local `docker`/`kubectl` CLIs inside a PTY — the
// same approach a terminal user takes, streamed over the terminal I/O path.

/// Parameters for shelling into a Docker container.
#[derive(Debug, serde::Deserialize)]
pub struct DockerConfig {
    /// Container name or id.
    container: String,
    /// Shell program to exec (defaults to `sh`).
    #[serde(default)]
    shell: String,
    /// Optional daemon to target (`-H`), e.g. `ssh://user@host` or `tcp://…`.
    #[serde(default)]
    host: Option<String>,
}

/// Parameters for shelling into a Kubernetes pod.
#[derive(Debug, serde::Deserialize)]
pub struct KubernetesConfig {
    /// Pod name.
    pod: String,
    /// Namespace (`-n`); omitted uses the current context default.
    #[serde(default)]
    namespace: Option<String>,
    /// Container within the pod (`-c`); omitted picks the default container.
    #[serde(default)]
    container: Option<String>,
    /// kubeconfig context (`--context`); omitted uses the current context.
    #[serde(default)]
    context: Option<String>,
    /// Shell program to exec (defaults to `sh`).
    #[serde(default)]
    shell: String,
}

fn shell_or_default(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        "sh".to_string()
    } else {
        t.to_string()
    }
}

/// Open an interactive `docker exec -it <container> <shell>` PTY session.
#[tauri::command]
pub fn open_docker(
    app: AppHandle,
    state: State<'_, AppState>,
    config: DockerConfig,
    rows: u16,
    cols: u16,
) -> Result<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(host) = config.host.as_deref().filter(|h| !h.trim().is_empty()) {
        args.push("-H".into());
        args.push(host.to_string());
    }
    args.push("exec".into());
    args.push("-it".into());
    args.push(config.container.clone());
    args.push(shell_or_default(&config.shell));

    let session = PtySession::spawn_program(
        &resolve_program("docker"),
        &args,
        TerminalSize { rows, cols },
        None,
    )?;
    Ok(register_pty(app, &state, session))
}

/// Open an interactive `kubectl exec -it <pod> [-c …] -- <shell>` PTY session.
#[tauri::command]
pub fn open_kubernetes(
    app: AppHandle,
    state: State<'_, AppState>,
    config: KubernetesConfig,
    rows: u16,
    cols: u16,
) -> Result<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(ctx) = config.context.as_deref().filter(|c| !c.trim().is_empty()) {
        args.push("--context".into());
        args.push(ctx.to_string());
    }
    if let Some(ns) = config.namespace.as_deref().filter(|n| !n.trim().is_empty()) {
        args.push("-n".into());
        args.push(ns.to_string());
    }
    args.push("exec".into());
    args.push("-it".into());
    args.push(config.pod.clone());
    if let Some(c) = config.container.as_deref().filter(|c| !c.trim().is_empty()) {
        args.push("-c".into());
        args.push(c.to_string());
    }
    args.push("--".into());
    args.push(shell_or_default(&config.shell));

    let session = PtySession::spawn_program(
        &resolve_program("kubectl"),
        &args,
        TerminalSize { rows, cols },
        None,
    )?;
    Ok(register_pty(app, &state, session))
}

/// Resolve a bare program name (e.g. `docker`) to a full path by searching
/// `PATH`, honoring `PATHEXT` on Windows (`docker` → `docker.exe`). Falls back
/// to the bare name when nothing matches (so the OS can still try).
fn resolve_program(name: &str) -> String {
    if name.contains('/') || name.contains('\\') {
        return name.to_string();
    }
    let Ok(path) = std::env::var("PATH") else {
        return name.to_string();
    };
    #[cfg(windows)]
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_string())
        .collect();
    for dir in std::env::split_paths(&path) {
        let direct = dir.join(name);
        if direct.is_file() {
            return direct.to_string_lossy().into_owned();
        }
        #[cfg(windows)]
        for ext in &exts {
            let cand = dir.join(format!("{name}{ext}"));
            if cand.is_file() {
                return cand.to_string_lossy().into_owned();
            }
        }
    }
    name.to_string()
}

/// Run a one-shot CLI and return its stdout, mapping failures to an error that
/// carries the command's stderr (or a "not found" hint).
fn run_cli(kind: &'static str, program: &str, args: &[String]) -> Result<String> {
    let mut cmd = std::process::Command::new(resolve_program(program));
    cmd.args(args);
    // Don't flash a console window on Windows for these background probes.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| Error::protocol(kind, format!("could not run `{program}`: {e}")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err.trim();
        return Err(Error::protocol(
            kind,
            if msg.is_empty() {
                format!("`{program}` exited with an error")
            } else {
                msg.to_string()
            },
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// A running Docker container, for the connect picker.
#[derive(Debug, serde::Serialize)]
pub struct ContainerInfo {
    name: String,
    image: String,
    status: String,
}

/// List running Docker containers via `docker ps`.
#[tauri::command]
pub fn list_docker_containers(host: Option<String>) -> Result<Vec<ContainerInfo>> {
    let mut args: Vec<String> = Vec::new();
    if let Some(h) = host.as_deref().filter(|h| !h.trim().is_empty()) {
        args.push("-H".into());
        args.push(h.to_string());
    }
    args.push("ps".into());
    args.push("--format".into());
    args.push("{{.Names}}\t{{.Image}}\t{{.Status}}".into());

    let stdout = run_cli("docker", "docker", &args)?;
    Ok(stdout
        .lines()
        .filter_map(|line| {
            let mut p = line.splitn(3, '\t');
            let name = p.next()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(ContainerInfo {
                name: name.to_string(),
                image: p.next().unwrap_or("").trim().to_string(),
                status: p.next().unwrap_or("").trim().to_string(),
            })
        })
        .collect())
}

/// A pod, for the connect picker.
#[derive(Debug, serde::Serialize)]
pub struct PodInfo {
    name: String,
    status: String,
}

/// List pods via `kubectl get pods`.
#[tauri::command]
pub fn list_kubernetes_pods(
    context: Option<String>,
    namespace: Option<String>,
) -> Result<Vec<PodInfo>> {
    let mut args: Vec<String> = Vec::new();
    if let Some(ctx) = context.as_deref().filter(|c| !c.trim().is_empty()) {
        args.push("--context".into());
        args.push(ctx.to_string());
    }
    if let Some(ns) = namespace.as_deref().filter(|n| !n.trim().is_empty()) {
        args.push("-n".into());
        args.push(ns.to_string());
    }
    args.push("get".into());
    args.push("pods".into());
    args.push("--no-headers".into());
    args.push("-o".into());
    args.push("custom-columns=NAME:.metadata.name,STATUS:.status.phase".into());

    let stdout = run_cli("kubernetes", "kubectl", &args)?;
    Ok(stdout
        .lines()
        .filter_map(|line| {
            let mut p = line.split_whitespace();
            let name = p.next()?;
            Some(PodInfo {
                name: name.to_string(),
                status: p.next().unwrap_or("").to_string(),
            })
        })
        .collect())
}

/// Route input to a live session. The same command serves local PTYs and SSH
/// shells so the frontend treats both uniformly.
#[tauri::command]
pub async fn terminal_input(state: State<'_, AppState>, id: String, data: String) -> Result<()> {
    // Local PTY (synchronous; no await while the std mutex is held).
    {
        let terminals = state.terminals.lock().expect("terminals lock");
        if let Some(session) = terminals.get(&id) {
            return session.write_input(data.as_bytes());
        }
    }
    // Serial console (also synchronous, behind a std mutex).
    {
        let serials = state.serials.lock().expect("serials lock");
        if let Some(session) = serials.get(&id) {
            return session.write_input(data.as_bytes());
        }
    }
    // SSH shell (clone the handle out, then await without holding the lock).
    let shell = {
        let map = state.ssh_shells.lock().await;
        map.get(&id).map(|e| e.shell.clone())
    };
    match shell {
        Some(shell) => shell.write(data.as_bytes()).await,
        None => Err(Error::NotFound(format!("session {id}"))),
    }
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<()> {
    {
        let terminals = state.terminals.lock().expect("terminals lock");
        if let Some(session) = terminals.get(&id) {
            return session.resize(TerminalSize { rows, cols });
        }
    }
    // Serial ports have no concept of window size — a resize is a no-op.
    if state
        .serials
        .lock()
        .expect("serials lock")
        .contains_key(&id)
    {
        return Ok(());
    }
    let shell = {
        let map = state.ssh_shells.lock().await;
        map.get(&id).map(|e| e.shell.clone())
    };
    match shell {
        Some(shell) => shell.resize(rows, cols).await,
        None => Ok(()), // resize on a closed session is a no-op
    }
}

#[tauri::command]
pub async fn close_terminal(state: State<'_, AppState>, id: String) -> Result<()> {
    if let Some(mut session) = state.terminals.lock().expect("terminals lock").remove(&id) {
        let _ = session.kill();
        return Ok(());
    }
    if let Some(session) = state.serials.lock().expect("serials lock").remove(&id) {
        session.close();
        return Ok(());
    }
    if let Some(entry) = state.ssh_shells.lock().await.remove(&id) {
        let _ = entry.shell.close().await;
        entry._client.disconnect().await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

/// Connect over SSH, open an interactive shell, and stream its output on the
/// shared terminal-output channel. Returns the session id used for input/resize.
#[tauri::command]
pub async fn open_ssh(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SshConfig,
    rows: u16,
    cols: u16,
) -> Result<String> {
    let client = SshClient::connect(&config, Some(state.paths.known_hosts_file())).await?;
    let (shell, mut output) = client.open_shell(rows, cols).await?;

    let id = SessionId::new().to_string();
    let emit_id = id.clone();
    tokio::spawn(async move {
        while let Some(bytes) = output.recv().await {
            let payload = TerminalOutput {
                id: emit_id.clone(),
                bytes,
            };
            if app.emit(TERMINAL_OUTPUT_EVENT, payload).is_err() {
                break;
            }
        }
        tracing::debug!(id = %emit_id, "ssh output pump finished");
    });

    state.ssh_shells.lock().await.insert(
        id.clone(),
        SshShellEntry {
            _client: client,
            shell,
        },
    );
    Ok(id)
}

// ---------------------------------------------------------------------------
// Serial
// ---------------------------------------------------------------------------

/// Enumerate the serial ports the OS currently exposes (for the UI picker).
#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>> {
    hampy_serial::list_ports()
}

/// Open a serial port and stream its output on the shared terminal-output
/// channel. Reuses [`terminal_input`]/[`terminal_resize`]/[`close_terminal`]
/// for the rest of the lifecycle. Returns the session id.
#[tauri::command]
pub fn open_serial(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SerialConfig,
) -> Result<String> {
    let session = SerialSession::open(&config)?;
    let id = SessionId::new().to_string();
    let mut reader = session.reader()?;

    // Serial reads block; drain on a dedicated OS thread like the local PTY.
    let emit_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // session closed
                Ok(n) => {
                    let payload = TerminalOutput {
                        id: emit_id.clone(),
                        bytes: buf[..n].to_vec(),
                    };
                    if app.emit(TERMINAL_OUTPUT_EVENT, payload).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        tracing::debug!(id = %emit_id, "serial reader thread exited");
    });

    state
        .serials
        .lock()
        .expect("serials lock")
        .insert(id.clone(), session);
    Ok(id)
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------

/// Establish an SSH connection and negotiate an SFTP session. Returns the
/// session id plus the resolved home directory.
#[tauri::command]
pub async fn sftp_connect(state: State<'_, AppState>, config: SshConfig) -> Result<SftpConnection> {
    let client = SshClient::connect(&config, Some(state.paths.known_hosts_file())).await?;
    let stream = client.open_sftp_stream().await?;
    let sftp = SftpClient::open(stream).await?;
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());

    // SFTP v3 reports only numeric uid/gid, so resolve id → name maps once over
    // SSH. `getent` covers LDAP/NIS too; fall back to the flat files. Failures
    // are non-fatal — the browser just shows numeric ids.
    let users = parse_id_names(
        &client
            .exec("getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null")
            .await
            .unwrap_or_default(),
    );
    let groups = parse_id_names(
        &client
            .exec("getent group 2>/dev/null || cat /etc/group 2>/dev/null")
            .await
            .unwrap_or_default(),
    );

    let id = SessionId::new().to_string();
    state.sftp_sessions.lock().await.insert(
        id.clone(),
        SftpSessionEntry {
            _client: client,
            sftp: Arc::new(sftp),
            users,
            groups,
        },
    );
    Ok(SftpConnection { id, home })
}

/// Parse colon-separated account records (`name:x:id:…`, as in `/etc/passwd`
/// and `/etc/group`) into an id → name map. Keeps the first name seen per id.
fn parse_id_names(text: &str) -> std::collections::HashMap<u32, String> {
    let mut map = std::collections::HashMap::new();
    for line in text.lines() {
        let mut parts = line.split(':');
        if let (Some(name), Some(_), Some(id)) = (parts.next(), parts.next(), parts.next()) {
            if let Ok(id) = id.parse::<u32>() {
                map.entry(id).or_insert_with(|| name.to_string());
            }
        }
    }
    map
}

/// Result of [`sftp_connect`].
#[derive(serde::Serialize)]
pub struct SftpConnection {
    id: String,
    home: String,
}

/// Look up a live SFTP session by id under a held lock guard.
macro_rules! sftp_of {
    ($map:expr, $id:expr) => {
        $map.get(&$id)
            .ok_or_else(|| Error::NotFound(format!("sftp session {}", $id)))?
            .sftp
    };
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<Vec<SftpEntry>> {
    let map = state.sftp_sessions.lock().await;
    let entry = map
        .get(&id)
        .ok_or_else(|| Error::NotFound(format!("sftp session {id}")))?;
    let mut list = entry.sftp.list_dir(&path).await?;
    // Fill in symbolic owner/group from the resolved maps; fall back to the
    // numeric id as a string when a name isn't known.
    for e in &mut list {
        if e.owner.is_none() {
            e.owner = e.uid.map(|u| {
                entry
                    .users
                    .get(&u)
                    .cloned()
                    .unwrap_or_else(|| u.to_string())
            });
        }
        if e.group.is_none() {
            e.group = e.gid.map(|g| {
                entry
                    .groups
                    .get(&g)
                    .cloned()
                    .unwrap_or_else(|| g.to_string())
            });
        }
    }
    Ok(list)
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    let map = state.sftp_sessions.lock().await;
    sftp_of!(map, id).mkdir(&path).await
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<()> {
    let map = state.sftp_sessions.lock().await;
    let sftp = &sftp_of!(map, id);
    if is_dir {
        // Recursive so non-empty directories can be deleted from the UI.
        sftp.remove_dir_all(&path).await
    } else {
        sftp.remove_file(&path).await
    }
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> Result<()> {
    let map = state.sftp_sessions.lock().await;
    sftp_of!(map, id).rename(&from, &to).await
}

#[tauri::command]
pub async fn sftp_copy(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> Result<u64> {
    let map = state.sftp_sessions.lock().await;
    sftp_of!(map, id).copy(&from, &to).await
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
) -> Result<u64> {
    let sftp = {
        let map = state.sftp_sessions.lock().await;
        Arc::clone(&sftp_of!(map, id))
    };
    let total = sftp.file_size(&remote).await.unwrap_or(0);
    let mut done = 0u64;
    let mut on_chunk = |n: u64| {
        done += n;
        let _ = app.emit(
            TRANSFER_PROGRESS_EVENT,
            TransferProgress {
                id: id.clone(),
                path: remote.clone(),
                bytes_done: done,
                bytes_total: total,
            },
        );
    };
    sftp.download(&remote, std::path::Path::new(&local), &mut on_chunk)
        .await
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    local: String,
    remote: String,
) -> Result<u64> {
    let sftp = {
        let map = state.sftp_sessions.lock().await;
        Arc::clone(&sftp_of!(map, id))
    };
    let metadata = tokio::fs::metadata(&local).await?;
    if metadata.is_dir() {
        let done = std::sync::atomic::AtomicU64::new(0);
        return sftp
            .upload_dir(std::path::Path::new(&local), &remote, &|n, total| {
                let so_far = done.fetch_add(n, std::sync::atomic::Ordering::Relaxed) + n;
                let _ = app.emit(
                    TRANSFER_PROGRESS_EVENT,
                    TransferProgress {
                        id: id.clone(),
                        path: remote.clone(),
                        bytes_done: so_far,
                        bytes_total: total,
                    },
                );
            })
            .await;
    }

    let total = metadata.len();
    let mut done = 0u64;
    let mut on_chunk = |n: u64| {
        done += n;
        let _ = app.emit(
            TRANSFER_PROGRESS_EVENT,
            TransferProgress {
                id: id.clone(),
                path: remote.clone(),
                bytes_done: done,
                bytes_total: total,
            },
        );
    };
    sftp.upload(std::path::Path::new(&local), &remote, &mut on_chunk)
        .await
}

/// Recursively download a remote directory into a local one. Returns total
/// bytes transferred.
#[tauri::command]
pub async fn sftp_download_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
) -> Result<u64> {
    let sftp = {
        let map = state.sftp_sessions.lock().await;
        Arc::clone(&sftp_of!(map, id))
    };
    let done = std::sync::atomic::AtomicU64::new(0);
    let on_chunk = |n: u64, total: u64| {
        let so_far = done.fetch_add(n, std::sync::atomic::Ordering::Relaxed) + n;
        let _ = app.emit(
            TRANSFER_PROGRESS_EVENT,
            TransferProgress {
                id: id.clone(),
                path: remote.clone(),
                bytes_done: so_far,
                bytes_total: total,
            },
        );
    };
    sftp.download_dir(&remote, std::path::Path::new(&local), &on_chunk)
        .await
}

#[tauri::command]
pub async fn sftp_disconnect(state: State<'_, AppState>, id: String) -> Result<()> {
    if let Some(entry) = state.sftp_sessions.lock().await.remove(&id) {
        entry._client.disconnect().await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Machine telemetry (remote, over the SFTP session's SSH connection)
// ---------------------------------------------------------------------------

/// A point-in-time snapshot of the remote machine's resources. All byte counts
/// are absolute; percentages are 0–100. Fields default to 0/None when the
/// remote is not a Linux host (the probes read `/proc` + `/etc/os-release`).
#[derive(Default, serde::Serialize)]
pub struct MachineTelemetry {
    os_name: Option<String>,
    mem_total: u64,
    mem_used: u64,
    mem_percent: f32,
    cpu_percent: f32,
    disk_total: u64,
    disk_avail: u64,
    disk_percent: f32,
}

/// One combined probe (OS, memory, disk, first CPU sample) using markers so a
/// single round-trip yields everything but the second CPU sample.
const PROBE: &str = "echo __OS__; (. /etc/os-release 2>/dev/null; echo \"${PRETTY_NAME:-$(uname -sr)}\"); echo __MEM__; cat /proc/meminfo 2>/dev/null; echo __DISK__; df -kP / 2>/dev/null; echo __STAT__; head -n1 /proc/stat 2>/dev/null";

/// Sum of all jiffies and the idle portion (idle + iowait) from a `/proc/stat`
/// aggregate `cpu` line.
fn parse_cpu_line(line: &str) -> Option<(u64, u64)> {
    let nums: Vec<u64> = line
        .split_whitespace()
        .skip(1) // "cpu"
        .filter_map(|t| t.parse().ok())
        .collect();
    if nums.len() < 5 {
        return None;
    }
    let total: u64 = nums.iter().sum();
    let idle = nums[3] + nums[4]; // idle + iowait
    Some((total, idle))
}

/// Gather a telemetry snapshot from the remote host backing SFTP session `id`.
#[tauri::command]
pub async fn machine_telemetry(state: State<'_, AppState>, id: String) -> Result<MachineTelemetry> {
    // Clone the client out so the probe doesn't hold the sessions lock during
    // network I/O (it shares the connection via an Arc).
    let client = {
        let map = state.sftp_sessions.lock().await;
        map.get(&id)
            .map(|e| e._client.clone())
            .ok_or_else(|| Error::NotFound(format!("sftp session {id}")))?
    };

    let snapshot = client.exec(PROBE).await?;
    // Second CPU sample after a short interval for an instantaneous rate.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let stat2 = client.exec("head -n1 /proc/stat 2>/dev/null").await?;

    let mut t = MachineTelemetry::default();
    let mut section = "";
    let mut mem_total_kb = 0u64;
    let mut mem_avail_kb = 0u64;
    let mut cpu1: Option<(u64, u64)> = None;

    for raw in snapshot.lines() {
        let line = raw.trim();
        match line {
            "__OS__" => section = "os",
            "__MEM__" => section = "mem",
            "__DISK__" => section = "disk",
            "__STAT__" => section = "stat",
            _ => match section {
                "os" if t.os_name.is_none() && !line.is_empty() => {
                    t.os_name = Some(line.to_string());
                }
                "mem" => {
                    if let Some(v) = line.strip_prefix("MemTotal:") {
                        mem_total_kb = v.trim().trim_end_matches("kB").trim().parse().unwrap_or(0);
                    } else if let Some(v) = line.strip_prefix("MemAvailable:") {
                        mem_avail_kb = v.trim().trim_end_matches("kB").trim().parse().unwrap_or(0);
                    }
                }
                "disk" if line.starts_with('/') => {
                    // Filesystem 1K-blocks Used Available Capacity Mountpoint
                    let f: Vec<&str> = line.split_whitespace().collect();
                    if f.len() >= 4 {
                        let total_kb: u64 = f[1].parse().unwrap_or(0);
                        let avail_kb: u64 = f[3].parse().unwrap_or(0);
                        t.disk_total = total_kb * 1024;
                        t.disk_avail = avail_kb * 1024;
                    }
                }
                "stat" if line.starts_with("cpu") => cpu1 = parse_cpu_line(line),
                _ => {}
            },
        }
    }

    if mem_total_kb > 0 {
        t.mem_total = mem_total_kb * 1024;
        t.mem_used = mem_total_kb.saturating_sub(mem_avail_kb) * 1024;
        t.mem_percent = (t.mem_used as f32 / t.mem_total as f32) * 100.0;
    }
    if t.disk_total > 0 {
        let used = t.disk_total - t.disk_avail;
        t.disk_percent = (used as f32 / t.disk_total as f32) * 100.0;
    }
    if let (Some((tot1, idle1)), Some((tot2, idle2))) = (cpu1, parse_cpu_line(stat2.trim())) {
        let dt = tot2.saturating_sub(tot1);
        let di = idle2.saturating_sub(idle1);
        if dt > 0 {
            t.cpu_percent = ((dt - di) as f32 / dt as f32) * 100.0;
        }
    }

    Ok(t)
}

// ---------------------------------------------------------------------------
// RDP (graphical session — framebuffer regions streamed to a <canvas>)
// ---------------------------------------------------------------------------

/// Payload pushed to the frontend on the [`RDP_EVENT`] channel. `kind`
/// discriminates: `resized` (initial size), `frame` (dirty region, `data` is
/// base64 RGBA), `disconnected` (`reason` set on error).
#[derive(Clone, serde::Serialize)]
struct RdpEventPayload {
    id: String,
    kind: &'static str,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    /// Base64-encoded tightly-packed RGBA for `frame` events.
    data: Option<String>,
    reason: Option<String>,
    text: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpOpenResult {
    id: String,
    width: u16,
    height: u16,
}

/// Connect to an RDP host and return its id and negotiated desktop size. Event
/// forwarding remains paused until [`start_rdp_events`] installs the pump.
#[tauri::command]
pub async fn open_rdp(state: State<'_, AppState>, config: RdpConfig) -> Result<RdpOpenResult> {
    let (session, mut events) = hampy_rdp::connect(&config).await?;
    let id = SessionId::new().to_string();

    // The RDP driver always announces its negotiated size first. Return it as
    // part of the command response and keep the remaining stream paused until
    // `start_rdp_events` confirms the frontend listener is installed.
    let (width, height) = match events.recv().await {
        Some(RdpEvent::Resized { width, height }) => (width, height),
        Some(RdpEvent::Disconnected { reason }) => {
            return Err(Error::protocol(
                "rdp",
                reason.unwrap_or_else(|| "session ended during startup".to_owned()),
            ));
        }
        Some(RdpEvent::Frame { .. }) => {
            return Err(Error::protocol(
                "rdp",
                "received a frame before desktop size",
            ));
        }
        Some(RdpEvent::Clipboard { .. }) => {
            return Err(Error::protocol(
                "rdp",
                "received clipboard data before desktop size",
            ));
        }
        None => return Err(Error::protocol("rdp", "session ended during startup")),
    };

    state.rdp_sessions.lock().await.insert(
        id.clone(),
        RdpEntry {
            session,
            events: Some(events),
        },
    );

    Ok(RdpOpenResult { id, width, height })
}

/// Begin forwarding events only after the frontend has installed its listener.
#[tauri::command]
pub async fn start_rdp_events(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<()> {
    let mut events = {
        let mut sessions = state.rdp_sessions.lock().await;
        let entry = sessions
            .get_mut(&id)
            .ok_or_else(|| Error::NotFound(format!("rdp session {id}")))?;
        let Some(events) = entry.events.take() else {
            // Idempotent for React Strict Mode and harmless duplicate starts.
            return Ok(());
        };
        events
    };

    let emit_id = id;
    tokio::spawn(async move {
        while let Some(ev) = events.recv().await {
            let payload = match ev {
                RdpEvent::Resized { width, height } => RdpEventPayload {
                    id: emit_id.clone(),
                    kind: "resized",
                    x: 0,
                    y: 0,
                    width,
                    height,
                    data: None,
                    reason: None,
                    text: None,
                },
                RdpEvent::Frame {
                    x,
                    y,
                    width,
                    height,
                    rgba,
                } => RdpEventPayload {
                    id: emit_id.clone(),
                    kind: "frame",
                    x,
                    y,
                    width,
                    height,
                    data: Some(base64::engine::general_purpose::STANDARD.encode(&rgba)),
                    reason: None,
                    text: None,
                },
                RdpEvent::Clipboard { text } => RdpEventPayload {
                    id: emit_id.clone(),
                    kind: "clipboard",
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                    data: None,
                    reason: None,
                    text: Some(text),
                },
                RdpEvent::Disconnected { reason } => {
                    let _ = app.emit(
                        RDP_EVENT,
                        RdpEventPayload {
                            id: emit_id.clone(),
                            kind: "disconnected",
                            x: 0,
                            y: 0,
                            width: 0,
                            height: 0,
                            data: None,
                            reason,
                            text: None,
                        },
                    );
                    break;
                }
            };
            if app.emit(RDP_EVENT, payload).is_err() {
                break;
            }
        }
        tracing::debug!(id = %emit_id, "rdp event pump finished");
    });
    Ok(())
}

/// Inject a keyboard/mouse input event into a live RDP session.
#[tauri::command]
pub async fn rdp_input(state: State<'_, AppState>, id: String, input: RdpInput) -> Result<()> {
    let map = state.rdp_sessions.lock().await;
    match map.get(&id) {
        Some(entry) => entry.session.send_input(input).await,
        None => Err(Error::NotFound(format!("rdp session {id}"))),
    }
}

/// Close an RDP session: dropping the handle ends its driver task.
#[tauri::command]
pub async fn close_rdp(state: State<'_, AppState>, id: String) -> Result<()> {
    state.rdp_sessions.lock().await.remove(&id);
    Ok(())
}

// ---------------------------------------------------------------------------
// VNC (graphical — framebuffer rectangles streamed to a <canvas>)
// ---------------------------------------------------------------------------

/// Payload pushed to the frontend on the [`VNC_EVENT`] channel. `kind`:
/// `resized`, `frame` (`data` is base64 RGBA), `copy` (move a region), or
/// `disconnected` (`reason` set on error).
#[derive(Clone, serde::Serialize)]
struct VncEventPayload {
    id: String,
    kind: &'static str,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    src_x: u16,
    src_y: u16,
    data: Option<String>,
    reason: Option<String>,
}

/// Connect to a VNC host, then stream framebuffer updates to the frontend on the
/// [`VNC_EVENT`] channel. Returns the session id for input/close.
#[tauri::command]
pub async fn open_vnc(
    app: AppHandle,
    state: State<'_, AppState>,
    config: VncConfig,
) -> Result<String> {
    let (session, mut events) = hampy_vnc::connect(&config).await?;
    let id = SessionId::new().to_string();

    let emit_id = id.clone();
    tokio::spawn(async move {
        while let Some(ev) = events.recv().await {
            let payload = match ev {
                VncEvent::Resized { width, height } => VncEventPayload {
                    id: emit_id.clone(),
                    kind: "resized",
                    x: 0,
                    y: 0,
                    width,
                    height,
                    src_x: 0,
                    src_y: 0,
                    data: None,
                    reason: None,
                },
                VncEvent::Frame {
                    x,
                    y,
                    width,
                    height,
                    rgba,
                } => VncEventPayload {
                    id: emit_id.clone(),
                    kind: "frame",
                    x,
                    y,
                    width,
                    height,
                    src_x: 0,
                    src_y: 0,
                    data: Some(base64::engine::general_purpose::STANDARD.encode(&rgba)),
                    reason: None,
                },
                VncEvent::CopyRect {
                    src_x,
                    src_y,
                    dst_x,
                    dst_y,
                    width,
                    height,
                } => VncEventPayload {
                    id: emit_id.clone(),
                    kind: "copy",
                    x: dst_x,
                    y: dst_y,
                    width,
                    height,
                    src_x,
                    src_y,
                    data: None,
                    reason: None,
                },
                VncEvent::Disconnected { reason } => {
                    let _ = app.emit(
                        VNC_EVENT,
                        VncEventPayload {
                            id: emit_id.clone(),
                            kind: "disconnected",
                            x: 0,
                            y: 0,
                            width: 0,
                            height: 0,
                            src_x: 0,
                            src_y: 0,
                            data: None,
                            reason,
                        },
                    );
                    break;
                }
            };
            if app.emit(VNC_EVENT, payload).is_err() {
                break;
            }
        }
        tracing::debug!(id = %emit_id, "vnc event pump finished");
    });

    state.vnc_sessions.lock().await.insert(id.clone(), session);
    Ok(id)
}

/// Inject a pointer/key event into a live VNC session.
#[tauri::command]
pub async fn vnc_input(state: State<'_, AppState>, id: String, input: VncInput) -> Result<()> {
    let map = state.vnc_sessions.lock().await;
    match map.get(&id) {
        Some(session) => session.send_input(input).await,
        None => Err(Error::NotFound(format!("vnc session {id}"))),
    }
}

/// Close a VNC session: dropping the handle ends its driver task.
#[tauri::command]
pub async fn close_vnc(state: State<'_, AppState>, id: String) -> Result<()> {
    state.vnc_sessions.lock().await.remove(&id);
    Ok(())
}

// ---------------------------------------------------------------------------
// FTP (classic file transfer — blocking client driven on blocking tasks)
// ---------------------------------------------------------------------------

/// Result of [`ftp_connect`].
#[derive(serde::Serialize)]
pub struct FtpConnection {
    id: String,
    home: String,
}

/// Run a blocking FTP operation on a blocking thread against session `id`.
async fn ftp_blocking<T, F>(state: &State<'_, AppState>, id: &str, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&FtpClient) -> Result<T> + Send + 'static,
{
    let client = {
        let map = state.ftp_sessions.lock().await;
        map.get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("ftp session {id}")))?
    };
    tokio::task::spawn_blocking(move || f(&client))
        .await
        .map_err(|e| Error::protocol("ftp", format!("task join: {e}")))?
}

#[tauri::command]
pub async fn ftp_connect(state: State<'_, AppState>, config: FtpConfig) -> Result<FtpConnection> {
    let client = tokio::task::spawn_blocking(move || FtpClient::connect(&config))
        .await
        .map_err(|e| Error::protocol("ftp", format!("task join: {e}")))??;
    let home = client.pwd().unwrap_or_else(|_| "/".into());
    let id = SessionId::new().to_string();
    state
        .ftp_sessions
        .lock()
        .await
        .insert(id.clone(), Arc::new(client));
    Ok(FtpConnection { id, home })
}

#[tauri::command]
pub async fn ftp_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<Vec<FtpEntry>> {
    ftp_blocking(&state, &id, move |c| c.list_dir(&path)).await
}

#[tauri::command]
pub async fn ftp_mkdir(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    ftp_blocking(&state, &id, move |c| c.mkdir(&path)).await
}

#[tauri::command]
pub async fn ftp_remove(
    state: State<'_, AppState>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<()> {
    ftp_blocking(&state, &id, move |c| {
        if is_dir {
            c.remove_dir(&path)
        } else {
            c.remove_file(&path)
        }
    })
    .await
}

#[tauri::command]
pub async fn ftp_rename(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> Result<()> {
    ftp_blocking(&state, &id, move |c| c.rename(&from, &to)).await
}

#[tauri::command]
pub async fn ftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
) -> Result<u64> {
    let emit_id = id.clone();
    let emit_path = remote.clone();
    ftp_blocking(&state, &id, move |c| {
        let total = c.file_size(&remote).unwrap_or(0);
        let mut done = 0u64;
        c.download(&remote, std::path::Path::new(&local), &mut |n| {
            done += n;
            let _ = app.emit(
                TRANSFER_PROGRESS_EVENT,
                TransferProgress {
                    id: emit_id.clone(),
                    path: emit_path.clone(),
                    bytes_done: done,
                    bytes_total: total,
                },
            );
        })
    })
    .await
}

/// Recursively download an FTP directory into a local directory while
/// preserving all nested folders.
#[tauri::command]
pub async fn ftp_download_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
) -> Result<u64> {
    let emit_id = id.clone();
    let emit_path = remote.clone();
    ftp_blocking(&state, &id, move |c| {
        let done = std::sync::atomic::AtomicU64::new(0);
        c.download_dir(&remote, std::path::Path::new(&local), &|n, total| {
            let so_far = done.fetch_add(n, std::sync::atomic::Ordering::Relaxed) + n;
            let _ = app.emit(
                TRANSFER_PROGRESS_EVENT,
                TransferProgress {
                    id: emit_id.clone(),
                    path: emit_path.clone(),
                    bytes_done: so_far,
                    bytes_total: total,
                },
            );
        })
    })
    .await
}

#[tauri::command]
pub async fn ftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    local: String,
    remote: String,
) -> Result<u64> {
    let emit_id = id.clone();
    let emit_path = remote.clone();
    ftp_blocking(&state, &id, move |c| {
        let metadata = std::fs::metadata(&local)?;
        if metadata.is_dir() {
            let done = std::sync::atomic::AtomicU64::new(0);
            return c.upload_dir(std::path::Path::new(&local), &remote, &|n, total| {
                let so_far = done.fetch_add(n, std::sync::atomic::Ordering::Relaxed) + n;
                let _ = app.emit(
                    TRANSFER_PROGRESS_EVENT,
                    TransferProgress {
                        id: emit_id.clone(),
                        path: emit_path.clone(),
                        bytes_done: so_far,
                        bytes_total: total,
                    },
                );
            });
        }

        let total = metadata.len();
        let mut done = 0u64;
        c.upload(std::path::Path::new(&local), &remote, &mut |n| {
            done += n;
            let _ = app.emit(
                TRANSFER_PROGRESS_EVENT,
                TransferProgress {
                    id: emit_id.clone(),
                    path: emit_path.clone(),
                    bytes_done: done,
                    bytes_total: total,
                },
            );
        })
    })
    .await
}

#[tauri::command]
pub async fn ftp_disconnect(state: State<'_, AppState>, id: String) -> Result<()> {
    if let Some(client) = state.ftp_sessions.lock().await.remove(&id) {
        tokio::task::spawn_blocking(move || client.disconnect());
    }
    Ok(())
}
