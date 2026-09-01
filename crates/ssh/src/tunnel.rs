//! SSH port forwarding.
//!
//! Local (`-L`) forwarding is implemented: a local TCP listener accepts
//! connections and pipes each one over a `direct-tcpip` channel to a target
//! reachable from the SSH server. Remote (`-R`) and dynamic SOCKS (`-D`)
//! forwarding are scaffolded for the next Phase 2 iteration.

use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::sync::Notify;
use hampy_core::{Error, Result};

use crate::client::Client;

const SUBSYS: &str = "ssh";

/// A running local port-forward. Drop it or call [`Self::stop`] to tear down the
/// listener; in-flight connections finish on their own.
#[derive(Debug)]
pub struct LocalForward {
    local_addr: std::net::SocketAddr,
    shutdown: Arc<Notify>,
}

impl LocalForward {
    /// The actually-bound local address (useful when binding to port 0).
    pub fn local_addr(&self) -> std::net::SocketAddr {
        self.local_addr
    }

    /// Signal the accept loop to stop.
    pub fn stop(&self) {
        self.shutdown.notify_waiters();
    }
}

impl Drop for LocalForward {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Bind `local_bind` and forward every accepted connection to
/// `remote_host:remote_port` as seen from the SSH server.
pub(crate) async fn local_forward(
    handle: std::sync::Arc<russh::client::Handle<Client>>,
    local_bind: &str,
    remote_host: String,
    remote_port: u16,
) -> Result<LocalForward> {
    let listener = TcpListener::bind(local_bind)
        .await
        .map_err(|e| Error::protocol(SUBSYS, format!("bind {local_bind}: {e}")))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| Error::protocol(SUBSYS, e.to_string()))?;
    let shutdown = Arc::new(Notify::new());

    let task_shutdown = shutdown.clone();
    tokio::spawn(async move {
        tracing::info!(%local_addr, %remote_host, remote_port, "local forward listening");
        loop {
            tokio::select! {
                _ = task_shutdown.notified() => break,
                accepted = listener.accept() => {
                    let Ok((mut inbound, peer)) = accepted else { break };
                    let handle = handle.clone();
                    let remote_host = remote_host.clone();
                    tokio::spawn(async move {
                        let channel = match handle
                            .channel_open_direct_tcpip(
                                remote_host,
                                remote_port as u32,
                                &peer.ip().to_string(),
                                peer.port() as u32,
                            )
                            .await
                        {
                            Ok(c) => c,
                            Err(e) => {
                                tracing::warn!(error = %e, "direct-tcpip open failed");
                                return;
                            }
                        };
                        let mut stream = channel.into_stream();
                        if let Err(e) =
                            tokio::io::copy_bidirectional(&mut inbound, &mut stream).await
                        {
                            tracing::debug!(error = %e, "forwarded connection closed");
                        }
                    });
                }
            }
        }
        tracing::info!(%local_addr, "local forward stopped");
    });

    Ok(LocalForward {
        local_addr,
        shutdown,
    })
}
