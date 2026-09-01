//! # hampy-vnc
//!
//! VNC (RFB) client built on [`vnc-rs`]. Like RDP, VNC is graphical: the session
//! decodes server framebuffer updates into RGBA rectangles and accepts
//! pointer/keyboard input. This crate runs the handshake (RFB version, security,
//! optional VNC-auth password) and the polling loop, emitting [`VncEvent`]s the
//! UI paints onto a `<canvas>` and consuming [`VncInput`] from the UI.
//!
//! [`vnc-rs`]: https://crates.io/crates/vnc-rs

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use vnc::{ClientKeyEvent, ClientMouseEvent, PixelFormat, VncConnector, VncEncoding, X11Event};
use hampy_core::{Error, Result};

const SUBSYS: &str = "vnc";

fn err(e: impl std::fmt::Display) -> Error {
    Error::protocol(SUBSYS, e.to_string())
}

/// Connection parameters for a VNC session. Mirrors the TypeScript `VncConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VncConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// VNC-auth password; empty when the server uses no authentication.
    #[serde(default)]
    pub password: String,
}

fn default_port() -> u16 {
    5900
}

/// An event produced by a live VNC session, forwarded to the UI.
#[derive(Debug, Clone)]
pub enum VncEvent {
    /// The framebuffer size; sent when first known and on resize.
    Resized { width: u16, height: u16 },
    /// A rectangle of new RGBA pixels.
    Frame {
        x: u16,
        y: u16,
        width: u16,
        height: u16,
        rgba: Vec<u8>,
    },
    /// Copy an on-screen rectangle to another position (RFB CopyRect).
    CopyRect {
        src_x: u16,
        src_y: u16,
        dst_x: u16,
        dst_y: u16,
        width: u16,
        height: u16,
    },
    /// The session ended (graceful or error).
    Disconnected { reason: Option<String> },
}

/// An input event from the UI, injected into the remote session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VncInput {
    /// Pointer position with an RFB button mask (bit0 left, bit1 middle, bit2
    /// right, bit3 wheel-up, bit4 wheel-down).
    Pointer { x: u16, y: u16, buttons: u8 },
    /// Key event by X11 keysym.
    Key { keysym: u32, down: bool },
}

impl VncInput {
    fn into_x11(self) -> X11Event {
        match self {
            VncInput::Pointer { x, y, buttons } => X11Event::PointerEvent(ClientMouseEvent {
                position_x: x,
                position_y: y,
                bottons: buttons,
            }),
            VncInput::Key { keysym, down } => X11Event::KeyEvent(ClientKeyEvent {
                keycode: keysym,
                down,
            }),
        }
    }
}

/// Handle to a live VNC session. Send input through it; drop it to end it.
#[derive(Debug)]
pub struct VncSession {
    input_tx: mpsc::Sender<VncInput>,
}

impl VncSession {
    /// Inject an input event. Errors only if the session has already ended.
    pub async fn send_input(&self, input: VncInput) -> Result<()> {
        self.input_tx
            .send(input)
            .await
            .map_err(|_| Error::protocol(SUBSYS, "vnc session closed"))
    }
}

/// Connect, authenticate, and start the polling loop. Returns a handle for input
/// plus a receiver of [`VncEvent`]s. The handshake runs before returning.
pub async fn connect(config: &VncConfig) -> Result<(VncSession, mpsc::Receiver<VncEvent>)> {
    let addr = format!("{}:{}", config.host, config.port);
    let tcp = TcpStream::connect(&addr)
        .await
        .map_err(|e| Error::protocol(SUBSYS, format!("connect {addr}: {e}")))?;

    let password = config.password.clone();
    tracing::info!(host = %config.host, port = config.port, "vnc connecting");

    let client = VncConnector::new(tcp)
        .set_auth_method(async move { Ok(password) })
        .add_encoding(VncEncoding::Zrle)
        .add_encoding(VncEncoding::CopyRect)
        .add_encoding(VncEncoding::Raw)
        .allow_shared(true)
        // RGBA so rectangles can be blitted straight to a canvas ImageData.
        .set_pixel_format(PixelFormat::rgba())
        .build()
        .map_err(err)?
        .try_start()
        .await
        .map_err(err)?
        .finish()
        .map_err(err)?;

    tracing::info!(host = %config.host, "vnc connected");

    let (input_tx, input_rx) = mpsc::channel::<VncInput>(256);
    let (event_tx, event_rx) = mpsc::channel::<VncEvent>(256);

    tokio::spawn(drive_session(client, input_rx, event_tx));

    Ok((VncSession { input_tx }, event_rx))
}

/// Poll the engine for framebuffer events, drain UI input, and periodically
/// request incremental updates — all from one task, since `poll_event` and
/// `input` share the client's internal lock.
async fn drive_session(
    client: vnc::VncClient,
    mut input_rx: mpsc::Receiver<VncInput>,
    event_tx: mpsc::Sender<VncEvent>,
) {
    // Ask for a full first frame.
    let _ = client.input(X11Event::FullRefresh).await;

    let mut last_refresh = Instant::now();
    let mut reason: Option<String> = None;

    'session: loop {
        // Forward any pending input (non-blocking).
        loop {
            match input_rx.try_recv() {
                Ok(input) => {
                    if client.input(input.into_x11()).await.is_err() {
                        break 'session;
                    }
                }
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => break 'session,
            }
        }

        match client.poll_event().await {
            Ok(Some(event)) => {
                if !forward_event(event, &event_tx).await {
                    break 'session;
                }
            }
            Ok(None) => tokio::time::sleep(Duration::from_millis(4)).await,
            Err(e) => {
                reason = Some(e.to_string());
                break 'session;
            }
        }

        // Drive incremental updates ~25fps.
        if last_refresh.elapsed() >= Duration::from_millis(40) {
            let _ = client.input(X11Event::Refresh).await;
            last_refresh = Instant::now();
        }
    }

    let _ = client.close().await;
    let _ = event_tx.send(VncEvent::Disconnected { reason }).await;
    tracing::debug!("vnc session driver exited");
}

/// Translate a `vnc-rs` event into our UI event. Returns `false` to stop.
async fn forward_event(event: vnc::VncEvent, tx: &mpsc::Sender<VncEvent>) -> bool {
    let mapped = match event {
        vnc::VncEvent::SetResolution(screen) => Some(VncEvent::Resized {
            width: screen.width,
            height: screen.height,
        }),
        vnc::VncEvent::RawImage(rect, data) => Some(VncEvent::Frame {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            rgba: data,
        }),
        vnc::VncEvent::Copy(dst, src) => Some(VncEvent::CopyRect {
            src_x: src.x,
            src_y: src.y,
            dst_x: dst.x,
            dst_y: dst.y,
            width: dst.width,
            height: dst.height,
        }),
        vnc::VncEvent::Error(message) => {
            let _ = tx
                .send(VncEvent::Disconnected {
                    reason: Some(message),
                })
                .await;
            return false;
        }
        // Cursor shape, bell, clipboard, pixel-format notifications: ignored.
        _ => None,
    };

    match mapped {
        Some(ev) => tx.send(ev).await.is_ok(),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults() {
        let cfg: VncConfig = serde_json::from_str(r#"{"host":"h"}"#).unwrap();
        assert_eq!(cfg.port, 5900);
        assert_eq!(cfg.password, "");
    }

    #[test]
    fn input_serde_pointer() {
        let json = r#"{"kind":"pointer","x":5,"y":6,"buttons":1}"#;
        let i: VncInput = serde_json::from_str(json).unwrap();
        assert!(matches!(
            i,
            VncInput::Pointer {
                x: 5,
                y: 6,
                buttons: 1
            }
        ));
    }
}
