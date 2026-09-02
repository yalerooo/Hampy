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

use futures::{stream, StreamExt, TryStreamExt};
use hampy_core::{Error, Result};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Size of the chunked read/write buffer used by progress-reporting transfers.
const CHUNK_SIZE: usize = 256 * 1024;
/// A small amount of parallelism substantially improves directory downloads
/// with many files without flooding slower SFTP servers with open handles.
const DOWNLOAD_CONCURRENCY: usize = 4;

const SUBSYS: &str = "sftp";

fn err(e: impl std::fmt::Display) -> Error {
    Error::protocol(SUBSYS, e.to_string())
}

fn safe_child_path(base: &std::path::Path, name: &str) -> Result<std::path::PathBuf> {
    let mut components = std::path::Path::new(name).components();
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
    relative: std::path::PathBuf,
    size: u64,
}

#[derive(Debug)]
struct UploadFile {
    local: std::path::PathBuf,
    remote: String,
    size: u64,
}

fn remote_child_path(base: &str, name: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), name)
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

    async fn download_manifest(
        &self,
        path: &str,
    ) -> Result<(Vec<std::path::PathBuf>, Vec<DownloadFile>)> {
        fn recurse<'a>(
            client: &'a SftpClient,
            remote: &'a str,
            relative: &'a std::path::Path,
            dirs: &'a mut Vec<std::path::PathBuf>,
            files: &'a mut Vec<DownloadFile>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                for entry in client.list_dir(remote).await? {
                    let relative_path = safe_child_path(relative, &entry.name)?;
                    if entry.kind == EntryKind::Dir {
                        dirs.push(relative_path.clone());
                        recurse(client, &entry.path, &relative_path, dirs, files).await?;
                    } else {
                        files.push(DownloadFile {
                            remote: entry.path,
                            relative: relative_path,
                            size: entry.size,
                        });
                    }
                }
                Ok(())
            })
        }

        let mut dirs = Vec::new();
        let mut files = Vec::new();
        recurse(self, path, std::path::Path::new(""), &mut dirs, &mut files).await?;
        Ok((dirs, files))
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

    async fn upload_manifest(
        local: &std::path::Path,
        remote: &str,
    ) -> Result<(Vec<String>, Vec<UploadFile>)> {
        fn recurse<'a>(
            local: &'a std::path::Path,
            remote: &'a str,
            dirs: &'a mut Vec<String>,
            files: &'a mut Vec<UploadFile>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                let mut entries = tokio::fs::read_dir(local).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let name = entry.file_name().into_string().map_err(|name| {
                        Error::protocol(
                            SUBSYS,
                            format!("local file name is not valid UTF-8: {name:?}"),
                        )
                    })?;
                    let file_type = entry.file_type().await?;
                    let remote_path = remote_child_path(remote, &name);
                    if file_type.is_dir() {
                        dirs.push(remote_path.clone());
                        recurse(&entry.path(), &remote_path, dirs, files).await?;
                    } else if file_type.is_file() {
                        files.push(UploadFile {
                            local: entry.path(),
                            remote: remote_path,
                            size: entry.metadata().await?.len(),
                        });
                    } else {
                        return Err(Error::protocol(
                            SUBSYS,
                            format!("unsupported local entry: {}", entry.path().display()),
                        ));
                    }
                }
                Ok(())
            })
        }

        let mut dirs = Vec::new();
        let mut files = Vec::new();
        recurse(local, remote, &mut dirs, &mut files).await?;
        Ok((dirs, files))
    }

    async fn ensure_dir(&self, path: &str) -> Result<()> {
        match self.session.metadata(path).await {
            Ok(metadata) if metadata.is_dir() => Ok(()),
            Ok(_) => Err(Error::protocol(
                SUBSYS,
                format!("remote path exists and is not a directory: {path}"),
            )),
            Err(_) => self.session.create_dir(path).await.map_err(err),
        }
    }

    /// Recursively upload a local directory, creating its complete remote tree.
    /// Files are multiplexed with the same bounded concurrency as downloads.
    pub async fn upload_dir(
        &self,
        local: &std::path::Path,
        remote: &str,
        on_chunk: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<u64> {
        let (dirs, files) = Self::upload_manifest(local, remote).await?;
        let total = files.iter().map(|file| file.size).sum();

        self.ensure_dir(remote).await?;
        for dir in dirs {
            self.ensure_dir(&dir).await?;
        }

        stream::iter(files)
            .map(|file| async move {
                self.upload(&file.local, &file.remote, &mut |n| on_chunk(n, total))
                    .await
            })
            .buffer_unordered(DOWNLOAD_CONCURRENCY)
            .try_fold(0u64, |uploaded, bytes| async move { Ok(uploaded + bytes) })
            .await
    }

    /// Recursively download a remote directory into a local one. The remote
    /// tree is enumerated once, then files are multiplexed with bounded
    /// concurrency. `on_chunk` receives the chunk size and total tree size.
    pub async fn download_dir(
        &self,
        remote: &str,
        local: &std::path::Path,
        on_chunk: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<u64> {
        let (dirs, files) = self.download_manifest(remote).await?;
        let total = files.iter().map(|file| file.size).sum();

        tokio::fs::create_dir_all(local).await?;
        for dir in dirs {
            tokio::fs::create_dir_all(local.join(dir)).await?;
        }

        stream::iter(files)
            .map(|file| async move {
                let local_path = local.join(file.relative);
                self.download(&file.remote, &local_path, &mut |n| on_chunk(n, total))
                    .await
            })
            .buffer_unordered(DOWNLOAD_CONCURRENCY)
            .try_fold(
                0u64,
                |downloaded, bytes| async move { Ok(downloaded + bytes) },
            )
            .await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_names_cannot_escape_download_directory() {
        let base = std::path::Path::new("download");
        assert_eq!(
            safe_child_path(base, "report.txt").unwrap(),
            base.join("report.txt")
        );
        assert!(safe_child_path(base, "../secret").is_err());
        assert!(safe_child_path(base, "/absolute").is_err());
    }
}
