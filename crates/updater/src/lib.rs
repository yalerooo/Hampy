//! # hampy-updater
//!
//! Automatic updates: channel-aware update checks and apply.
//!
//! **Roadmap phase:** 1. **Planned backend:** `tauri-plugin-updater`.
//!
//! This crate is scaffolded as an independent module. The public surface
//! ([`Updater`] + [`UpdaterConfig`]) is
//! defined now so the Tauri layer and command schema can be wired ahead of the
//! full implementation, which lands in its roadmap phase.

use hampy_core::{Error, Result};
use serde::{Deserialize, Serialize};

/// Connection/runtime parameters for this capability. Fields are added as the
/// implementation matures; kept minimal and serializable for IPC + persistence.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdaterConfig {
    /// Human-friendly label shown in the UI.
    #[serde(default)]
    pub label: String,
}

/// Entry point for the `updater` capability.
#[derive(Debug, Default)]
pub struct Updater;

impl Updater {
    /// Construct the connector. Cheap and side-effect free.
    pub fn new() -> Self {
        Self
    }

    /// Establish/initialize the capability. Returns a phase-gated error until
    /// the implementation lands in roadmap phase 1.
    pub async fn connect(&self, _config: &UpdaterConfig) -> Result<()> {
        Err(Error::protocol(
            "updater",
            "not yet implemented — scheduled for roadmap phase 1",
        ))
    }
}
