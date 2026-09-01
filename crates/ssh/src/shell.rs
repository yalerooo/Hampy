//! Interactive SSH shell channel: a PTY-backed shell whose output is streamed
//! to the caller and whose input/resize/close are driven through a command
//! channel. The design mirrors the local terminal so the frontend can treat an
//! SSH shell exactly like a local one.

use russh::client::{Handle, Msg};
use russh::Channel;
use russh::ChannelMsg;
use tokio::sync::mpsc;
use hampy_core::{Error, Result};

const SUBSYS: &str = "ssh";

/// Commands sent to the task that owns the SSH channel.
enum ShellCmd {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// Handle to a live SSH shell. Cloning is cheap (the command sender is shared);
/// dropping all clones leaves the driver task running until [`Self::close`].
#[derive(Clone)]
pub struct SshShell {
    tx: mpsc::Sender<ShellCmd>,
}

impl std::fmt::Debug for SshShell {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshShell").finish_non_exhaustive()
    }
}

impl SshShell {
    /// Write raw input (keystrokes, pasted text) to the remote shell.
    pub async fn write(&self, data: &[u8]) -> Result<()> {
        self.send(ShellCmd::Data(data.to_vec())).await
    }

    /// Resize the remote PTY.
    pub async fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        self.send(ShellCmd::Resize {
            cols: cols as u32,
            rows: rows as u32,
        })
        .await
    }

    /// Close the shell channel.
    pub async fn close(&self) -> Result<()> {
        self.send(ShellCmd::Close).await
    }

    async fn send(&self, cmd: ShellCmd) -> Result<()> {
        self.tx
            .send(cmd)
            .await
            .map_err(|_| Error::protocol(SUBSYS, "shell channel closed"))
    }
}

/// Open a shell channel over `handle`, returning a [`SshShell`] handle and a
/// receiver yielding output byte chunks. A background task owns the channel and
/// bridges between russh's message stream and the command/output channels.
pub(crate) async fn open_shell(
    handle: &Handle<crate::client::Client>,
    rows: u16,
    cols: u16,
) -> Result<(SshShell, mpsc::Receiver<Vec<u8>>)> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| Error::protocol(SUBSYS, e.to_string()))?;

    channel
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|e| Error::protocol(SUBSYS, e.to_string()))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| Error::protocol(SUBSYS, e.to_string()))?;

    let (cmd_tx, cmd_rx) = mpsc::channel::<ShellCmd>(256);
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(256);

    tokio::spawn(drive_channel(channel, cmd_rx, out_tx));

    Ok((SshShell { tx: cmd_tx }, out_rx))
}

/// The driver loop: multiplex remote output and local commands over one channel.
async fn drive_channel(
    mut channel: Channel<Msg>,
    mut cmd_rx: mpsc::Receiver<ShellCmd>,
    out_tx: mpsc::Sender<Vec<u8>>,
) {
    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if out_tx.send(data.to_vec()).await.is_err() {
                            break; // consumer dropped
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = out_tx.send(data.to_vec()).await;
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(ShellCmd::Data(bytes)) => {
                        if channel.data(&bytes[..]).await.is_err() {
                            break;
                        }
                    }
                    Some(ShellCmd::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(ShellCmd::Close) | None => {
                        let _ = channel.eof().await;
                        break;
                    }
                }
            }
        }
    }
    tracing::debug!("ssh shell driver exited");
}
