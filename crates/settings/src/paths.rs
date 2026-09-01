//! Cross-platform resolution of application directories.

use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use hampy_core::{Error, Result};

/// Resolved, guaranteed-to-exist application directories.
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
}

impl AppPaths {
    /// Resolve the standard per-user directories for the current OS:
    /// `%APPDATA%\Hampy` on Windows, `~/Library/Application Support/Hampy`
    /// on macOS, and `~/.config/hampy` / `~/.local/share/hampy` on Linux.
    /// Each directory is created if missing.
    pub fn resolve() -> Result<Self> {
        let dirs = ProjectDirs::from("dev", "Hampy", "Hampy")
            .ok_or_else(|| Error::Config("could not resolve home directory".into()))?;

        let config_dir = dirs.config_dir().to_path_buf();
        let data_dir = dirs.data_dir().to_path_buf();
        let log_dir = data_dir.join("logs");

        for dir in [&config_dir, &data_dir, &log_dir] {
            std::fs::create_dir_all(dir)?;
        }

        Ok(AppPaths {
            config_dir,
            data_dir,
            log_dir,
        })
    }

    /// Build an [`AppPaths`] rooted under an arbitrary directory — used by tests
    /// and portable installs.
    pub fn rooted_at(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        let config_dir = root.join("config");
        let data_dir = root.join("data");
        let log_dir = data_dir.join("logs");
        for dir in [&config_dir, &data_dir, &log_dir] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(AppPaths {
            config_dir,
            data_dir,
            log_dir,
        })
    }

    /// Full path to the TOML config file.
    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("hampy.toml")
    }

    /// Full path to the SQLite database.
    pub fn database_file(&self) -> PathBuf {
        self.data_dir.join("hampy.db")
    }

    /// Full path to the SSH `known_hosts` file (OpenSSH format). Kept inside the
    /// app data dir rather than `~/.ssh` so Hampy owns its own trust store.
    pub fn known_hosts_file(&self) -> PathBuf {
        self.data_dir.join("known_hosts")
    }
}
