//! # hampy-kubernetes
//!
//! Kubernetes panel: clusters, pods, services, deployments, logs, integrated terminal.
//!
//! **Roadmap phase:** 4. **Planned backend:** `kube / k8s-openapi`.
//!
//! This crate is scaffolded as an independent module. The public surface
//! ([`KubeClient`] + [`KubernetesConfig`]) is
//! defined now so the Tauri layer and command schema can be wired ahead of the
//! full implementation, which lands in its roadmap phase.

use serde::{Deserialize, Serialize};
use hampy_core::{Error, Result};

/// Connection/runtime parameters for this capability. Fields are added as the
/// implementation matures; kept minimal and serializable for IPC + persistence.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KubernetesConfig {
    /// Human-friendly label shown in the UI.
    #[serde(default)]
    pub label: String,
}

/// Entry point for the `kubernetes` capability.
#[derive(Debug, Default)]
pub struct KubeClient;

impl KubeClient {
    /// Construct the connector. Cheap and side-effect free.
    pub fn new() -> Self {
        Self
    }

    /// Establish/initialize the capability. Returns a phase-gated error until
    /// the implementation lands in roadmap phase 4.
    pub async fn connect(&self, _config: &KubernetesConfig) -> Result<()> {
        Err(Error::protocol(
            "kubernetes",
            "not yet implemented — scheduled for roadmap phase 4",
        ))
    }
}
