# ⚡ Hampy

A modern, modular **MobaXterm-class connection manager**, built in Rust.
Terminals, SSH, SFTP, RDP, VNC, Serial, Mosh, Docker and Kubernetes in one
fast, low-memory desktop app — native on **Windows, macOS and Linux**.

> Visual language follows [`DESIGN.md`](./DESIGN.md): a near-pure-black canvas
> with a single electric-yellow voltage (`#faff69`), Inter + JetBrains Mono.

## Stack

| Layer     | Choice                                             |
| --------- | -------------------------------------------------- |
| Shell     | [Tauri 2](https://tauri.app) (Rust + system WebView)|
| Frontend  | React 18 + TypeScript + Vite + [xterm.js](https://xtermjs.org) |
| Backend   | Rust (stable) + Tokio                              |
| State     | Zustand (UI) · SQLite (data) · TOML (config)       |
| Logging   | `tracing` (console + rolling JSON file)            |

**Why Tauri + React over an Electron/native approach?** Tauri ships the OS
WebView instead of bundling Chromium, so binaries are ~10× smaller and idle RAM
is a fraction of Electron's — directly serving the "bajo consumo de RAM" goal.
React (over Svelte) wins here for one decisive reason: the terminal core,
`xterm.js`, is a first-class React-ecosystem citizen, and the broader component
ecosystem (panels, virtualization) shortens the path to a MobaXterm-class UI.

## Workspace layout

```
ProjectClaudio/
├─ Cargo.toml              # Rust workspace (centralized dependency versions)
├─ DESIGN.md               # Design system — the visual contract
├─ crates/                 # Independent capability crates (depend only on core)
│  ├─ core/                # Domain model, event bus, plugin SDK, errors
│  ├─ settings/            # TOML config, SQLite store, logging bootstrap
│  ├─ terminal/            # Local PTY sessions (PowerShell/CMD/WSL/bash/zsh/fish)
│  ├─ ssh/  sftp/          # Phase 2
│  ├─ rdp/  vnc/  serial/  # Phase 3
│  ├─ docker/ kubernetes/  # Phase 4
│  ├─ ai/                  # Phase 5 — provider-agnostic assistant
│  ├─ workspace/           # Server/tab grouping, layout save/restore
│  └─ updater/             # Auto-update
└─ app/
   ├─ src/                 # React + TS frontend (design tokens, app shell)
   └─ src-tauri/           # Tauri shell: state, IPC commands, window
```

Every capability crate is independent and depends **only** on `hampy-core`,
keeping the module graph a star and making each unit testable in isolation.

## Architecture

- **Event-driven core.** `hampy-core::EventBus` is a cloneable broadcast
  channel. Capability crates publish state changes; the Tauri layer forwards
  them to the frontend over a typed event channel.
- **Typed IPC boundary.** Every backend command in
  [`app/src-tauri/src/commands.rs`](./app/src-tauri/src/commands.rs) has exactly
  one binding in [`app/src/lib/ipc.ts`](./app/src/lib/ipc.ts). The frontend never
  references raw command strings.
- **Plugin SDK from day one.** `hampy-core::Plugin` + `PluginRegistry` define
  a stable, ABI-checked contract that both first-party crates and future
  third-party plugins implement. Dynamic loading is Phase 5.
- **Security.** Secrets are referenced by handle (`secret_ref`/`key_ref`) and
  stored in the OS keychain (Windows Credential Manager / macOS Keychain),
  never inline in config or DB.

## Development

```bash
# Prerequisites: Rust (stable), Node 20+, pnpm. On Windows: WebView2 (preinstalled
# on Win11) + the MSVC build tools.
cd app
pnpm install
pnpm tauri:dev      # runs Vite + the Tauri shell with hot reload
```

```bash
# Rust-only checks (no system WebView deps needed):
cargo test -p hampy-core -p hampy-settings -p hampy-terminal
cargo clippy --workspace --all-targets
```

> First `tauri build` needs window icons: `cd app && pnpm tauri icon path/to/logo.png`.

## Roadmap

| Phase | Scope                                                            | Status |
| ----- | --------------------------------------------------------------- | ------ |
| **1** | Architecture, workspace, window/tab/nav shell, command palette  | ✅ Done |
| **2** | Terminal (local PTY), SSH, SFTP                                 | ✅ Done |
| **3** | Serial ✅ · RDP ✅ · VNC ✅ · FTP ✅                            | ✅ Done |
| **4** | Docker, Kubernetes                                              | ✅ Done |
| **5** | AI assistant, automations, plugin marketplace                   | ⏳ |

### Phase 2 detail

- **Terminal** — local PTYs via `portable-pty` (PowerShell/CMD/WSL/bash/zsh/fish),
  streamed to xterm.js with live resize.
- **SSH** (`hampy-ssh`, on `russh` with the `ring` crypto backend) — password,
  public-key and **SSH-agent** auth (`$SSH_AUTH_SOCK` on Unix, the OpenSSH named
  pipe on Windows); a persistent **`known_hosts`** trust store (real TOFU: a
  first-seen key is recorded, a changed key is rejected as a possible MITM,
  strict mode trusts only recorded hosts); an interactive PTY shell that reuses
  the terminal UI; and local (`-L`) port forwarding. *Follow-ups within the
  phase: jump-host traversal, remote/SOCKS forwarding.*
- **SFTP** (`hampy-sftp`, on `russh-sftp`) — transport-agnostic over the SSH
  `sftp` subsystem: a visual browser with navigation, upload/download via native
  dialogs, mkdir, delete and rename. *Follow-ups: parallel transfer queue,
  drag-and-drop, folder sync/compare.*

### Phase 3 detail

- **Serial** (`hampy-serial`, on `serialport`) — COM/USB serial consoles with a
  live port picker (rescan), configurable baud rate, data bits, parity, stop bits
  and flow control. Bytes stream to the same xterm.js surface as PTYs and SSH.
- **RDP / VNC** — graphical framebuffer sessions rendered to a `<canvas>` with
  pointer/keyboard event encoding — a separate rendering subsystem from the terminal.
- **FTP** — classic file transfer over the same browser/upload/download UI as SFTP
  (mkdir, delete, rename), with port 21 by default and anonymous login support.

### Phase 4 detail

- **Docker** — shell into a running container via the local `docker` CLI. Includes a
  **live container picker** (`docker ps` output) so you can browse running containers
  and click to connect, or type the container name directly. Supports `docker -H` for
  remote daemons (SSH or TCP). Shell reuses the terminal I/O path (same as SSH).
- **Kubernetes** — shell into a pod via `kubectl exec -it`. Includes a **live pod
  browser** that respects your current kubeconfig context and namespace selection,
  with pod status displayed. Container choice within a pod is optional. Supports
  context override via CLI args.

## Sidebar & session management

- **Session organization** — save/load sessions grouped into folders (named or user-created).
  Drag sessions into folders or out to root; **custom folder colors** (8 pastel presets)
  for visual grouping. Folders can be collapsed/expanded inline, and empty folders persist.
- **Session discovery** — inline text search (real-time filter), sort by name (A–Z),
  recent usage, or **favorites-first**. Toggle "show favorites only" or toggle an individual
  session as favorite (inline star button or right-click menu).
- **SFTP file browser** — hierarchical navigation with upload/download progress bars,
  mkdir, delete, rename, and queued parallel transfers. Shows file permissions, owner/group,
  size, and modification date. Drag folders to a destination for bulk download.
- **Credential security** — SSH passwords, passphrases, private keys, and RDP/VNC/FTP
  passwords stored in the **OS keychain** (Windows Credential Manager / macOS Keychain /
  Secret Service on Linux), **never in plaintext** SQLite or config files. Keychain toggle
  in Settings (default on).
- **Session import/export** — MobaXterm-compatible `.mxtsessions` (INI) format. Export
  all sessions to a file, import from a `.mxtsessions`, preserving protocol, host, port,
  auth method, and folder structure. Passwords excluded (keychain-backed on save).
- **Settings modal** — Appearance (theme, accent color, blur, animations), Terminal
  (font family/size, default shell, scrollback), Security (keychain toggle, auto-lock
  timeout), Updates (auto-check, stable/beta channel), and About (app version & brand).

## License

MIT OR Apache-2.0.
