//! # hampy-sftp
//!
//! SFTP client built on [`russh_sftp`]. It is transport-agnostic: it operates
//! over any byte stream implementing [`tokio::io::AsyncRead`] +
//! [`tokio::io::AsyncWrite`], so the application supplies the `sftp` subsystem
//! channel obtained from `hampy-ssh` and this crate speaks the protocol.
//!
//! Phase 2 surface: directory listing, stat, upload, download, mkdir, remove,
//! and rename. Parallel transfer queues and folder sync/compare build on these
//! primitives in a later iteration.

use hampy_core::{Error, Result};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Size of the chunked read/write buffer used by progress-reporting transfers.
const CHUNK_SIZE: usize = 256 * 1024;

const SUBSYS: &str = "sftp";

fn err(e: impl std::fmt::Display) -> Error {
    Error::protocol(SUBSYS, e.to_string())
}

/// Kind of a remote filesystem entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
    Other,
}

/// A single entry in a remote directory listing, serializable for the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Last-modified time as a Unix timestamp (seconds), if known.
    pub modified: Option<i64>,
    /// Unix permissions rendered `ls -l`-style (e.g. `rwxr-xr-x`), if reported.
    pub permissions: Option<String>,
    /// Owning user — a symbolic name when the application can resolve it (see
    /// the SFTP command layer), otherwise left for the caller to fill.
    pub owner: Option<String>,
    /// Owning group — symbolic name when resolved, else filled by the caller.
    pub group: Option<String>,
    /// Raw numeric owner id from the SFTP attributes (SFTP v3 only sends ids,
    /// not names — the app resolves these to `owner`/`group` over SSH).
    pub uid: Option<u32>,
    /// Raw numeric group id from the SFTP attributes.
    pub gid: Option<u32>,
}

/// Render Unix permission bits as a `ls -l`-style string, e.g. `rwxr-xr-x`.
pub fn permissions_string(mode: u32) -> String {
    let bit = |flag: u32, c: char| if mode & flag != 0 { c } else { '-' };
    [
        bit(0o400, 'r'),
        bit(0o200, 'w'),
        bit(0o100, 'x'),
        bit(0o040, 'r'),
        bit(0o020, 'w'),
        bit(0o010, 'x'),
        bit(0o004, 'r'),
        bit(0o002, 'w'),
        bit(0o001, 'x'),
    ]
    .iter()
    .collect()
}

/// An SFTP session over an established byte stream.
pub struct SftpClient {
    session: SftpSession,
}

impl std::fmt::Debug for SftpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SftpClient").finish_non_exhaustive()
    }
}

impl SftpClient {
    /// Negotiate an SFTP session over `stream` (typically an SSH `sftp`
    /// subsystem channel).
    pub async fn open<S>(stream: S) -> Result<Self>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let session = SftpSession::new(stream).await.map_err(err)?;
        Ok(SftpClient { session })
    }

    /// Resolve the canonical absolute form of `path` (e.g. the home directory
    /// for ".").
    pub async fn canonicalize(&self, path: &str) -> Result<String> {
        self.session.canonicalize(path).await.map_err(err)
    }

    /// List the entries of a remote directory, sorted dirs-first then by name.
    pub async fn list_dir(&self, path: &str) -> Result<Vec<SftpEntry>> {
        let dir = self.session.read_dir(path).await.map_err(err)?;
        let base = path.trim_end_matches('/');
        let mut entries: Vec<SftpEntry> = dir
            .map(|item| {
                let name = item.file_name();
                let meta = item.metadata();
                let kind = if meta.is_dir() {
                    EntryKind::Dir
                } else if meta.file_type().is_symlink() {
                    EntryKind::Symlink
                } else {
                    EntryKind::File
                };
                let full = format!("{base}/{name}");
                SftpEntry {
                    name,
                    path: full,
                    kind,
                    size: meta.size.unwrap_or(0),
                    modified: meta.mtime.map(|m| m as i64),
                    permissions: meta.permissions.map(permissions_string),
                    owner: meta.user.clone(),
                    group: meta.group.clone(),
                    uid: meta.uid,
                    gid: meta.gid,
                }
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

    /// Size of a remote file, in bytes (0 if the server doesn't report one).
    pub async fn file_size(&self, remote: &str) -> Result<u64> {
        Ok(self
            .session
            .metadata(remote)
            .await
            .map_err(err)?
            .size
            .unwrap_or(0))
    }

    /// Sum of file sizes under a remote directory, recursing into sub-directories.
    pub async fn dir_size(&self, path: &str) -> Result<u64> {
        fn recurse<'a>(
            client: &'a SftpClient,
            path: &'a str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64>> + Send + 'a>> {
            Box::pin(async move {
                let mut total = 0u64;
                for entry in client.list_dir(path).await? {
                    if entry.kind == EntryKind::Dir {
                        total += recurse(client, &entry.path).await?;
                    } else {
                        total += entry.size;
                    }
                }
                Ok(total)
            })
        }
        recurse(self, path).await
    }

    /// Download a remote file to a local path, reporting each chunk's size to
    /// `on_chunk` as it's written. Returns bytes transferred.
    pub async fn download(
        &self,
        remote: &str,
        local: &std::path::Path,
        on_chunk: &mut (dyn FnMut(u64) + Send),
    ) -> Result<u64> {
        let mut remote_file = self.session.open(remote).await.map_err(err)?;
        let mut local_file = tokio::fs::File::create(local).await?;
        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut total = 0u64;
        loop {
            let n = remote_file.read(&mut buf).await.map_err(err)?;
            if n == 0 {
                break;
            }
            local_file.write_all(&buf[..n]).await?;
            total += n as u64;
            on_chunk(n as u64);
        }
        local_file.flush().await?;
        tracing::info!(remote, bytes = total, "sftp download complete");
        Ok(total)
    }

    /// Upload a local file to a remote path, reporting each chunk's size to
    /// `on_chunk` as it's sent. Returns bytes transferred.
    pub async fn upload(
        &self,
        local: &std::path::Path,
        remote: &str,
        on_chunk: &mut (dyn FnMut(u64) + Send),
    ) -> Result<u64> {
        let mut local_file = tokio::fs::File::open(local).await?;
        let mut remote_file = self.session.create(remote).await.map_err(err)?;
        let mut buf = vec![0u8; CHUNK_SIZE];
        let mut total = 0u64;
        loop {
            let n = local_file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            remote_file.write_all(&buf[..n]).await.map_err(err)?;
            total += n as u64;
            on_chunk(n as u64);
        }
        remote_file.flush().await.map_err(err)?;
        tracing::info!(remote, bytes = total, "sftp upload complete");
        Ok(total)
    }

    /// Recursively download a remote directory into a local one, creating
    /// sub-directories as needed and reporting each file chunk's size to
    /// `on_chunk`.
    pub async fn download_dir(
        &self,
        remote: &str,
        local: &std::path::Path,
        on_chunk: &(dyn Fn(u64) + Send + Sync),
    ) -> Result<()> {
        fn recurse<'a>(
            client: &'a SftpClient,
            remote: &'a str,
            local: &'a std::path::Path,
            on_chunk: &'a (dyn Fn(u64) + Send + Sync),
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                tokio::fs::create_dir_all(local).await?;
                for entry in client.list_dir(remote).await? {
                    let local_path = local.join(&entry.name);
                    if entry.kind == EntryKind::Dir {
                        recurse(client, &entry.path, &local_path, on_chunk).await?;
                    } else {
                        client
                            .download(&entry.path, &local_path, &mut |n| on_chunk(n))
                            .await?;
                    }
                }
                Ok(())
            })
        }
        recurse(self, remote, local, on_chunk).await
    }

    /// Copy a remote file to another remote path, streaming the bytes through
    /// this same session (no local round-trip). Returns bytes transferred.
    pub async fn copy(&self, from: &str, to: &str) -> Result<u64> {
        let mut src = self.session.open(from).await.map_err(err)?;
        let mut dst = self.session.create(to).await.map_err(err)?;
        let n = tokio::io::copy(&mut src, &mut dst).await?;
        tracing::info!(from, to, bytes = n, "sftp copy complete");
        Ok(n)
    }

    /// Create a directory.
    pub async fn mkdir(&self, path: &str) -> Result<()> {
        self.session.create_dir(path).await.map_err(err)
    }

    /// Remove a file.
    pub async fn remove_file(&self, path: &str) -> Result<()> {
        self.session.remove_file(path).await.map_err(err)
    }

    /// Remove an (empty) directory.
    pub async fn remove_dir(&self, path: &str) -> Result<()> {
        self.session.remove_dir(path).await.map_err(err)
    }

    /// Recursively remove a directory and everything under it. Files are
    /// unlinked, sub-directories descended into, then the directory itself is
    /// removed.
    pub async fn remove_dir_all(&self, path: &str) -> Result<()> {
        // Async recursion needs an explicit boxed future.
        fn recurse<'a>(
            client: &'a SftpClient,
            path: &'a str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                for entry in client.list_dir(path).await? {
                    if entry.kind == EntryKind::Dir {
                        recurse(client, &entry.path).await?;
                    } else {
                        client.remove_file(&entry.path).await?;
                    }
                }
                client.remove_dir(path).await
            })
        }
        recurse(self, path).await
    }

    /// Rename / move a remote entry.
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.session.rename(from, to).await.map_err(err)
    }
}
