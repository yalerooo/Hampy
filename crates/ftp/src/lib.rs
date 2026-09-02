//! # hampy-ftp
//!
//! Classic FTP client built on the synchronous [`suppaftp`] `FtpStream`. FTP's
//! control/data model is blocking, so callers drive these methods from blocking
//! tasks (`tokio::task::spawn_blocking`) — the same pattern used for local PTYs
//! and serial ports — keeping the app on one tokio runtime.
//!
//! Directory listings come back as raw `LIST` lines; [`parse_list_line`] handles
//! the common Unix `ls -l` format, the de-facto standard across FTP servers.
//!
//! [`suppaftp`]: https://crates.io/crates/suppaftp

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use hampy_core::{Error, Result};
use serde::{Deserialize, Serialize};
use suppaftp::{FtpError, FtpStream};

const CHUNK_SIZE: usize = 256 * 1024;

const SUBSYS: &str = "ftp";

fn err(e: impl std::fmt::Display) -> Error {
    Error::protocol(SUBSYS, e.to_string())
}

fn safe_child_path(base: &Path, name: &str) -> Result<PathBuf> {
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(std::path::Component::Normal(_)), None) => Ok(base.join(name)),
        _ => Err(Error::protocol(
            SUBSYS,
            format!("unsafe remote entry name: {name:?}"),
        )),
    }
}

#[derive(Debug)]
struct DownloadFile {
    remote: String,
    relative: PathBuf,
    size: u64,
}

/// Connection parameters for an FTP session. Mirrors the TypeScript `FtpConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FtpConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_user")]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

fn default_port() -> u16 {
    21
}
fn default_user() -> String {
    "anonymous".to_string()
}

/// Kind of a remote entry — same shape as the SFTP browser's `EntryKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
    Other,
}

/// A single entry in a remote directory listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FtpEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
}

/// A live FTP connection. Operations are synchronous and serialized through a
/// mutex; call them from a blocking task.
pub struct FtpClient {
    inner: Mutex<FtpStream>,
}

impl std::fmt::Debug for FtpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FtpClient").finish_non_exhaustive()
    }
}

impl FtpClient {
    /// Connect and authenticate. Switches to binary mode for transfers.
    pub fn connect(config: &FtpConfig) -> Result<Self> {
        let addr = format!("{}:{}", config.host, config.port);
        let mut stream = FtpStream::connect(&addr)
            .map_err(|e| Error::protocol(SUBSYS, format!("connect {addr}: {e}")))?;
        stream
            .login(&config.username, &config.password)
            .map_err(|e| Error::protocol(SUBSYS, format!("login: {e}")))?;
        let _ = stream.transfer_type(suppaftp::types::FileType::Binary);
        tracing::info!(host = %config.host, port = config.port, "ftp connected");
        Ok(FtpClient {
            inner: Mutex::new(stream),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&mut FtpStream) -> Result<T>) -> Result<T> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::protocol(SUBSYS, "ftp lock poisoned"))?;
        f(&mut guard)
    }

    /// The current working directory reported by the server.
    pub fn pwd(&self) -> Result<String> {
        self.with(|s| s.pwd().map_err(err))
    }

    /// List a directory. Entries are sorted dirs-first then by name.
    pub fn list_dir(&self, path: &str) -> Result<Vec<FtpEntry>> {
        let base = if path.is_empty() { "/" } else { path };
        let lines = self.with(|s| s.list(Some(base)).map_err(err))?;
        let trimmed = base.trim_end_matches('/');
        let mut entries: Vec<FtpEntry> = lines
            .iter()
            .filter_map(|line| parse_list_line(line))
            .filter(|(name, _, _)| name != "." && name != "..")
            .map(|(name, kind, size)| FtpEntry {
                path: format!("{trimmed}/{name}"),
                name,
                kind,
                size,
            })
            .collect();
        entries.sort_by(
            |a, b| match (a.kind == EntryKind::Dir, b.kind == EntryKind::Dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            },
        );
        Ok(entries)
    }

    /// Size of a remote file, in bytes.
    pub fn file_size(&self, remote: &str) -> Result<u64> {
        self.with(|s| s.size(remote).map(|size| size as u64).map_err(err))
    }

    /// Download a remote file directly to disk without buffering the entire
    /// payload in memory. Returns bytes written.
    pub fn download(
        &self,
        remote: &str,
        local: &Path,
        on_chunk: &mut (dyn FnMut(u64) + Send),
    ) -> Result<u64> {
        let mut local_file = std::fs::File::create(local)?;
        self.with(|s| {
            s.retr(remote, |reader| {
                let mut buffer = vec![0u8; CHUNK_SIZE];
                let mut total = 0u64;
                loop {
                    let n = reader
                        .read(&mut buffer)
                        .map_err(FtpError::ConnectionError)?;
                    if n == 0 {
                        break;
                    }
                    local_file
                        .write_all(&buffer[..n])
                        .map_err(FtpError::ConnectionError)?;
                    total += n as u64;
                    on_chunk(n as u64);
                }
                local_file.flush().map_err(FtpError::ConnectionError)?;
                Ok(total)
            })
            .map_err(err)
        })
    }

    fn download_manifest(&self, path: &str) -> Result<(Vec<PathBuf>, Vec<DownloadFile>)> {
        fn recurse(
            client: &FtpClient,
            remote: &str,
            relative: &Path,
            dirs: &mut Vec<PathBuf>,
            files: &mut Vec<DownloadFile>,
        ) -> Result<()> {
            for entry in client.list_dir(remote)? {
                let relative_path = safe_child_path(relative, &entry.name)?;
                if entry.kind == EntryKind::Dir {
                    dirs.push(relative_path.clone());
                    recurse(client, &entry.path, &relative_path, dirs, files)?;
                } else {
                    files.push(DownloadFile {
                        remote: entry.path,
                        relative: relative_path,
                        size: entry.size,
                    });
                }
            }
            Ok(())
        }

        let mut dirs = Vec::new();
        let mut files = Vec::new();
        recurse(self, path, Path::new(""), &mut dirs, &mut files)?;
        Ok((dirs, files))
    }

    /// Recursively download a directory while preserving its complete tree.
    /// FTP permits one data stream per connection, so files are streamed in
    /// sequence and never accumulated in memory.
    pub fn download_dir(
        &self,
        remote: &str,
        local: &Path,
        on_chunk: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<u64> {
        let (dirs, files) = self.download_manifest(remote)?;
        let total = files.iter().map(|file| file.size).sum();

        std::fs::create_dir_all(local)?;
        for dir in dirs {
            std::fs::create_dir_all(local.join(dir))?;
        }

        let mut downloaded = 0u64;
        for file in files {
            downloaded += self.download(&file.remote, &local.join(file.relative), &mut |n| {
                on_chunk(n, total)
            })?;
        }
        Ok(downloaded)
    }

    /// Upload a local file to a remote path. Returns bytes transferred.
    pub fn upload(&self, local: &Path, remote: &str) -> Result<u64> {
        let bytes = std::fs::read(local)?;
        let mut cursor = Cursor::new(bytes);
        self.with(|s| s.put_file(remote, &mut cursor).map_err(err))
    }

    pub fn mkdir(&self, path: &str) -> Result<()> {
        self.with(|s| s.mkdir(path).map_err(err))
    }

    pub fn remove_file(&self, path: &str) -> Result<()> {
        self.with(|s| s.rm(path).map_err(err))
    }

    pub fn remove_dir(&self, path: &str) -> Result<()> {
        self.with(|s| s.rmdir(path).map_err(err))
    }

    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.with(|s| s.rename(from, to).map_err(err))
    }

    /// Best-effort graceful quit.
    pub fn disconnect(&self) {
        if let Ok(mut s) = self.inner.lock() {
            let _ = s.quit();
        }
    }
}

/// Parse one Unix-style `ls -l` LIST line into (name, kind, size). Returns
/// `None` for lines that don't look like a listing entry.
///
/// Example: `-rw-r--r--  1 owner group  1234 Jan  1 12:00 file.txt`
fn parse_list_line(line: &str) -> Option<(String, EntryKind, u64)> {
    let line = line.trim_end_matches(['\r', '\n']);
    let fields: Vec<&str> = line.split_whitespace().collect();
    // perms links owner group size month day time name...  → at least 9 fields.
    if fields.len() < 9 {
        return None;
    }
    let perms = fields[0];
    if perms.len() < 10 {
        return None;
    }
    let kind = match perms.as_bytes()[0] {
        b'd' => EntryKind::Dir,
        b'l' => EntryKind::Symlink,
        b'-' => EntryKind::File,
        _ => EntryKind::Other,
    };
    let size = fields[4].parse::<u64>().unwrap_or(0);

    // Name is everything after the 8th field (perms..time). Symlinks include
    // " -> target" which we strip.
    let name_start = line.find(fields[8])?;
    let mut name = line[name_start..].to_string();
    if kind == EntryKind::Symlink {
        if let Some(idx) = name.find(" -> ") {
            name.truncate(idx);
        }
    }
    if name.is_empty() {
        return None;
    }
    Some((name, kind, size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults() {
        let cfg: FtpConfig = serde_json::from_str(r#"{"host":"h"}"#).unwrap();
        assert_eq!(cfg.port, 21);
        assert_eq!(cfg.username, "anonymous");
    }

    #[test]
    fn parses_unix_listing() {
        let (name, kind, size) =
            parse_list_line("-rw-r--r--   1 root root        1234 Jan  1 12:00 hello.txt").unwrap();
        assert_eq!(name, "hello.txt");
        assert_eq!(kind, EntryKind::File);
        assert_eq!(size, 1234);

        let (dname, dkind, _) =
            parse_list_line("drwxr-xr-x   2 root root        4096 Jan  1 12:00 docs").unwrap();
        assert_eq!(dname, "docs");
        assert_eq!(dkind, EntryKind::Dir);

        let (lname, lkind, _) =
            parse_list_line("lrwxrwxrwx 1 root root 7 Jan 1 12:00 link -> target").unwrap();
        assert_eq!(lname, "link");
        assert_eq!(lkind, EntryKind::Symlink);
    }

    #[test]
    fn ignores_total_line() {
        assert!(parse_list_line("total 8").is_none());
    }

    #[test]
    fn remote_names_cannot_escape_download_directory() {
        let base = Path::new("download");
        assert_eq!(
            safe_child_path(base, "report.txt").unwrap(),
            base.join("report.txt")
        );
        assert!(safe_child_path(base, "../secret").is_err());
        assert!(safe_child_path(base, "/absolute").is_err());
    }
}
