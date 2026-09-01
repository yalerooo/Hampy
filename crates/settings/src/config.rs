//! User-editable configuration, serialized as TOML.
//!
//! The config is intentionally separate from the SQLite store: it holds *small,
//! human-editable* preferences (theme, appearance, security policy), while the
//! store holds *data* (sessions, history). Defaults are sensible for a fresh
//! install so the file can be deleted to reset preferences.

use std::path::Path;

use serde::{Deserialize, Serialize};
use hampy_core::{Error, Result};

/// Root configuration document.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub appearance: Appearance,
    pub terminal: TerminalConfig,
    pub security: SecurityConfig,
    pub updates: UpdateConfig,
}

/// Visual preferences. The defaults follow DESIGN.md: dark canvas, electric
/// yellow accent, Inter UI font, JetBrains Mono in terminals.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Appearance {
    /// `"dark"`, `"light"`, or `"system"`.
    pub theme: String,
    /// Accent color; defaults to the design-system primary `#faff69`.
    pub accent: String,
    /// 0.0 (opaque) – 1.0; enables the optional window blur/transparency.
    pub window_opacity: f32,
    /// Toggles backdrop blur where the OS supports it.
    pub blur_effects: bool,
    /// Toggles UI motion; respects reduced-motion when false.
    pub animations: bool,
    pub ui_font: String,
    /// UI language; `"en"` or `"es"`.
    pub language: String,
}

impl Default for Appearance {
    fn default() -> Self {
        Appearance {
            theme: "dark".into(),
            accent: "#faff69".into(),
            window_opacity: 1.0,
            blur_effects: true,
            animations: true,
            ui_font: "Inter".into(),
            language: "en".into(),
        }
    }
}

/// Terminal defaults applied to new local-shell tabs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalConfig {
    pub font_family: String,
    pub font_size: u16,
    /// Default shell program: `powershell`, `cmd`, `wsl`, `bash`, `zsh`, `fish`.
    pub default_shell: String,
    /// Lines of scrollback retained per session.
    pub scrollback: u32,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        TerminalConfig {
            font_family: "JetBrains Mono".into(),
            font_size: 14,
            #[cfg(windows)]
            default_shell: "powershell".into(),
            #[cfg(not(windows))]
            default_shell: "bash".into(),
            scrollback: 10_000,
        }
    }
}

/// Security policy controlling secret storage and auto-lock.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SecurityConfig {
    /// Store secrets in the OS keychain (true) vs. an encrypted local vault.
    pub use_os_keychain: bool,
    /// Minutes of inactivity before the app locks; 0 disables auto-lock.
    pub auto_lock_minutes: u32,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        SecurityConfig {
            use_os_keychain: true,
            auto_lock_minutes: 15,
        }
    }
}

/// Auto-update behavior.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdateConfig {
    pub auto_check: bool,
    /// `"stable"` or `"beta"`.
    pub channel: String,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        UpdateConfig {
            auto_check: true,
            channel: "stable".into(),
        }
    }
}

impl Config {
    /// Load config from `path`, returning defaults if the file does not exist.
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if !path.exists() {
            return Ok(Config::default());
        }
        let text = std::fs::read_to_string(path)?;
        toml::from_str(&text).map_err(|e| Error::Config(e.to_string()))
    }

    /// Serialize and atomically write config to `path` (write-temp + rename).
    pub fn save(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref();
        let text = toml::to_string_pretty(self).map_err(|e| Error::Config(e.to_string()))?;
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_through_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hampy.toml");

        let mut cfg = Config::default();
        cfg.appearance.theme = "light".into();
        cfg.terminal.font_size = 16;
        cfg.save(&path).unwrap();

        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.appearance.theme, "light");
        assert_eq!(loaded.terminal.font_size, 16);
        assert_eq!(loaded.appearance.accent, "#faff69");
    }

    #[test]
    fn missing_file_yields_defaults() {
        let cfg = Config::load("/non/existent/path.toml").unwrap();
        assert_eq!(cfg.appearance.accent, "#faff69");
    }
}
