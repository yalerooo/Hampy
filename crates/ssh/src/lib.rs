//! # hampy-ssh
//!
//! SSH client built on [`russh`]: connection + authentication
//! ([`SshClient`]), an interactive PTY-backed shell ([`SshShell`]) whose output
//! streams over a channel so the UI can treat it exactly like a local terminal,
//! and local TCP port forwarding ([`tunnel`]).
//!
//! Authentication supports password, public key (with optional passphrase), and
//! the system SSH agent. Host-key handling is policy-driven
//! ([`config::HostKeyPolicy`]); persistent `known_hosts` matching and jump-host
//! traversal are tracked follow-ups within Phase 2.

mod client;
pub mod config;
mod shell;
pub mod tunnel;

pub use client::SshClient;
pub use config::{HostKeyPolicy, JumpHost, SshAuth, SshConfig};
pub use shell::SshShell;
pub use tunnel::LocalForward;
