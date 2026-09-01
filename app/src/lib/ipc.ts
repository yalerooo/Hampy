// Typed wrappers over the Tauri IPC boundary. Every backend command in
// `app/src-tauri/src/commands.rs` has exactly one binding here so the rest of
// the UI never touches `invoke` string names directly.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Config,
  ContainerInfo,
  DockerConfig,
  FolderRecord,
  FtpConfig,
  FtpConnection,
  FtpEntry,
  KubernetesConfig,
  PodInfo,
  MachineTelemetry,
  RdpConfig,
  RdpEventPayload,
  RdpInput,
  SerialConfig,
  SerialPortInfo,
  Session,
  SftpConnection,
  SftpEntry,
  SshConfig,
  TerminalOutput,
  TransferProgress,
  VncConfig,
  VncEventPayload,
  VncInput,
} from "./types";

const TERMINAL_OUTPUT_EVENT = "hampy://terminal-output";
const RDP_EVENT = "hampy://rdp-event";
const VNC_EVENT = "hampy://vnc-event";
const TRANSFER_PROGRESS_EVENT = "hampy://transfer-progress";

export const ipc = {
  // -- Configuration --
  getConfig: () => invoke<Config>("get_config"),
  saveConfig: (config: Config) => invoke<void>("save_config", { config }),

  // -- Folders --
  listFolders: () => invoke<FolderRecord[]>("list_folders"),
  saveFolder: (folder: FolderRecord) => invoke<void>("save_folder", { folder }),
  deleteFolder: (name: string) => invoke<void>("delete_folder", { name }),
  renameFolder: (oldName: string, newName: string) =>
    invoke<void>("rename_folder", { oldName, newName }),

  // -- Sessions --
  listSessions: () => invoke<Session[]>("list_sessions"),
  saveSession: (session: Session) => invoke<void>("save_session", { session }),
  deleteSession: (id: string) => invoke<void>("delete_session", { id }),

  // -- Secrets (OS keychain) --
  setSecret: (id: string, field: string, value: string) =>
    invoke<void>("set_secret", { id, field, value }),
  getSecret: (id: string, field: string) =>
    invoke<string | null>("get_secret", { id, field }),
  deleteSecret: (id: string, field: string) =>
    invoke<void>("delete_secret", { id, field }),

  // -- Plain text files (session import/export) --
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),

  // -- Local terminal --
  openTerminal: (shell: string, rows: number, cols: number) =>
    invoke<string>("open_terminal", { shell, rows, cols }),
  terminalInput: (id: string, data: string) =>
    invoke<void>("terminal_input", { id, data }),
  terminalResize: (id: string, rows: number, cols: number) =>
    invoke<void>("terminal_resize", { id, rows, cols }),
  closeTerminal: (id: string) => invoke<void>("close_terminal", { id }),

  // -- SSH (shares the terminal-output event channel + input/resize commands) --
  openSsh: (config: SshConfig, rows: number, cols: number) =>
    invoke<string>("open_ssh", { config, rows, cols }),

  // -- Serial (shares the terminal-output event channel + input/close) --
  listSerialPorts: () => invoke<SerialPortInfo[]>("list_serial_ports"),
  openSerial: (config: SerialConfig) =>
    invoke<string>("open_serial", { config }),

  // -- SFTP --
  sftpConnect: (config: SshConfig) =>
    invoke<SftpConnection>("sftp_connect", { config }),
  sftpList: (id: string, path: string) =>
    invoke<SftpEntry[]>("sftp_list", { id, path }),
  sftpMkdir: (id: string, path: string) =>
    invoke<void>("sftp_mkdir", { id, path }),
  sftpRemove: (id: string, path: string, isDir: boolean) =>
    invoke<void>("sftp_remove", { id, path, isDir }),
  sftpRename: (id: string, from: string, to: string) =>
    invoke<void>("sftp_rename", { id, from, to }),
  sftpCopy: (id: string, from: string, to: string) =>
    invoke<number>("sftp_copy", { id, from, to }),
  sftpDownload: (id: string, remote: string, local: string) =>
    invoke<number>("sftp_download", { id, remote, local }),
  sftpDownloadDir: (id: string, remote: string, local: string) =>
    invoke<number>("sftp_download_dir", { id, remote, local }),
  sftpUpload: (id: string, local: string, remote: string) =>
    invoke<number>("sftp_upload", { id, local, remote }),
  sftpDisconnect: (id: string) => invoke<void>("sftp_disconnect", { id }),

  // -- Remote machine telemetry (over the SFTP session's SSH connection) --
  machineTelemetry: (id: string) =>
    invoke<MachineTelemetry>("machine_telemetry", { id }),

  // -- RDP (graphical; frames stream over the rdp-event channel) --
  openRdp: (config: RdpConfig) => invoke<string>("open_rdp", { config }),
  rdpInput: (id: string, input: RdpInput) =>
    invoke<void>("rdp_input", { id, input }),
  closeRdp: (id: string) => invoke<void>("close_rdp", { id }),

  // -- VNC (graphical; frames stream over the vnc-event channel) --
  openVnc: (config: VncConfig) => invoke<string>("open_vnc", { config }),
  vncInput: (id: string, input: VncInput) =>
    invoke<void>("vnc_input", { id, input }),
  closeVnc: (id: string) => invoke<void>("close_vnc", { id }),

  // -- FTP (classic file transfer) --
  ftpConnect: (config: FtpConfig) =>
    invoke<FtpConnection>("ftp_connect", { config }),
  ftpList: (id: string, path: string) =>
    invoke<FtpEntry[]>("ftp_list", { id, path }),
  ftpMkdir: (id: string, path: string) =>
    invoke<void>("ftp_mkdir", { id, path }),
  ftpRemove: (id: string, path: string, isDir: boolean) =>
    invoke<void>("ftp_remove", { id, path, isDir }),
  ftpRename: (id: string, from: string, to: string) =>
    invoke<void>("ftp_rename", { id, from, to }),
  ftpDownload: (id: string, remote: string, local: string) =>
    invoke<number>("ftp_download", { id, remote, local }),
  ftpUpload: (id: string, local: string, remote: string) =>
    invoke<number>("ftp_upload", { id, local, remote }),
  ftpDisconnect: (id: string) => invoke<void>("ftp_disconnect", { id }),

  // -- Docker / Kubernetes (exec shell; reuses the terminal I/O channel) --
  openDocker: (config: DockerConfig, rows: number, cols: number) =>
    invoke<string>("open_docker", { config, rows, cols }),
  openKubernetes: (config: KubernetesConfig, rows: number, cols: number) =>
    invoke<string>("open_kubernetes", { config, rows, cols }),
  listDockerContainers: (host?: string | null) =>
    invoke<ContainerInfo[]>("list_docker_containers", { host: host ?? null }),
  listKubernetesPods: (context?: string | null, namespace?: string | null) =>
    invoke<PodInfo[]>("list_kubernetes_pods", {
      context: context ?? null,
      namespace: namespace ?? null,
    }),
};

/**
 * Subscribe to raw terminal output for a specific session id. Returns an
 * unlisten function the caller must invoke on teardown.
 */
export function onTerminalOutput(
  id: string,
  handler: (bytes: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutput>(TERMINAL_OUTPUT_EVENT, (event) => {
    if (event.payload.id === id) {
      handler(new Uint8Array(event.payload.bytes));
    }
  });
}

/**
 * Subscribe to RDP graphics/lifecycle events for a specific session id. Returns
 * an unlisten function the caller must invoke on teardown.
 */
export function onRdpEvent(
  id: string,
  handler: (event: RdpEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<RdpEventPayload>(RDP_EVENT, (event) => {
    if (event.payload.id === id) handler(event.payload);
  });
}

/** Subscribe to VNC graphics/lifecycle events for a specific session id. */
export function onVncEvent(
  id: string,
  handler: (event: VncEventPayload) => void,
): Promise<UnlistenFn> {
  return listen<VncEventPayload>(VNC_EVENT, (event) => {
    if (event.payload.id === id) handler(event.payload);
  });
}

/** Subscribe to upload/download progress for a specific session id. */
export function onTransferProgress(
  id: string,
  handler: (progress: TransferProgress) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgress>(TRANSFER_PROGRESS_EVENT, (event) => {
    if (event.payload.id === id) handler(event.payload);
  });
}

/** True when running inside the Tauri shell (vs. a plain browser dev preview). */
export const isTauri = "__TAURI_INTERNALS__" in window;
