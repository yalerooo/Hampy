//! # hampy-serial
//!
//! Serial console: COM/USB serial ports streamed to the terminal UI.
//!
//! A [`SerialSession`] owns an open serial port and exposes a writer for input
//! plus a clonable reader that callers drain on a dedicated thread, forwarding
//! bytes onto the same terminal-output channel used by local PTYs and SSH
//! shells. Serial reads/writes are blocking, so draining happens off the async
//! runtime exactly like [`hampy_terminal`].
//!
//! **Backend:** [`serialport`].

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hampy_core::{Error, Result};
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};

const SUBSYS: &str = "serial";

/// Parity bit mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SerialParity {
    #[default]
    None,
    Odd,
    Even,
}

impl From<SerialParity> for Parity {
    fn from(p: SerialParity) -> Self {
        match p {
            SerialParity::None => Parity::None,
            SerialParity::Odd => Parity::Odd,
            SerialParity::Even => Parity::Even,
        }
    }
}

/// Hardware/software flow control.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SerialFlowControl {
    #[default]
    None,
    Software,
    Hardware,
}

impl From<SerialFlowControl> for FlowControl {
    fn from(f: SerialFlowControl) -> Self {
        match f {
            SerialFlowControl::None => FlowControl::None,
            SerialFlowControl::Software => FlowControl::Software,
            SerialFlowControl::Hardware => FlowControl::Hardware,
        }
    }
}

/// Connection parameters for a serial port. Mirrors the TypeScript `SerialConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialConfig {
    /// Platform port path, e.g. `COM3` (Windows) or `/dev/ttyUSB0` (Unix).
    pub port: String,
    /// Symbol rate. Common values: 9600, 19200, 38400, 57600, 115200.
    #[serde(default = "default_baud")]
    pub baud_rate: u32,
    /// Data bits per frame (5–8).
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default)]
    pub parity: SerialParity,
    /// Stop bits (1 or 2).
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    #[serde(default)]
    pub flow_control: SerialFlowControl,
}

fn default_baud() -> u32 {
    115_200
}
fn default_data_bits() -> u8 {
    8
}
fn default_stop_bits() -> u8 {
    1
}

impl Default for SerialConfig {
    fn default() -> Self {
        SerialConfig {
            port: String::new(),
            baud_rate: default_baud(),
            data_bits: default_data_bits(),
            parity: SerialParity::default(),
            stop_bits: default_stop_bits(),
            flow_control: SerialFlowControl::default(),
        }
    }
}

/// An enumerated serial port, surfaced to the UI port picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialPortInfo {
    /// Port path used to open the port.
    pub name: String,
    /// Human-readable kind, e.g. "USB" / "Bluetooth" / "PCI" / "Unknown".
    pub kind: String,
    /// USB product string when available.
    pub product: Option<String>,
}

/// List the serial ports visible to the OS right now.
pub fn list_ports() -> Result<Vec<SerialPortInfo>> {
    let ports = serialport::available_ports()
        .map_err(|e| Error::protocol(SUBSYS, format!("enumerate ports: {e}")))?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let (kind, product) = match p.port_type {
                serialport::SerialPortType::UsbPort(info) => ("USB".to_string(), info.product),
                serialport::SerialPortType::PciPort => ("PCI".to_string(), None),
                serialport::SerialPortType::BluetoothPort => ("Bluetooth".to_string(), None),
                serialport::SerialPortType::Unknown => ("Unknown".to_string(), None),
            };
            SerialPortInfo {
                name: p.port_name,
                kind,
                product,
            }
        })
        .collect())
}

/// A live serial console session: an open port with a background reader.
pub struct SerialSession {
    port: Arc<Mutex<Box<dyn SerialPort>>>,
    running: Arc<AtomicBool>,
}

impl std::fmt::Debug for SerialSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SerialSession").finish_non_exhaustive()
    }
}

impl SerialSession {
    /// Open the port described by `config`. The port is configured but no data
    /// is read until [`Self::reader`] is drained.
    pub fn open(config: &SerialConfig) -> Result<Self> {
        let data_bits = match config.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        };
        let stop_bits = if config.stop_bits == 2 {
            StopBits::Two
        } else {
            StopBits::One
        };

        let port = serialport::new(&config.port, config.baud_rate)
            .data_bits(data_bits)
            .parity(config.parity.into())
            .stop_bits(stop_bits)
            .flow_control(config.flow_control.into())
            // Short timeout keeps the reader loop responsive to shutdown.
            .timeout(Duration::from_millis(50))
            .open()
            .map_err(|e| Error::protocol(SUBSYS, format!("open {}: {e}", config.port)))?;

        tracing::info!(port = %config.port, baud = config.baud_rate, "opened serial port");
        Ok(SerialSession {
            port: Arc::new(Mutex::new(port)),
            running: Arc::new(AtomicBool::new(true)),
        })
    }

    /// Obtain a blocking reader over the port. Callers drain this on a dedicated
    /// thread and forward bytes onto the terminal-output channel. The reader
    /// stops yielding once [`Self::close`] is called.
    pub fn reader(&self) -> Result<SerialReader> {
        let clone = self
            .port
            .lock()
            .map_err(|_| Error::protocol(SUBSYS, "port lock poisoned"))?
            .try_clone()
            .map_err(|e| Error::protocol(SUBSYS, format!("clone port: {e}")))?;
        Ok(SerialReader {
            port: clone,
            running: self.running.clone(),
        })
    }

    /// Write raw input bytes (keystrokes, pasted text) to the port.
    pub fn write_input(&self, data: &[u8]) -> Result<()> {
        let mut port = self
            .port
            .lock()
            .map_err(|_| Error::protocol(SUBSYS, "port lock poisoned"))?;
        port.write_all(data)?;
        port.flush()?;
        Ok(())
    }

    /// Signal the reader thread to stop and release the port.
    pub fn close(&self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

impl Drop for SerialSession {
    fn drop(&mut self) {
        self.close();
    }
}

/// A clonable, blocking reader handle over an open serial port. Reads return
/// `Ok(0)` once the owning session is closed, signalling EOF to the drain loop.
#[derive(Debug)]
pub struct SerialReader {
    port: Box<dyn SerialPort>,
    running: Arc<AtomicBool>,
}

impl Read for SerialReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if !self.running.load(Ordering::Relaxed) {
                return Ok(0); // session closed → EOF
            }
            match self.port.read(buf) {
                Ok(n) => return Ok(n),
                // Read timeout: no data this window — keep waiting unless closed.
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(e) => return Err(e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_are_sane() {
        let cfg = SerialConfig::default();
        assert_eq!(cfg.baud_rate, 115_200);
        assert_eq!(cfg.data_bits, 8);
        assert_eq!(cfg.stop_bits, 1);
        assert_eq!(cfg.parity, SerialParity::None);
        assert_eq!(cfg.flow_control, SerialFlowControl::None);
    }

    #[test]
    fn config_roundtrips_through_json() {
        let json = r#"{"port":"COM3","baud_rate":9600,"parity":"even"}"#;
        let cfg: SerialConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.port, "COM3");
        assert_eq!(cfg.baud_rate, 9600);
        assert_eq!(cfg.parity, SerialParity::Even);
        // Omitted fields fall back to defaults.
        assert_eq!(cfg.data_bits, 8);
    }
}
