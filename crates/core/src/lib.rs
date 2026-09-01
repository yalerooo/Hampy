//! # hampy-core
//!
//! Foundation crate for the Hampy desktop application. It defines the shared
//! vocabulary that every other crate speaks:
//!
//! - [`error`]: a single error type ([`Error`]) and [`Result`] alias.
//! - [`model`]: protocol-agnostic domain entities (sessions, hosts, folders…).
//! - [`event`]: an in-process async event bus ([`event::EventBus`]).
//! - [`plugin`]: the trait-based SDK ([`plugin::Plugin`]) and registry used to
//!   extend the app with new protocols/panels at runtime.
//!
//! Every capability crate (`hampy-ssh`, `hampy-terminal`, …) depends only on
//! this crate, keeping the module graph a star rather than a web.

pub mod error;
pub mod event;
pub mod model;
pub mod plugin;

pub use error::{Error, Result};
pub use event::{Event, EventBus, EventKind};
pub use model::{AuthMethod, Folder, Host, Protocol, Session, SessionId, SessionStatus, Tag};
pub use plugin::{Plugin, PluginContext, PluginMetadata, PluginRegistry};

/// Semantic version of the core ABI. Plugins compiled against a different major
/// are rejected by the [`PluginRegistry`].
pub const CORE_ABI_VERSION: u32 = 1;
