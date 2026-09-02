//! SSH connection establishment and authentication, built on `russh`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use hampy_core::{Error, Result};
use russh::client::{self, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::{Algorithm, PrivateKeyWithHashAlg};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::config::{HostKeyPolicy, SshAuth, SshConfig};
use crate::shell::{open_shell, SshShell};

/// Maps an internal type tag for [`Error::Protocol`].
const SUBSYS: &str = "ssh";

fn err(e: impl std::fmt::Display) -> Error {
    Error::protocol(SUBSYS, e.to_string())
}

/// `russh` client handler. Enforces the host-key policy against a persistent
/// `known_hosts` file (OpenSSH format): first-seen keys are remembered under
/// [`HostKeyPolicy::AcceptNew`] (true trust-on-first-use), a changed key for a
/// known host is always rejected as a possible MITM, and [`HostKeyPolicy::Strict`]
/// rejects any host not already recorded.
pub(crate) struct Client {
    policy: HostKeyPolicy,
    host: String,
    port: u16,
    /// Path to the `known_hosts` store. `None` disables persistence (used by
    /// tests): `AcceptNew` then trusts without recording, `Strict` rejects.
    known_hosts: Option<PathBuf>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(Default::default());

        let Some(path) = self.known_hosts.as_ref() else {
            // No persistent store: fall back to pure policy.
            return match self.policy {
                HostKeyPolicy::AcceptNew => {
                    tracing::info!(%fingerprint, "accepting host key (TOFU, not persisted)");
                    Ok(true)
                }
                HostKeyPolicy::Strict => {
                    tracing::warn!(%fingerprint, "rejecting host key (strict, no store)");
                    Ok(false)
                }
            };
        };

        match russh::keys::check_known_hosts_path(&self.host, self.port, server_public_key, path) {
            // Recognized and matches a recorded key.
            Ok(true) => {
                tracing::debug!(host = %self.host, %fingerprint, "host key matches known_hosts");
                Ok(true)
            }
            // Host not recorded yet.
            Ok(false) => match self.policy {
                HostKeyPolicy::AcceptNew => {
                    if let Err(e) = russh::keys::known_hosts::learn_known_hosts_path(
                        &self.host,
                        self.port,
                        server_public_key,
                        path,
                    ) {
                        tracing::warn!(error = %e, "failed to persist new host key");
                    } else {
                        tracing::info!(host = %self.host, %fingerprint, "learned new host key (TOFU)");
                    }
                    Ok(true)
                }
                HostKeyPolicy::Strict => {
                    tracing::warn!(host = %self.host, %fingerprint, "unknown host key rejected (strict)");
                    Ok(false)
                }
            },
            // Same host, *different* key — refuse regardless of policy.
            Err(russh::keys::Error::KeyChanged { line }) => {
                tracing::error!(
                    host = %self.host, %fingerprint, line,
                    "host key MISMATCH against known_hosts — possible MITM; rejecting"
                );
                Ok(false)
            }
            Err(e) => {
                tracing::warn!(error = %e, "known_hosts check failed; rejecting");
                Ok(false)
            }
        }
    }
}

/// A live, authenticated SSH connection. Keep it alive for as long as any
/// channel (shell, tunnel) opened from it is in use. The handle is shared via
/// `Arc` so background tasks (port forwards) can open channels concurrently —
/// `russh`'s `Handle` opens channels through `&self`. Cloning is cheap (shared
/// `Arc`) and lets callers run a probe without holding a session lock.
#[derive(Clone)]
pub struct SshClient {
    handle: Arc<Handle<Client>>,
}

impl std::fmt::Debug for SshClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshClient").finish_non_exhaustive()
    }
}

impl SshClient {
    /// Connect to the endpoint described by `config` and authenticate, verifying
    /// the server host key against the `known_hosts` file at `known_hosts` (pass
    /// `None` to disable persistence). Jump hosts, if present, are not yet
    /// traversed (tracked for a follow-up); a direct connection is attempted.
    pub async fn connect(config: &SshConfig, known_hosts: Option<PathBuf>) -> Result<Self> {
        let mut russh_config = client::Config::default();
        if let Some(secs) = config.keepalive_secs {
            russh_config.inactivity_timeout = Some(Duration::from_secs(secs.max(1) * 4));
            russh_config.keepalive_interval = Some(Duration::from_secs(secs.max(1)));
        }
        let russh_config = Arc::new(russh_config);

        let handler = Client {
            policy: config.host_key_policy,
            host: config.host.clone(),
            port: config.port,
            known_hosts,
        };

        tracing::info!(host = %config.host, port = config.port, "ssh connecting");
        let mut handle =
            client::connect(russh_config, (config.host.as_str(), config.port), handler)
                .await
                .map_err(err)?;

        Self::authenticate(&mut handle, &config.auth).await?;
        tracing::info!(host = %config.host, "ssh authenticated");

        Ok(SshClient {
            handle: Arc::new(handle),
        })
    }

    async fn authenticate(handle: &mut Handle<Client>, auth: &SshAuth) -> Result<()> {
        let authenticated = match auth {
            SshAuth::Password { username, password } => handle
                .authenticate_password(username, password)
                .await
                .map_err(err)?
                .success(),
            SshAuth::Key {
                username,
                private_key,
                passphrase,
            } => {
                let key = russh::keys::decode_secret_key(private_key, passphrase.as_deref())
                    .map_err(|e| Error::protocol(SUBSYS, format!("invalid private key: {e}")))?;
                let hash = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(err)?
                    .flatten();
                handle
                    .authenticate_publickey(
                        username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(err)?
                    .success()
            }
            SshAuth::Agent { username } => authenticate_agent(handle, username).await?,
        };

        if authenticated {
            Ok(())
        } else {
            Err(Error::Forbidden("ssh authentication failed".into()))
        }
    }

    /// Open an interactive shell with a PTY of the given size.
    pub async fn open_shell(
        &self,
        rows: u16,
        cols: u16,
    ) -> Result<(SshShell, tokio::sync::mpsc::Receiver<Vec<u8>>)> {
        open_shell(&self.handle, rows, cols).await
    }

    /// Run a single command on the remote host and return its captured stdout.
    /// Stderr is discarded. Intended for short probes (telemetry, version
    /// checks), not long-running or interactive processes.
    pub async fn exec(&self, command: &str) -> Result<String> {
        let mut channel = self.handle.channel_open_session().await.map_err(err)?;
        channel.exec(true, command).await.map_err(err)?;

        let mut stdout: Vec<u8> = Vec::new();
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                // ExtendedData is stderr — ignore for probes.
                Some(russh::ChannelMsg::ExtendedData { .. }) => {}
                Some(russh::ChannelMsg::Eof)
                | Some(russh::ChannelMsg::Close)
                | Some(russh::ChannelMsg::ExitStatus { .. })
                | None => break,
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    }

    /// Open the `sftp` subsystem and return the channel as a byte stream. The
    /// caller wraps it with an SFTP protocol client (see `hampy-sftp`).
    pub async fn open_sftp_stream(&self) -> Result<russh::ChannelStream<russh::client::Msg>> {
        let channel = self.handle.channel_open_session().await.map_err(err)?;
        channel.request_subsystem(true, "sftp").await.map_err(err)?;
        Ok(channel.into_stream())
    }

    /// Start a local (`-L`) port forward: bind `local_bind` locally and tunnel
    /// each connection to `remote_host:remote_port` via the SSH server.
    pub async fn local_forward(
        &self,
        local_bind: &str,
        remote_host: impl Into<String>,
        remote_port: u16,
    ) -> Result<crate::tunnel::LocalForward> {
        crate::tunnel::local_forward(
            self.handle.clone(),
            local_bind,
            remote_host.into(),
            remote_port,
        )
        .await
    }

    /// Gracefully disconnect the session.
    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
    }
}

/// Authenticate by delegating signing to a running SSH agent. Connects to the
/// platform agent endpoint (Unix domain socket via `$SSH_AUTH_SOCK`, the OpenSSH
/// named pipe on Windows), then tries each offered identity in turn.
async fn authenticate_agent(handle: &mut Handle<Client>, username: &str) -> Result<bool> {
    #[cfg(unix)]
    let agent = AgentClient::connect_env()
        .await
        .map_err(|e| Error::protocol(SUBSYS, format!("connect to ssh agent: {e}")))?;

    #[cfg(windows)]
    let agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
        .await
        .map_err(|e| Error::protocol(SUBSYS, format!("connect to ssh agent: {e}")))?;

    #[cfg(not(any(unix, windows)))]
    return Err(Error::protocol(
        SUBSYS,
        "ssh agent is not supported on this platform",
    ));

    #[cfg(any(unix, windows))]
    agent_auth_with(handle, username, agent).await
}

/// Try each identity the agent offers against `handle`, returning on the first
/// success. Generic over the agent transport so the platform branches above
/// share one loop.
async fn agent_auth_with<R>(
    handle: &mut Handle<Client>,
    username: &str,
    mut agent: AgentClient<R>,
) -> Result<bool>
where
    R: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| Error::protocol(SUBSYS, format!("list agent identities: {e}")))?;

    if identities.is_empty() {
        return Err(Error::protocol(
            SUBSYS,
            "ssh agent has no identities loaded",
        ));
    }

    // RSA keys need an explicit SHA-2 hash negotiated with the server; other
    // key types sign without one.
    let rsa_hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(err)?
        .flatten();

    for key in identities {
        let hash_alg = if matches!(key.algorithm(), Algorithm::Rsa { .. }) {
            rsa_hash
        } else {
            None
        };
        let result = handle
            .authenticate_publickey_with(username, key, hash_alg, &mut agent)
            .await
            .map_err(|e| Error::protocol(SUBSYS, format!("agent sign: {e}")))?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use russh::keys::ssh_key::PublicKey;

    // A real, valid ed25519 public key (OpenSSH test vector). Public material
    // only — safe to embed. No trailing comment: a host key seen on the wire
    // carries none, and `PublicKey` equality includes the comment field.
    const SAMPLE_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti";

    #[test]
    fn known_hosts_roundtrip() {
        // Hermetic, collision-free temp dir (Windows can reuse PIDs).
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hampy-kh-{}-{}", std::process::id(), nanos));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("known_hosts");

        let key = PublicKey::from_openssh(SAMPLE_KEY).unwrap();

        // Unknown host before learning.
        assert!(
            !russh::keys::check_known_hosts_path("example.com", 22, &key, &path).unwrap(),
            "host should be unknown before it is learned"
        );

        // Learn, then it must be recognized.
        russh::keys::known_hosts::learn_known_hosts_path("example.com", 22, &key, &path).unwrap();
        assert!(
            russh::keys::check_known_hosts_path("example.com", 22, &key, &path).unwrap(),
            "host should be trusted after learning its key"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
