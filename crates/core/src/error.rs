//! Unified error type shared across the workspace.

use thiserror::Error;

/// Convenience alias used throughout Hampy crates.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// The single error enum every Hampy crate maps into. Capability crates add
/// their protocol-specific failures under [`Error::Protocol`] to avoid an
/// explosion of bespoke error types while still preserving context.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// Configuration could not be loaded, parsed, or serialized.
    #[error("configuration error: {0}")]
    Config(String),

    /// Persistence layer (SQLite) failure.
    #[error("persistence error: {0}")]
    Persistence(String),

    /// A requested entity (session, host, plugin…) does not exist.
    #[error("not found: {0}")]
    NotFound(String),

    /// The operation is valid but currently not permitted (e.g. app is locked).
    #[error("forbidden: {0}")]
    Forbidden(String),

    /// A protocol/capability crate failed. `kind` identifies the subsystem.
    #[error("{kind} error: {message}")]
    Protocol {
        /// Subsystem name, e.g. "ssh", "sftp", "terminal".
        kind: &'static str,
        /// Human-readable detail.
        message: String,
    },

    /// A plugin failed to load or violated the SDK contract.
    #[error("plugin error: {0}")]
    Plugin(String),

    /// I/O failure surfaced from the standard library or OS.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON (de)serialization failure, typically at the IPC boundary.
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// Catch-all for unexpected conditions that should be logged and surfaced.
    #[error("{0}")]
    Other(String),
}

impl Error {
    /// Build a [`Error::Protocol`] for a named subsystem.
    pub fn protocol(kind: &'static str, message: impl Into<String>) -> Self {
        Error::Protocol {
            kind,
            message: message.into(),
        }
    }
}

// Tauri serializes command errors as JSON; expose a stable string form.
impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
