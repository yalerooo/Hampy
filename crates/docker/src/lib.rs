//! # hampy-docker
//!
//! Docker panel: containers, images, networks, volumes, logs, exec.
//!
//! **Roadmap phase:** 4. **Planned backend:** `bollard`.
//!
//! This crate is scaffolded as an independent module. The public surface
//! ([`DockerClient`] + [`DockerConfig`]) is
//! defined now so the Tauri layer and command schema can be wired ahead of the
//! full implementation, which lands in its roadmap phase.

use hampy_core::{Error, Result};
use serde::{Deserialize, Serialize};

/// Connection/runtime parameters for this capability. Fields are added as the
/// implementation matures; kept minimal and serializable for IPC + persistence.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DockerConfig {
    /// Human-friendly label shown in the UI.
    #[serde(default)]
    pub label: String,
}

/// Entry point for the `docker` capability.
#[derive(Debug, Default)]
pub struct DockerClient;

impl DockerClient {
    /// Construct the connector. Cheap and side-effect free.
    pub fn new() -> Self {
        Self
    }

    /// Establish/initialize the capability. Returns a phase-gated error until
    /// the implementation lands in roadmap phase 4.
    pub async fn connect(&self, _config: &DockerConfig) -> Result<()> {
        Err(Error::protocol(
            "docker",
            "not yet implemented — scheduled for roadmap phase 4",
        ))
    }
}
