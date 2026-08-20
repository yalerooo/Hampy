import { useEffect } from "react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { CommandPalette } from "./components/CommandPalette";
import { NewSessionModal } from "./components/NewSessionModal";
import { SettingsModal } from "./components/SettingsModal";
import { TerminalView } from "./components/TerminalView";
import { Welcome } from "./components/Welcome";
import { ComingSoon } from "./components/ComingSoon";
import { SshSession } from "./components/SshSession";
import { SftpBrowser } from "./components/SftpBrowser";
import { SerialConsole } from "./components/SerialConsole";
import { RdpView } from "./components/RdpView";
import { VncView } from "./components/VncView";
import { FtpBrowser } from "./components/FtpBrowser";
import { ContainerSession } from "./components/ContainerSession";
import { Mascot } from "./components/Mascot";
import { useAppStore } from "./store/appStore";
import { TooltipPortal } from "./components/TooltipPortal";
import "./App.css";

export default function App() {
  const { tabs, activeTabId, togglePalette, setPaletteOpen } = useAppStore();
  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "k" || (e.shiftKey && e.key.toLowerCase() === "p"))) {
        e.preventDefault();
        togglePalette();
      }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, setPaletteOpen]);

  return (
    <div className="app">
      <TitleBar />
      <div className="app__body">
        <Sidebar />
        <main className="app__main">
          <TabBar />
          <div className="app__content">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className="app__pane"
                style={{ display: tab.id === activeTabId ? "block" : "none" }}
              >
                {tab.kind === "welcome" && <Welcome />}
                {tab.kind === "terminal" && (
                  <TerminalView shell={tab.shell ?? "default"} />
                )}
                {tab.kind === "session" && tab.protocol === "ssh" && (
                  <SshSession initialConfig={tab.sshConfig} />
                )}
                {tab.kind === "session" && tab.protocol === "sftp" && (
                  <SftpBrowser initialConfig={tab.sshConfig} />
                )}
                {tab.kind === "session" && tab.protocol === "serial" && (
                  <SerialConsole initialConfig={tab.serialConfig} />
                )}
                {tab.kind === "session" && tab.protocol === "rdp" && (
                  <RdpView initialConfig={tab.rdpConfig} />
                )}
                {tab.kind === "session" && tab.protocol === "vnc" && (
                  <VncView initialConfig={tab.vncConfig} />
                )}
                {tab.kind === "session" && tab.protocol === "ftp" && (
                  <FtpBrowser initialConfig={tab.ftpConfig} />
                )}
                {tab.kind === "session" && tab.protocol === "docker" && (
                  <ContainerSession kind="docker" dockerConfig={tab.dockerConfig} />
                )}
                {tab.kind === "session" && tab.protocol === "kubernetes" && (
                  <ContainerSession kind="kubernetes" kubernetesConfig={tab.kubernetesConfig} />
                )}
                {tab.kind === "session" &&
                  tab.protocol &&
                  tab.protocol !== "ssh" &&
                  tab.protocol !== "sftp" &&
                  tab.protocol !== "serial" &&
                  tab.protocol !== "rdp" &&
                  tab.protocol !== "vnc" &&
                  tab.protocol !== "ftp" &&
                  tab.protocol !== "docker" &&
                  tab.protocol !== "kubernetes" &&
                  tab.protocol !== "local_shell" && (
                    <ComingSoon protocol={tab.protocol} />
                  )}
              </div>
            ))}
            {!active && (
              <div className="app__empty">No tab open — press ⌘K</div>
            )}
          </div>
        </main>
      </div>
      <CommandPalette />
      <NewSessionModal />
      <SettingsModal />
      <Mascot />
      <TooltipPortal />
    </div>
  );
}
