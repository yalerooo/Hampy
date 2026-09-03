//! # hampy-rdp
//!
//! RDP client built on [IronRDP]. Unlike the byte-stream protocols (SSH, serial),
//! RDP is graphical: the session decodes server graphics updates into an RGBA
//! framebuffer and accepts keyboard/mouse input. This crate runs the connection
//! handshake (TLS + optional NLA/CredSSP) and the active session loop, emitting
//! dirty-region [`RdpEvent::Frame`] updates the UI paints onto a `<canvas>`, and
//! consuming [`RdpInput`] events sent back from the UI.
//!
//! TLS uses `native-tls` (schannel on Windows — no NASM — and system OpenSSL on
//! Linux); self-signed server certificates are accepted, as is standard for RDP.
//!
//! [IronRDP]: https://github.com/Devolutions/IronRDP

use hampy_core::{Error, Result};
use ironrdp::connector::sspi::generator::NetworkRequest;
use ironrdp::connector::{
    self, ClientConnector, ConnectorError, ConnectorErrorExt, ConnectorErrorKind, ConnectorResult,
    Credentials, ServerName,
};
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::geometry::InclusiveRectangle;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageOutput};
use ironrdp_async::FramedWrite as _;
use ironrdp_cliprdr::backend::{ClipboardMessage, ClipboardMessageProxy, CliprdrBackend};
use ironrdp_cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
    OwnedFormatDataResponse,
};
use ironrdp_cliprdr::CliprdrClient;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::mpsc;

const SUBSYS: &str = "rdp";
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(45);

fn err(e: impl std::fmt::Display) -> Error {
    Error::protocol(SUBSYS, e.to_string())
}

fn connector_error(phase: &str, error: ConnectorError) -> Error {
    let message = match error.kind() {
        ConnectorErrorKind::Credssp(source) => format!(
            "authentication failed during CredSSP: {source}. Check the username, password, and domain"
        ),
        ConnectorErrorKind::AccessDenied => {
            "authentication was denied by the remote computer. Check the username, password, and domain".to_owned()
        }
        _ => format!("{phase}: {}", error.report()),
    };
    Error::protocol(SUBSYS, message)
}

/// Connection parameters for an RDP session. Mirrors the TypeScript `RdpConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RdpConfig {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default = "default_width")]
    pub width: u16,
    #[serde(default = "default_height")]
    pub height: u16,
    /// Whether text may be exchanged with the remote desktop via CLIPRDR.
    #[serde(default)]
    pub clipboard_enabled: bool,
}

fn default_port() -> u16 {
    3389
}
fn default_width() -> u16 {
    1280
}
fn default_height() -> u16 {
    800
}

/// An event produced by a live RDP session, forwarded to the UI.
#[derive(Debug, Clone)]
pub enum RdpEvent {
    /// The negotiated desktop size; sent once before any frame.
    Resized { width: u16, height: u16 },
    /// A dirty rectangle of the framebuffer, as tightly-packed RGBA8.
    Frame {
        x: u16,
        y: u16,
        width: u16,
        height: u16,
        rgba: Vec<u8>,
    },
    /// The session ended (graceful or error).
    Disconnected { reason: Option<String> },
    /// Text copied in the remote desktop and ready for the local clipboard.
    Clipboard { text: String },
}

/// An input event from the UI, injected into the remote session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RdpInput {
    MouseMove {
        x: u16,
        y: u16,
    },
    MouseButton {
        button: u8,
        pressed: bool,
    },
    Wheel {
        delta: i16,
        horizontal: bool,
    },
    Key {
        scancode: u16,
        pressed: bool,
    },
    Unicode {
        ch: char,
        pressed: bool,
    },
    /// Text copied locally and made available to the remote desktop.
    Clipboard {
        text: String,
    },
}

impl RdpInput {
    fn to_operations(&self) -> Vec<Operation> {
        match *self {
            RdpInput::MouseMove { x, y } => vec![Operation::MouseMove(MousePosition { x, y })],
            RdpInput::MouseButton { button, pressed } => {
                match MouseButton::from_web_button(button) {
                    Some(b) if pressed => vec![Operation::MouseButtonPressed(b)],
                    Some(b) => vec![Operation::MouseButtonReleased(b)],
                    None => Vec::new(),
                }
            }
            RdpInput::Wheel { delta, horizontal } => {
                vec![Operation::WheelRotations(WheelRotations {
                    is_vertical: !horizontal,
                    rotation_units: delta,
                })]
            }
            RdpInput::Key { scancode, pressed } => {
                let sc = Scancode::from_u16(scancode);
                vec![if pressed {
                    Operation::KeyPressed(sc)
                } else {
                    Operation::KeyReleased(sc)
                }]
            }
            RdpInput::Unicode { ch, pressed } => vec![if pressed {
                Operation::UnicodeKeyPressed(ch)
            } else {
                Operation::UnicodeKeyReleased(ch)
            }],
            RdpInput::Clipboard { .. } => Vec::new(),
        }
    }
}

#[derive(Debug)]
struct ChannelClipboardProxy {
    tx: mpsc::UnboundedSender<ClipboardMessage>,
}

impl ClipboardMessageProxy for ChannelClipboardProxy {
    fn send_clipboard_message(&self, message: ClipboardMessage) {
        let _ = self.tx.send(message);
    }
}

/// Text-only clipboard backend. The WebView owns the OS clipboard permission;
/// this backend only translates text to and from the RDP CLIPRDR channel.
#[derive(Debug)]
struct HampyClipboardBackend {
    proxy: ChannelClipboardProxy,
    local_text: Arc<Mutex<String>>,
    event_tx: mpsc::Sender<RdpEvent>,
    temporary_directory: String,
}

ironrdp::core::impl_as_any!(HampyClipboardBackend);

impl CliprdrBackend for HampyClipboardBackend {
    fn temporary_directory(&self) -> &str {
        &self.temporary_directory
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::empty()
    }

    fn on_ready(&mut self) {}

    fn on_request_format_list(&mut self) {
        self.proxy
            .send_clipboard_message(ClipboardMessage::SendInitiateCopy(vec![
                ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
            ]));
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        _capabilities: ClipboardGeneralCapabilityFlags,
    ) {
    }

    fn on_remote_copy(&mut self, formats: &[ClipboardFormat]) {
        if formats
            .iter()
            .any(|format| format.id() == ClipboardFormatId::CF_UNICODETEXT)
        {
            self.proxy
                .send_clipboard_message(ClipboardMessage::SendInitiatePaste(
                    ClipboardFormatId::CF_UNICODETEXT,
                ));
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let response = if request.format == ClipboardFormatId::CF_UNICODETEXT {
            let text = self.local_text.lock().unwrap_or_else(|e| e.into_inner());
            OwnedFormatDataResponse::new_unicode_string(&text)
        } else {
            OwnedFormatDataResponse::new_error()
        };
        self.proxy
            .send_clipboard_message(ClipboardMessage::SendFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            return;
        }
        if let Ok(text) = response.to_unicode_string() {
            let _ = self.event_tx.try_send(RdpEvent::Clipboard { text });
        }
    }

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {}
    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}
    fn on_lock(&mut self, _data_id: LockDataId) {}
    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

/// Handle to a live RDP session. Send input through it; drop it (or call
/// [`Self::close`]) to end the session.
#[derive(Debug)]
pub struct RdpSession {
    input_tx: mpsc::Sender<RdpInput>,
}

impl RdpSession {
    /// Inject an input event. Errors only if the session has already ended.
    pub async fn send_input(&self, input: RdpInput) -> Result<()> {
        self.input_tx
            .send(input)
            .await
            .map_err(|_| Error::protocol(SUBSYS, "rdp session closed"))
    }
}

/// Kerberos KDC proxy client. Password (NTLM) NLA never invokes it; if a server
/// requires Kerberos, we surface a clear error rather than pulling in an HTTP
/// stack.
struct NoKdcNetworkClient;

impl ironrdp_async::NetworkClient for NoKdcNetworkClient {
    async fn send(&mut self, _request: &NetworkRequest) -> ConnectorResult<Vec<u8>> {
        Err(ConnectorError::general(
            "Kerberos KDC proxying is not supported (use password/NTLM authentication)",
        ))
    }
}

/// Accept both the split `domain` + `username` representation used by Hampy
/// and the `DOMAIN\username` / `username@domain` forms users commonly paste.
/// IronRDP rejects a qualified username when a separate domain is also set.
fn normalized_identity(config: &RdpConfig) -> (String, Option<String>) {
    let raw_username = config.username.trim();
    let mut domain = config
        .domain
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if raw_username.contains('@') {
        // A UPN already carries its domain suffix.
        return (raw_username.to_owned(), None);
    }

    if let Some((inline_domain, account)) = raw_username.split_once('\\') {
        if domain.is_none() && !inline_domain.trim().is_empty() {
            domain = Some(inline_domain.trim().to_owned());
        }
        return (account.trim().to_owned(), domain);
    }

    (raw_username.to_owned(), domain)
}

fn build_config(config: &RdpConfig) -> connector::Config {
    let (username, domain) = normalized_identity(config);
    connector::Config {
        credentials: Credentials::UsernamePassword {
            username,
            password: config.password.clone(),
        },
        domain,
        // Allow both legacy TLS and NLA; the server negotiates.
        enable_tls: true,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize {
            width: config.width,
            height: config.height,
        },
        bitmap: None,
        client_build: 0,
        client_name: "Hampy".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: platform(),
        enable_server_pointer: false,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        compression_type: None,
        pointer_software_rendering: true,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    }
}

fn platform() -> MajorPlatformType {
    #[cfg(windows)]
    {
        MajorPlatformType::WINDOWS
    }
    #[cfg(target_os = "macos")]
    {
        MajorPlatformType::MACINTOSH
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        MajorPlatformType::UNIX
    }
}

/// Connect, authenticate, and start the active session loop. Returns a handle
/// for input plus a receiver of [`RdpEvent`]s. The TCP/TLS/NLA handshake runs
/// before returning, so connection failures surface here.
pub async fn connect(config: &RdpConfig) -> Result<(RdpSession, mpsc::Receiver<RdpEvent>)> {
    let host = config.host.trim();
    if host.is_empty() {
        return Err(Error::protocol(SUBSYS, "host is required"));
    }
    if config.username.trim().is_empty() {
        return Err(Error::protocol(SUBSYS, "username is required"));
    }
    if config.username.trim().eq_ignore_ascii_case("<default>") {
        return Err(Error::protocol(
            SUBSYS,
            "MobaXterm's <default> login is not included in exported sessions; enter the actual username",
        ));
    }
    if config.password.is_empty() {
        return Err(Error::protocol(
            SUBSYS,
            "password is required for RDP Network Level Authentication",
        ));
    }

    let server_addr = format!("{}:{}", host, config.port);
    let tcp = tokio::time::timeout(CONNECTION_TIMEOUT, TcpStream::connect(&server_addr))
        .await
        .map_err(|_| Error::protocol(SUBSYS, format!("connection to {server_addr} timed out")))?
        .map_err(|e| Error::protocol(SUBSYS, format!("connect {server_addr}: {e}")))?;
    let client_addr = tcp.local_addr().map_err(err)?;

    let (event_tx, event_rx) = mpsc::channel::<RdpEvent>(256);
    let (clipboard_tx, clipboard_rx) = mpsc::unbounded_channel::<ClipboardMessage>();
    let local_clipboard = Arc::new(Mutex::new(String::new()));

    let mut connector = ClientConnector::new(build_config(config), client_addr);
    if config.clipboard_enabled {
        let backend = HampyClipboardBackend {
            proxy: ChannelClipboardProxy { tx: clipboard_tx },
            local_text: Arc::clone(&local_clipboard),
            event_tx: event_tx.clone(),
            temporary_directory: std::env::temp_dir().to_string_lossy().into_owned(),
        };
        connector.attach_static_channel(CliprdrClient::new(Box::new(backend)));
    }
    let mut framed = ironrdp_tokio::TokioFramed::new(tcp);

    tracing::info!(host = %host, port = config.port, "rdp connecting");
    let should_upgrade = tokio::time::timeout(
        CONNECTION_TIMEOUT,
        ironrdp_async::connect_begin(&mut framed, &mut connector),
    )
    .await
    .map_err(|_| Error::protocol(SUBSYS, "RDP negotiation timed out"))?
    .map_err(|error| connector_error("connection negotiation failed", error))?;

    // TLS upgrade on the raw stream (accepts self-signed certs).
    let initial_stream = framed.into_inner_no_leftover();
    let (tls_stream, server_cert) = tokio::time::timeout(
        CONNECTION_TIMEOUT,
        ironrdp_tls::upgrade(initial_stream, host),
    )
    .await
    .map_err(|_| Error::protocol(SUBSYS, "TLS negotiation timed out"))?
    .map_err(|e| Error::protocol(SUBSYS, format!("tls upgrade: {e}")))?;
    let server_public_key = ironrdp_tls::extract_tls_server_public_key(&server_cert)
        .ok_or_else(|| Error::protocol(SUBSYS, "server public key missing"))?
        .to_vec();

    let upgraded = ironrdp_async::mark_as_upgraded(should_upgrade, &mut connector);
    let mut upgraded_framed = ironrdp_tokio::TokioFramed::new(tls_stream);
    let mut network_client = NoKdcNetworkClient;

    let connection_result = tokio::time::timeout(
        CONNECTION_TIMEOUT,
        ironrdp_async::connect_finalize(
            upgraded,
            connector,
            &mut upgraded_framed,
            &mut network_client,
            ServerName::new(host),
            server_public_key,
            None,
        ),
    )
    .await
    .map_err(|_| Error::protocol(SUBSYS, "RDP authentication timed out"))?
    .map_err(|error| connector_error("connection setup failed", error))?;

    tracing::info!(host = %host, "rdp connected");

    let (input_tx, input_rx) = mpsc::channel::<RdpInput>(256);
    tokio::spawn(drive_session(
        connection_result,
        upgraded_framed,
        input_rx,
        clipboard_rx,
        local_clipboard,
        event_tx,
    ));

    Ok((RdpSession { input_tx }, event_rx))
}

/// The active session loop: multiplex server PDUs (→ graphics) and UI input
/// (→ fastpath input PDUs) over the one framed transport.
async fn drive_session(
    connection_result: connector::ConnectionResult,
    framed: ironrdp_tokio::TokioFramed<ironrdp_tls::TlsStream<TcpStream>>,
    mut input_rx: mpsc::Receiver<RdpInput>,
    mut clipboard_rx: mpsc::UnboundedReceiver<ClipboardMessage>,
    local_clipboard: Arc<Mutex<String>>,
    event_tx: mpsc::Sender<RdpEvent>,
) {
    let width = connection_result.desktop_size.width;
    let height = connection_result.desktop_size.height;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, width, height);
    let mut active = ActiveStage::new(connection_result);
    let mut keyboard = Database::new();

    let _ = event_tx.send(RdpEvent::Resized { width, height }).await;

    let (mut reader, mut writer) = ironrdp_tokio::split_tokio_framed(framed);
    let mut reason: Option<String> = None;
    let mut clipboard_open = true;

    'session: loop {
        tokio::select! {
            pdu = reader.read_pdu() => {
                let (action, payload) = match pdu {
                    Ok(v) => v,
                    Err(e) => { reason = Some(e.to_string()); break 'session; }
                };
                let outputs = match active.process(&mut image, action, &payload) {
                    Ok(o) => o,
                    Err(e) => { reason = Some(e.to_string()); break 'session; }
                };
                if !emit_outputs(outputs, &image, &mut writer, &event_tx).await {
                    break 'session;
                }
            }
            input = input_rx.recv() => {
                let Some(input) = input else { break 'session; }; // all senders dropped
                if let RdpInput::Clipboard { text } = input {
                    *local_clipboard.lock().unwrap_or_else(|e| e.into_inner()) = text;
                    let result = active
                        .get_svc_processor_mut::<CliprdrClient>()
                        .map(|cliprdr| cliprdr.initiate_copy(&[
                            ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
                        ]));
                    if let Some(result) = result {
                        match result
                            .map_err(err)
                            .and_then(|messages| active.process_svc_processor_messages(messages).map_err(err))
                        {
                            Ok(frame) if writer.write_all(&frame).await.is_err() => break 'session,
                            Err(error) => tracing::warn!(%error, "failed to advertise clipboard text"),
                            _ => {}
                        }
                    }
                    continue;
                }
                let events = keyboard.apply(input.to_operations());
                if events.is_empty() {
                    continue;
                }
                match active.process_fastpath_input(&mut image, &events) {
                    Ok(outputs) => {
                        if !emit_outputs(outputs, &image, &mut writer, &event_tx).await {
                            break 'session;
                        }
                    }
                    Err(e) => { reason = Some(e.to_string()); break 'session; }
                }
            }
            message = clipboard_rx.recv(), if clipboard_open => {
                let Some(message) = message else {
                    clipboard_open = false;
                    continue;
                };
                let message = match message {
                    ClipboardMessage::Error(error) => {
                        tracing::warn!(%error, "clipboard backend error");
                        continue;
                    }
                    message => message,
                };
                let result = active.get_svc_processor_mut::<CliprdrClient>().map(|cliprdr| {
                    match message {
                        ClipboardMessage::SendInitiateCopy(formats) => cliprdr.initiate_copy(&formats),
                        ClipboardMessage::SendFormatData(response) => cliprdr.submit_format_data(response),
                        ClipboardMessage::SendInitiatePaste(format) => cliprdr.initiate_paste(format),
                        ClipboardMessage::SendFileContentsRequest(request) => cliprdr.request_file_contents(request),
                        ClipboardMessage::SendFileContentsResponse(response) => cliprdr.submit_file_contents(response),
                        ClipboardMessage::Error(_) => unreachable!(),
                    }
                });
                if let Some(result) = result {
                    match result
                        .map_err(err)
                        .and_then(|messages| active.process_svc_processor_messages(messages).map_err(err))
                    {
                        Ok(frame) if writer.write_all(&frame).await.is_err() => break 'session,
                        Err(error) => tracing::warn!(%error, "failed to process clipboard message"),
                        _ => {}
                    }
                }
            }
        }
    }

    let _ = event_tx.send(RdpEvent::Disconnected { reason }).await;
    tracing::debug!("rdp session driver exited");
}

/// Apply a batch of active-stage outputs: write response frames back to the
/// server and push graphics updates to the UI. Returns `false` if the transport
/// or UI channel died (caller should stop).
async fn emit_outputs(
    outputs: Vec<ActiveStageOutput>,
    image: &DecodedImage,
    writer: &mut ironrdp_tokio::TokioFramed<
        tokio::io::WriteHalf<ironrdp_tls::TlsStream<TcpStream>>,
    >,
    event_tx: &mpsc::Sender<RdpEvent>,
) -> bool {
    use ironrdp_async::FramedWrite as _;

    for out in outputs {
        match out {
            ActiveStageOutput::ResponseFrame(frame) => {
                if writer.write_all(&frame).await.is_err() {
                    return false;
                }
            }
            ActiveStageOutput::GraphicsUpdate(region) => {
                let frame = extract_region(image, &region);
                if event_tx.send(frame).await.is_err() {
                    return false;
                }
            }
            ActiveStageOutput::Terminate(_) => return false,
            _ => {}
        }
    }
    true
}

/// Copy a dirty rectangle out of the framebuffer as tightly-packed RGBA.
fn extract_region(image: &DecodedImage, region: &InclusiveRectangle) -> RdpEvent {
    const BPP: usize = 4;
    let fb_width = image.width() as usize;
    let stride = fb_width * BPP;
    let data = image.data();

    let left = region.left as usize;
    let top = region.top as usize;
    let rw = (region.right - region.left + 1) as usize;
    let rh = (region.bottom - region.top + 1) as usize;

    let mut rgba = Vec::with_capacity(rw * rh * BPP);
    for row in 0..rh {
        let y = top + row;
        let start = y * stride + left * BPP;
        let end = start + rw * BPP;
        if end <= data.len() {
            rgba.extend_from_slice(&data[start..end]);
        }
    }

    RdpEvent::Frame {
        x: region.left,
        y: region.top,
        width: rw as u16,
        height: rh as u16,
        rgba,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults() {
        let json = r#"{"host":"h","username":"u","password":"p"}"#;
        let c: RdpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.port, 3389);
        assert_eq!(c.width, 1280);
        assert_eq!(c.height, 800);
        assert!(!c.clipboard_enabled);
    }

    #[test]
    fn input_maps_to_operations() {
        let down = RdpInput::Key {
            scancode: 0x1C,
            pressed: true,
        };
        assert_eq!(down.to_operations().len(), 1);
        let mv = RdpInput::MouseMove { x: 10, y: 20 };
        assert_eq!(mv.to_operations().len(), 1);
    }

    #[test]
    fn normalizes_qualified_usernames() {
        let mut config: RdpConfig =
            serde_json::from_str(r#"{"host":"h","username":"ACME\\alice","password":"secret"}"#)
                .unwrap();

        assert_eq!(
            normalized_identity(&config),
            ("alice".to_owned(), Some("ACME".to_owned()))
        );

        config.username = "alice@example.com".to_owned();
        config.domain = Some("IGNORED".to_owned());
        assert_eq!(
            normalized_identity(&config),
            ("alice@example.com".to_owned(), None)
        );
    }
}
