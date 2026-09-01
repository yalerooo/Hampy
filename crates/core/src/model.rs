//! Protocol-agnostic domain entities.
//!
//! These types are the persisted, serializable heart of Hampy. They are
//! deliberately UI- and transport-neutral: the Tauri layer serializes them to
//! the frontend, the `settings` crate persists them to SQLite, and capability
//! crates consume them to open connections.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Strongly-typed identifier for a [`Session`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub Uuid);

impl SessionId {
    /// Generate a fresh random identifier.
    pub fn new() -> Self {
        SessionId(Uuid::new_v4())
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The connection protocols Hampy can drive. Each maps to a capability crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    /// Local shell (PowerShell, CMD, WSL, bash, zsh, fish) via a PTY.
    LocalShell,
    Ssh,
    Sftp,
    Ftp,
    Rdp,
    Vnc,
    Serial,
    Mosh,
    Docker,
    Kubernetes,
}

impl Protocol {
    /// The capability-crate subsystem name, used in error/event routing.
    pub fn subsystem(&self) -> &'static str {
        match self {
            Protocol::LocalShell => "terminal",
            Protocol::Ssh => "ssh",
            Protocol::Sftp => "sftp",
            Protocol::Ftp => "ftp",
            Protocol::Rdp => "rdp",
            Protocol::Vnc => "vnc",
            Protocol::Serial => "serial",
            Protocol::Mosh => "mosh",
            Protocol::Docker => "docker",
            Protocol::Kubernetes => "kubernetes",
        }
    }
}

/// How Hampy authenticates a connection. Secrets are never stored inline —
/// they live in the OS keychain and are referenced by `secret_ref`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthMethod {
    /// No credentials (local shells, anonymous endpoints).
    None,
    /// Username + a password stored in the keychain under `secret_ref`.
    Password {
        username: String,
        secret_ref: String,
    },
    /// Public-key auth; `key_ref` points at the private key in secure storage.
    PublicKey { username: String, key_ref: String },
    /// Delegated to a running SSH agent.
    Agent { username: String },
}

/// Lifecycle state of a live or saved session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// Saved but not connected.
    Idle,
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
    /// Terminated with an error; detail surfaced via the event bus.
    Failed,
}

/// A user-assigned label used for filtering and universal search.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
    /// Optional hex color override; defaults to the design-system primary.
    #[serde(default)]
    pub color: Option<String>,
}

/// A folder groups sessions hierarchically in the sidebar tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub id: Uuid,
    pub name: String,
    /// Parent folder, or `None` for a root-level folder.
    pub parent_id: Option<Uuid>,
}

/// A reusable host endpoint (address + auth). Multiple sessions may target one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Host {
    pub id: Uuid,
    pub hostname: String,
    pub port: u16,
    pub auth: AuthMethod,
    /// Optional jump host (bastion) for SSH/SFTP.
    #[serde(default)]
    pub jump_host_id: Option<Uuid>,
}

/// A saved connection definition — the central entity of the app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub name: String,
    pub protocol: Protocol,
    /// `None` for protocol-less sessions such as a bare local shell.
    #[serde(default)]
    pub host: Option<Host>,
    /// Folder this session belongs to. A free-form name (the UI groups by it),
    /// or `None` for a root-level session.
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<Tag>,
    #[serde(default)]
    pub favorite: bool,
    /// Free-form protocol-specific options (shell program, RDP resolution…).
    #[serde(default)]
    pub options: serde_json::Map<String, serde_json::Value>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub last_used_at: Option<DateTime<Utc>>,
    #[serde(skip, default = "default_status")]
    pub status: SessionStatus,
}

fn default_status() -> SessionStatus {
    SessionStatus::Idle
}

impl Session {
    /// Create a minimally-valid session for the given protocol.
    pub fn new(name: impl Into<String>, protocol: Protocol) -> Self {
        Session {
            id: SessionId::new(),
            name: name.into(),
            protocol,
            host: None,
            folder_id: None,
            tags: Vec::new(),
            favorite: false,
            options: serde_json::Map::new(),
            created_at: Utc::now(),
            last_used_at: None,
            status: SessionStatus::Idle,
        }
    }
}
