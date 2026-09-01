//! # hampy-settings
//!
//! Owns everything persistent and ambient about a Hampy install:
//!
//! - [`paths`]: per-OS resolution of config/data/log directories.
//! - [`config`]: the user-editable [`config::Config`] persisted as TOML.
//! - [`store`]: the [`store::Store`] SQLite-backed repository for sessions,
//!   folders and history.
//! - [`logging`]: structured `tracing` initialization with file + console sinks.

pub mod config;
pub mod logging;
pub mod paths;
pub mod store;

pub use config::Config;
pub use paths::AppPaths;
pub use store::{FolderRecord, Store};
