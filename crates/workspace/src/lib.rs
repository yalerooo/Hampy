//! # hampy-workspace
//!
//! Workspace system: group servers/tabs, save and restore session layouts.
//!
//! **Roadmap phase:** 1. **Planned backend:** `(core only)`.
//!
//! This crate is scaffolded as an independent module. The public surface
//! ([`WorkspaceManager`] + [`WorkspaceConfig`]) is
//! defined now so the Tauri layer and command schema can be wired ahead of the
//! full implementation, which lands in its roadmap phase.

use serde::{Deserialize, Serialize};
use hampy_core::{Error, Result};

/// Connection/runtime parameters for this capability. Fields are added as the
/// implementation matures; kept minimal and serializable for IPC + persistence.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    /// Human-friendly label shown in the UI.
    #[serde(default)]
    pub label: String,
}

/// Entry point for the `workspace` capability.
#[derive(Debug, Default)]
pub struct WorkspaceManager;

impl WorkspaceManager {
    /// Construct the connector. Cheap and side-effect free.
    pub fn new() -> Self {
        Self
    }

    /// Establish/initialize the capability. Returns a phase-gated error until
    /// the implementation lands in roadmap phase 1.
    pub async fn connect(&self, _config: &WorkspaceConfig) -> Result<()> {
        Err(Error::protocol(
            "workspace",
            "not yet implemented — scheduled for roadmap phase 1",
        ))
    }
}
