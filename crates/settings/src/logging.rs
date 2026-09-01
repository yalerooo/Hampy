//! Structured logging bootstrap.
//!
//! Initializes `tracing` with two layers: a human-readable console layer and a
//! rolling JSON file layer under the app log directory. Level is controlled by
//! the `VOLTAIC_LOG` env var (falling back to `info`).

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crate::paths::AppPaths;

/// Initialize global logging. The returned [`WorkerGuard`] must be held for the
/// lifetime of the process — dropping it flushes and stops the file writer.
///
/// Calling this more than once is a no-op-with-error from `tracing` and is
/// guarded against by the caller (the Tauri setup hook calls it exactly once).
pub fn init(paths: &AppPaths) -> WorkerGuard {
    let filter = EnvFilter::try_from_env("VOLTAIC_LOG").unwrap_or_else(|_| EnvFilter::new("info"));

    let file_appender = tracing_appender::rolling::daily(&paths.log_dir, "hampy.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    let console_layer = fmt::layer().with_target(false).compact();
    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_writer(file_writer)
        .json();

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(console_layer)
        .with(file_layer)
        .try_init();

    tracing::info!(version = env!("CARGO_PKG_VERSION"), "logging initialized");
    guard
}
