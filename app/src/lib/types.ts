// TypeScript mirrors of the serde types exposed by hampy-core / hampy-settings.
// Keep these in lockstep with the Rust definitions — they are the IPC contract.

/** A folder with optional display color. Mirrors `hampy_settings::FolderRecord`. */
export interface FolderRecord {
  name: string;
  color: string | null;
  /** Name of the parent folder, or null for a root-level folder. */
  parent_id: string | null;
}

export type Protocol =
  | "local_shell"
  | "ssh"
  | "sftp"
  | "ftp"
  | "rdp"
  | "vnc"
  | "serial"
  | "mosh"
  | "docker"
  | "kubernetes";

export type SessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed";

export interface Tag {
  name: string;
  color?: string | null;
}

export interface Session {
  id: string;
  name: string;
  protocol: Protocol;
  host?: unknown | null;
  folder_id?: string | null;
  tags: Tag[];
  favorite: boolean;
  options: Record<string, unknown>;
  created_at: string;
  last_used_at?: string | null;
}

export interface Appearance {
  theme: "dark" | "light" | "system";
  accent: string;
  window_opacity: number;
  blur_effects: boolean;
  animations: boolean;
  ui_font: string;
  language: "en" | "es";
}

export interface TerminalConfig {
  font_family: string;
  font_size: number;
  default_shell: string;
  scrollback: number;
}

export interface SecurityConfig {
  use_os_keychain: boolean;
  auto_lock_minutes: number;
}

export interface UpdateConfig {
  auto_check: boolean;
  channel: "stable" | "beta";
}

export interface Config {
  appearance: Appearance;
  terminal: TerminalConfig;
  security: SecurityConfig;
  updates: UpdateConfig;
}

/** Output chunk streamed from a live PTY. */
export interface TerminalOutput {
  id: string;
  bytes: number[];
}

// ---- SSH / SFTP (mirror hampy-ssh / hampy-sftp) ----

export type SshAuth =
  | { method: "password"; username: string; password: string }
  | {
      method: "key";
      username: string;
      private_key: string;
      passphrase?: string | null;
    }
  | { method: "agent"; username: string };

export type HostKeyPolicy = "accept_new" | "strict";

export interface SshConfig {
  host: string;
  port: number;
  auth: SshAuth;
  host_key_policy?: HostKeyPolicy;
  jump_hosts?: unknown[];
  keepalive_secs?: number | null;
}

// ---- Serial (mirror hampy-serial) ----

export type SerialParity = "none" | "odd" | "even";
export type SerialFlowControl = "none" | "software" | "hardware";

export interface SerialConfig {
  port: string;
  baud_rate: number;
  data_bits: number;
  parity: SerialParity;
  stop_bits: number;
  flow_control: SerialFlowControl;
}

export interface SerialPortInfo {
  name: string;
  kind: string;
  product: string | null;
}

export type EntryKind = "dir" | "file" | "symlink" | "other";

export interface SftpEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  modified: number | null;
  permissions: string | null;
  owner: string | null;
  group: string | null;
}

export interface SftpConnection {
  id: string;
  home: string;
}

/** Progress update for an in-flight upload/download (`hampy://transfer-progress`). */
export interface TransferProgress {
  id: string;
  path: string;
  bytes_done: number;
  bytes_total: number;
}

// ---- RDP (mirror hampy-rdp) ----

export interface RdpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  domain?: string | null;
  width: number;
  height: number;
}

/** Event pushed on the RDP channel; `kind` discriminates the shape. */
export interface RdpEventPayload {
  id: string;
  kind: "resized" | "frame" | "disconnected";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Base64 RGBA for `frame` events. */
  data: string | null;
  reason: string | null;
}

export type RdpInput =
  | { kind: "mouse_move"; x: number; y: number }
  | { kind: "mouse_button"; button: number; pressed: boolean }
  | { kind: "wheel"; delta: number; horizontal: boolean }
  | { kind: "key"; scancode: number; pressed: boolean }
  | { kind: "unicode"; ch: string; pressed: boolean };

// ---- VNC (mirror hampy-vnc) ----

export interface VncConfig {
  host: string;
  port: number;
  password: string;
}

export interface VncEventPayload {
  id: string;
  kind: "resized" | "frame" | "copy" | "disconnected";
  x: number;
  y: number;
  width: number;
  height: number;
  src_x: number;
  src_y: number;
  data: string | null;
  reason: string | null;
}

export type VncInput =
  | { kind: "pointer"; x: number; y: number; buttons: number }
  | { kind: "key"; keysym: number; down: boolean };

// ---- FTP (mirror hampy-ftp) ----

export interface FtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

// ---- Docker / Kubernetes (shell into a container/pod via the local CLI) ----

export interface DockerConfig {
  container: string;
  shell?: string;
  host?: string | null;
}

export interface KubernetesConfig {
  pod: string;
  namespace?: string | null;
  container?: string | null;
  context?: string | null;
  shell?: string;
}

export interface ContainerInfo {
  name: string;
  image: string;
  status: string;
}

export interface PodInfo {
  name: string;
  status: string;
}

export interface FtpConnection {
  id: string;
  home: string;
}

export interface FtpEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
}

export interface MachineTelemetry {
  os_name: string | null;
  mem_total: number;
  mem_used: number;
  mem_percent: number;
  cpu_percent: number;
  disk_total: number;
  disk_avail: number;
  disk_percent: number;
}
