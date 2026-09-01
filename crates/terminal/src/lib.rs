//! # hampy-terminal
//!
//! Local shell sessions backed by a real OS pseudo-terminal via `portable-pty`.
//! A [`PtySession`] owns a child process and exposes a writer for input plus a
//! blocking reader that callers drain on a dedicated thread, forwarding bytes
//! onto the application event bus as [`hampy_core::EventKind::TerminalOutput`].
//!
//! This crate is protocol-agnostic about *which* shell runs — see [`Shell`].

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use hampy_core::{Error, Result};

/// The supported local shell programs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    PowerShell,
    Cmd,
    Wsl,
    Bash,
    Zsh,
    Fish,
}

impl Shell {
    /// Parse a shell from a config string; defaults to the platform shell.
    pub fn parse(s: &str) -> Shell {
        match s.to_ascii_lowercase().as_str() {
            "powershell" | "pwsh" => Shell::PowerShell,
            "cmd" => Shell::Cmd,
            "wsl" => Shell::Wsl,
            "bash" => Shell::Bash,
            "zsh" => Shell::Zsh,
            "fish" => Shell::Fish,
            _ => Shell::default(),
        }
    }

    /// The executable name to launch for this shell.
    pub fn program(&self) -> &'static str {
        match self {
            Shell::PowerShell => "powershell.exe",
            Shell::Cmd => "cmd.exe",
            Shell::Wsl => "wsl.exe",
            Shell::Bash => "bash",
            Shell::Zsh => "zsh",
            Shell::Fish => "fish",
        }
    }
}

// The default is platform-conditional, so it cannot be replaced with a plain
// `#[derive(Default)]` — clippy only sees one cfg branch at a time and wrongly
// flags it as derivable.
#[allow(clippy::derivable_impls)]
impl Default for Shell {
    fn default() -> Self {
        #[cfg(windows)]
        {
            Shell::PowerShell
        }
        #[cfg(not(windows))]
        {
            Shell::Bash
        }
    }
}

/// Initial terminal dimensions in character cells.
#[derive(Debug, Clone, Copy)]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        TerminalSize { rows: 24, cols: 80 }
    }
}

/// A live local terminal session: a child shell attached to a PTY.
pub struct PtySession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl std::fmt::Debug for PtySession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PtySession").finish_non_exhaustive()
    }
}

impl PtySession {
    /// Spawn `shell` inside a new PTY of the given `size`. The optional `cwd`
    /// sets the working directory for the child.
    pub fn spawn(shell: Shell, size: TerminalSize, cwd: Option<&str>) -> Result<Self> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::protocol("terminal", e.to_string()))?;

        Self::spawn_command_inner(pair, CommandBuilder::new(shell.program()), cwd)
    }

    /// Spawn an arbitrary `program` with `args` inside a new PTY. Used for
    /// "shell into X" sessions (e.g. `docker exec -it …`, `kubectl exec -it …`)
    /// that stream over the same terminal I/O path as a local shell.
    pub fn spawn_program(
        program: &str,
        args: &[String],
        size: TerminalSize,
        cwd: Option<&str>,
    ) -> Result<Self> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::protocol("terminal", e.to_string()))?;

        let mut cmd = CommandBuilder::new(program);
        for arg in args {
            cmd.arg(arg);
        }
        Self::spawn_command_inner(pair, cmd, cwd)
    }

    /// Shared tail of the spawners: set cwd, launch the child, wire the writer.
    fn spawn_command_inner(
        pair: portable_pty::PtyPair,
        mut cmd: CommandBuilder,
        cwd: Option<&str>,
    ) -> Result<Self> {
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| Error::protocol("terminal", e.to_string()))?;
        // Slave handle is no longer needed by the parent once the child owns it.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| Error::protocol("terminal", e.to_string()))?;

        tracing::info!("spawned pty session");
        Ok(PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master: pair.master,
            child,
        })
    }

    /// Obtain a blocking reader over the PTY output. Callers should drain this
    /// on a dedicated thread and forward bytes onto the event bus.
    pub fn reader(&self) -> Result<Box<dyn Read + Send>> {
        self.master
            .try_clone_reader()
            .map_err(|e| Error::protocol("terminal", e.to_string()))
    }

    /// Write raw input bytes (keystrokes, pasted text) to the shell.
    pub fn write_input(&self, data: &[u8]) -> Result<()> {
        let mut w = self
            .writer
            .lock()
            .map_err(|_| Error::protocol("terminal", "writer lock poisoned"))?;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    /// Resize the PTY when the UI pane changes dimensions.
    pub fn resize(&self, size: TerminalSize) -> Result<()> {
        self.master
            .resize(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::protocol("terminal", e.to_string()))
    }

    /// Terminate the child shell.
    pub fn kill(&mut self) -> Result<()> {
        self.child
            .kill()
            .map_err(|e| Error::protocol("terminal", e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_parsing_is_lenient() {
        assert_eq!(Shell::parse("PWSH"), Shell::PowerShell);
        assert_eq!(Shell::parse("ZSH"), Shell::Zsh);
        // Unknown falls back to the platform default.
        assert_eq!(Shell::parse("nonsense"), Shell::default());
    }
}
