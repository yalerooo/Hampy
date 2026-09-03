# ⚡ Hampy

**One connection manager for every way you reach a remote machine.** Terminal,
SSH, SFTP, RDP, VNC, Serial, FTP, Docker and Kubernetes, all in one fast,
native, low-memory desktop app — with a sidebar that actually respects how
you organize your work.

Built in Rust on Tauri 2, Hampy starts instantly, idles at a fraction of
Electron's memory footprint, and ships as a single native binary for
**Windows, macOS and Linux**.

> Visual language follows [`DESIGN.md`](./DESIGN.md): a near-pure-black canvas
> with a single electric-yellow voltage (`#faff69`), Inter + JetBrains Mono.

## 🎬 Demo

There's no official demo build yet — Hampy is under active development and
not published anywhere. Clone it and run it locally (see
[Development](#-development)) to try the current build, or watch this repo
for the first release.

## ✨ What Hampy does today

**All-in-one connectivity**
- **Terminal** — local PTY sessions (PowerShell, CMD, WSL, bash, zsh, fish) on
  a full `xterm.js` surface with live resize.
- **SSH** — password, public-key and SSH-agent authentication, a persistent
  `known_hosts` trust store with real TOFU protection (rejects a changed host
  key as a possible MITM), an interactive shell, and local port forwarding.
- **SFTP & FTP** — a visual file browser with upload/download progress,
  mkdir, delete, rename, and queued parallel transfers, including permissions,
  ownership and modification dates.
- **RDP & VNC** — graphical remote-desktop sessions rendered to canvas with
  full pointer and keyboard support.
- **Serial** — COM/USB consoles with a live, rescannable port picker and
  configurable baud rate, data bits, parity and flow control.
- **Docker** — shell into any running container via a live `docker ps`
  picker, including remote daemons over SSH or TCP.
- **Kubernetes** — shell into a pod via `kubectl exec`, with a live,
  context-aware pod/namespace browser.

**Session management that scales**
- Folders with drag-and-drop organization, custom colors, collapse/expand.
- Instant search, sort by name/recent/favorites, and one-click favoriting.
- Import/export via the `.mxtsessions` format for easy migration from other
  session managers.

**Security by default**
- Passwords, passphrases and private keys are stored in the **OS keychain**
  (Windows Credential Manager, macOS Keychain, Secret Service on Linux) —
  never in plaintext config or database files.

**Hampy, the in-app assistant**
- A friendly hamster docked in the corner of the app — click it to open a
  small popup menu with four sections:
  - **Utilities** — sticky notes, a coin flip, a countdown timer and a
    calculator, all one click away without leaving your session.
  - **Games** — Snake and Minesweeper, playable right there in the popup,
    for the moments you're waiting on a slow connection.
  - **Help** — a guided FAQ covering both technical topics (sessions,
    terminal usage) and the project itself (its open-source nature,
    architecture).
  - **Chatbot** — a placeholder today; a real conversational assistant is
    planned for a future release.

## 🧱 Tech stack

| Layer     | Choice                                                          |
| --------- | ---------------------------------------------------------------- |
| Shell     | [Tauri 2](https://tauri.app) (Rust + system WebView)              |
| Frontend  | React 18 + TypeScript + Vite + [xterm.js](https://xtermjs.org)    |
| Backend   | Rust (stable) + Tokio                                             |
| State     | Zustand (UI) · SQLite (data) · TOML (config)                      |
| Logging   | `tracing` (console + rolling JSON file)                           |

**Why Tauri + React over an Electron/native approach?** Tauri ships the OS
WebView instead of bundling Chromium, so binaries are ~10× smaller and idle
RAM is a fraction of Electron's — directly serving the low-memory goal.
React (over Svelte) wins here for one decisive reason: the terminal core,
`xterm.js`, is a first-class React-ecosystem citizen, and the broader
component ecosystem (panels, virtualization) shortens the path to a
polished, multi-protocol UI.

## 🏗️ Architecture

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
- **Independent capability crates.** Every crate under `crates/` depends
  **only** on `hampy-core`, keeping the module graph a star and making each
  unit testable in isolation.

## 🚀 Development

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

## 🗺️ Roadmap

| Phase | Scope                                                            | Status |
| ----- | --------------------------------------------------------------- | ------ |
| **1** | Architecture, workspace, window/tab/nav shell, command palette  | ✅ Done |
| **2** | Terminal (local PTY), SSH, SFTP                                 | ✅ Done |
| **3** | Serial ✅ · RDP ✅ · VNC ✅ · FTP ✅                            | ✅ Done |
| **4** | Docker, Kubernetes                                              | ✅ Done |
| **5** | AI assistant, automations, plugin marketplace                   | ⏳ |

## 🤝 Contributors

Hampy is built by a small team with a big itch to scratch: real multi-protocol
power without the Electron weight.

- [**yalerooo**](https://github.com/yalerooo)
- [**AsierAlcibar**](https://github.com/AsierAlcibar)
- [**Warita**](https://github.com/warayasyp)

Found a bug or have an idea for a feature? **[Open an issue](https://github.com/yalerooo/Voltaic/issues)**
— suggestions, bug reports and pull requests are all welcome.

## 📄 License

Hampy is free and open-source software, licensed under
**[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)**.


