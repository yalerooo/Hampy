//! Plugin SDK.
//!
//! Hampy is designed to be extended without recompiling the host. A plugin is
//! any type implementing [`Plugin`]; it receives a [`PluginContext`] granting
//! access to the event bus and a scoped key/value store. The same trait backs
//! both statically-linked first-party capabilities and (future) dynamically
//! loaded third-party plugins distributed through a marketplace.
//!
//! Dynamic loading (via `libloading`/WASM) is intentionally **not** implemented
//! here yet — Phase 5. The trait and registry are stabilized now so first-party
//! crates already conform to the contract.

use std::collections::HashMap;

use async_trait::async_trait;

use crate::error::Result;
use crate::event::EventBus;
use crate::CORE_ABI_VERSION;

/// Static description of a plugin, surfaced in the UI marketplace/settings.
#[derive(Debug, Clone)]
pub struct PluginMetadata {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    /// Core ABI the plugin was built against; checked at registration.
    pub abi_version: u32,
}

/// Capabilities handed to a plugin at activation time.
#[derive(Clone)]
pub struct PluginContext {
    bus: EventBus,
}

impl std::fmt::Debug for PluginContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginContext").finish_non_exhaustive()
    }
}

impl PluginContext {
    pub fn new(bus: EventBus) -> Self {
        PluginContext { bus }
    }

    /// The shared application event bus.
    pub fn bus(&self) -> &EventBus {
        &self.bus
    }
}

/// The extension contract. Implementors are `Send + Sync` so they can live in
/// the shared application state behind an `Arc`.
#[async_trait]
pub trait Plugin: Send + Sync {
    /// Static metadata — must be cheap and side-effect free.
    fn metadata(&self) -> PluginMetadata;

    /// Called once when the plugin is registered and activated.
    async fn activate(&self, ctx: &PluginContext) -> Result<()>;

    /// Called during graceful shutdown. Default is a no-op.
    async fn deactivate(&self) -> Result<()> {
        Ok(())
    }
}

/// Owns the set of active plugins and enforces ABI compatibility.
#[derive(Default)]
pub struct PluginRegistry {
    plugins: HashMap<String, std::sync::Arc<dyn Plugin>>,
}

impl std::fmt::Debug for PluginRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginRegistry")
            .field("count", &self.plugins.len())
            .finish()
    }
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register and activate a plugin. Rejects ABI-incompatible or duplicate
    /// plugins.
    pub async fn register(
        &mut self,
        plugin: std::sync::Arc<dyn Plugin>,
        ctx: &PluginContext,
    ) -> Result<()> {
        let meta = plugin.metadata();
        if meta.abi_version != CORE_ABI_VERSION {
            return Err(crate::Error::Plugin(format!(
                "plugin '{}' targets ABI v{} but host is v{}",
                meta.id, meta.abi_version, CORE_ABI_VERSION
            )));
        }
        if self.plugins.contains_key(&meta.id) {
            return Err(crate::Error::Plugin(format!(
                "plugin '{}' is already registered",
                meta.id
            )));
        }
        plugin.activate(ctx).await?;
        tracing::info!(plugin = %meta.id, version = %meta.version, "plugin activated");
        self.plugins.insert(meta.id, plugin);
        Ok(())
    }

    /// Metadata for every active plugin.
    pub fn list(&self) -> Vec<PluginMetadata> {
        self.plugins.values().map(|p| p.metadata()).collect()
    }

    /// Deactivate all plugins (graceful shutdown).
    pub async fn shutdown(&mut self) {
        for (id, plugin) in self.plugins.drain() {
            if let Err(e) = plugin.deactivate().await {
                tracing::warn!(plugin = %id, error = %e, "plugin deactivate failed");
            }
        }
    }
}
