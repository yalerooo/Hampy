//! # hampy-ai
//!
//! AI assistant: provider-agnostic (OpenAI, Ollama, Claude, Gemini, OpenRouter).
//!
//! **Roadmap phase:** 5. **Planned backend:** `reqwest`.
//!
//! This crate is scaffolded as an independent module. The public surface
//! ([`AiProvider`] + [`AiConfig`]) is
//! defined now so the Tauri layer and command schema can be wired ahead of the
//! full implementation, which lands in its roadmap phase.

use hampy_core::{Error, Result};
use serde::{Deserialize, Serialize};

/// Connection/runtime parameters for this capability. Fields are added as the
/// implementation matures; kept minimal and serializable for IPC + persistence.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiConfig {
    /// Human-friendly label shown in the UI.
    #[serde(default)]
    pub label: String,
}

/// Entry point for the `ai` capability.
#[derive(Debug, Default)]
pub struct AiProvider;

impl AiProvider {
    /// Construct the connector. Cheap and side-effect free.
    pub fn new() -> Self {
        Self
    }

    /// Establish/initialize the capability. Returns a phase-gated error until
    /// the implementation lands in roadmap phase 5.
    pub async fn connect(&self, _config: &AiConfig) -> Result<()> {
        Err(Error::protocol(
            "ai",
            "not yet implemented — scheduled for roadmap phase 5",
        ))
    }
}
