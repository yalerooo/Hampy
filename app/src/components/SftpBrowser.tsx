// SFTP tab: connection form, then a full file manager — breadcrumb path,
// directory listing, navigation, and file operations: upload (button or OS
// drag & drop), download, rename, copy/paste, delete, new folder, copy path.
// Transfers use the dialog plugin for local path selection.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ipc } from "../lib/ipc";
import { useFileDrop } from "../lib/useFileDrop";
import type { SftpEntry, SshConfig } from "../lib/types";
import { SshConnectForm } from "./SshConnectForm";
import { FileIcon } from "./FileIcon";
import { ContextMenu, type CtxItem, type CtxState } from "./ContextMenu";
import {
  IconUp,
  IconHome,
  IconRefresh,
  IconNewFolder,
  IconUpload,
  IconDownload,
  IconRename,
  IconCopy,
  IconPaste,
  IconTrash,
  IconLink,
} from "./icons";
import "./SftpBrowser.css";

const joinPath = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const basename = (p: string) => p.split(/[/\\]/).pop() ?? p;

export function SftpBrowser({ initialConfig }: { initialConfig?: SshConfig }) {
  const { t } = useTranslation();
  const [id, setId] = useState<string | null>(null);
  const [home, setHome] = useState("/");
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{ path: string; name: string } | null>(null);
  const [ctx, setCtx] = useState<CtxState | null>(null);

  const idRef = useRef<string | null>(null);
  const didAutoConnect = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    idRef.current = id;
  }, [id]);

  useEffect(() => {
    return () => {
      if (idRef.current) ipc.sftpDisconnect(idRef.current);
    };
  }, []);

  useEffect(() => {
    if (initialConfig && !didAutoConnect.current) {
      didAutoConnect.current = true;
      setConnecting(true);
      connect(initialConfig).catch((err) => {
        setConnectError(String(err));
        setConnecting(false);
      });
    }
  }, []); // run once on mount

  const refresh = async (sessionId: string, path: string) => {
    setError(null);
    try {
      const list = await ipc.sftpList(sessionId, path);
      setEntries(list);
      setCwd(path);
    } catch (e) {
      setError(String(e));
    }
  };

  const connect = async (config: SshConfig) => {
    setConnectError(null);
    setConnecting(true);
    const conn = await ipc.sftpConnect(config);
    setId(conn.id);
    setHome(conn.home);
    setConnecting(false);
    await refresh(conn.id, conn.home);
  };

  // ---- operations ----

  const navigate = (entry: SftpEntry) => {
    if (id && entry.kind === "dir") refresh(id, entry.path);
  };

  const goUp = () => {
    if (!id) return;
    const parent = cwd.replace(/\/[^/]+\/?$/, "") || "/";
    refresh(id, parent);
  };

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const download = (entry: SftpEntry) =>
    guard(async () => {
      if (entry.kind === "dir") {
        const dir = await openDialog({ directory: true });
        if (!dir || Array.isArray(dir) || !id) return;
        const sep = dir.includes("\\") ? "\\" : "/";
        await ipc.sftpDownloadDir(id, entry.path, `${dir}${sep}${entry.name}`);
        return;
      }
      const dest = await saveDialog({ defaultPath: entry.name });
      if (dest && id) await ipc.sftpDownload(id, entry.path, dest);
    });

  const uploadDialog = () =>
    guard(async () => {
      const src = await openDialog({ multiple: true });
      if (!src || !id) return;
      const paths = Array.isArray(src) ? src : [src];
      for (const p of paths) await ipc.sftpUpload(id, p, joinPath(cwd, basename(p)));
      await refresh(id, cwd);
    });

  const uploadFolderDialog = () =>
    guard(async () => {
      const src = await openDialog({ directory: true, multiple: true });
      if (!src || !id) return;
      const paths = Array.isArray(src) ? src : [src];
      for (const p of paths) await ipc.sftpUpload(id, p, joinPath(cwd, basename(p)));
      await refresh(id, cwd);
    });

  const uploadPaths = (paths: string[]) =>
    guard(async () => {
      if (!id) return;
      for (const p of paths) await ipc.sftpUpload(id, p, joinPath(cwd, basename(p)));
      await refresh(id, cwd);
    });

  const mkdir = () =>
    guard(async () => {
      const name = window.prompt("New folder name");
      if (name?.trim() && id) {
        await ipc.sftpMkdir(id, joinPath(cwd, name.trim()));
        await refresh(id, cwd);
      }
    });

  const rename = (entry: SftpEntry) =>
    guard(async () => {
      const name = window.prompt("Rename to:", entry.name);
      if (name?.trim() && name.trim() !== entry.name && id) {
        await ipc.sftpRename(id, entry.path, joinPath(cwd, name.trim()));
        await refresh(id, cwd);
      }
    });

  const remove = (entry: SftpEntry) =>
    guard(async () => {
      if (!window.confirm(`Delete "${entry.name}"?`) || !id) return;
      await ipc.sftpRemove(id, entry.path, entry.kind === "dir");
      await refresh(id, cwd);
    });

  const paste = () =>
    guard(async () => {
      if (!clipboard || !id) return;
      let target = joinPath(cwd, clipboard.name);
      if (target === clipboard.path) {
        const dot = clipboard.name.lastIndexOf(".");
        const stem = dot > 0 ? clipboard.name.slice(0, dot) : clipboard.name;
        const ext = dot > 0 ? clipboard.name.slice(dot) : "";
        target = joinPath(cwd, `${stem} copy${ext}`);
      }
      await ipc.sftpCopy(id, clipboard.path, target);
      await refresh(id, cwd);
    });

  const copyPath = (entry: SftpEntry) => {
    navigator.clipboard?.writeText(entry.path).catch(() => {});
  };

  const openRowMenu = (entry: SftpEntry, x: number, y: number) => {
    const items: CtxItem[] = [
      entry.kind === "dir"
        ? { kind: "action", label: t("files.open"), icon: <IconUp />, onClick: () => navigate(entry) }
        : { kind: "action", label: t("common.download"), icon: <IconDownload />, onClick: () => download(entry) },
      ...(entry.kind === "dir"
        ? [{ kind: "action" as const, label: t("files.download_folder"), icon: <IconDownload />, onClick: () => download(entry) }]
        : []),
      { kind: "action", label: t("common.rename"), icon: <IconRename />, onClick: () => rename(entry) },
      ...(entry.kind === "file"
        ? [
            {
              kind: "action" as const,
              label: t("files.copy"),
              icon: <IconCopy />,
              onClick: () => setClipboard({ path: entry.path, name: entry.name }),
            },
          ]
        : []),
      ...(clipboard
        ? [{ kind: "action" as const, label: t("sftp.paste_tooltip", { name: clipboard.name }), icon: <IconPaste />, onClick: paste }]
        : []),
      { kind: "action", label: t("common.copy_path"), icon: <IconLink />, onClick: () => copyPath(entry) },
      { kind: "sep" },
      { kind: "action", label: t("common.delete"), danger: true, icon: <IconTrash />, onClick: () => remove(entry) },
    ];
    setCtx({ x, y, items });
  };

  const isOver = useFileDrop(listRef, !!id, uploadPaths);

  if (connecting) {
    return <div className="sftp__connecting">{t("form.connecting")}</div>;
  }

  if (!id) {
    return (
      <SshConnectForm
        title={initialConfig ? t("sftp.reconnect") : t("sftp.new_session")}
        cta="Connect"
        onConnect={connect}
        initialConfig={initialConfig}
        externalError={connectError}
      />
    );
  }

  return (
    <div className="sftp">
      <div className="sftp__toolbar">
        <button className="sftp__btn" onClick={() => refresh(id, home)} data-tooltip={t("sftp.home_tooltip")} data-tooltip-pos="bottom">
          <IconHome />
        </button>
        <button className="sftp__btn" onClick={goUp} disabled={cwd === "/"} data-tooltip={t("sftp.up_tooltip")} data-tooltip-pos="bottom">
          <IconUp />
        </button>
        <button className="sftp__btn" onClick={() => refresh(id, cwd)} data-tooltip={t("sftp.refresh_tooltip")} data-tooltip-pos="bottom">
          <IconRefresh />
        </button>
        <code className="sftp__path" data-tooltip={cwd} data-tooltip-pos="bottom">
          {cwd}
        </code>
        <div className="sftp__spacer" />
        {clipboard && (
          <button className="sftp__btn" onClick={paste} disabled={busy} data-tooltip={t("sftp.paste_tooltip", { name: clipboard.name })} data-tooltip-pos="bottom">
            <IconPaste />
          </button>
        )}
        <button className="sftp__btn" onClick={mkdir} disabled={busy} data-tooltip={t("sftp.new_folder_tooltip")} data-tooltip-pos="bottom">
          <IconNewFolder />
        </button>
        <button className="sftp__btn" onClick={uploadFolderDialog} disabled={busy} data-tooltip={t("files.upload_folder")} data-tooltip-pos="bottom">
          <IconUpload size={15} />
          {t("files.upload_folder")}
        </button>
        <button className="sftp__btn sftp__btn--primary" onClick={uploadDialog} disabled={busy}>
          <IconUpload size={15} />
          {t("common.upload")}
        </button>
      </div>

      {error && <p className="sftp__error">{error}</p>}

      <div
        ref={listRef}
        className={`sftp__list${isOver ? " is-drop" : ""}`}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            const items: CtxItem[] = [
              { kind: "action", label: t("sftp.new_folder_tooltip"), icon: <IconNewFolder />, onClick: mkdir },
              { kind: "action", label: t("files.upload_files"), icon: <IconUpload />, onClick: uploadDialog },
              { kind: "action", label: t("files.upload_folder"), icon: <IconUpload />, onClick: uploadFolderDialog },
              ...(clipboard
                ? [{ kind: "action" as const, label: t("sftp.paste_tooltip", { name: clipboard.name }), icon: <IconPaste />, onClick: paste }]
                : []),
              { kind: "sep" },
              { kind: "action", label: t("common.refresh"), icon: <IconRefresh />, onClick: () => refresh(id, cwd) },
            ];
            setCtx({ x: e.clientX, y: e.clientY, items });
          }
        }}
      >
        <div className="sftp__head">
          <span>{t("files.col_name")}</span>
          <span>{t("files.col_size")}</span>
          <span />
        </div>
        {entries.map((entry) => (
          <div
            key={entry.path}
            className="sftp__row"
            onDoubleClick={() => navigate(entry)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openRowMenu(entry, e.clientX, e.clientY);
            }}
          >
            <span className="sftp__name">
              <span className="sftp__icon">
                <FileIcon name={entry.name} kind={entry.kind} size={18} />
              </span>
              {entry.name}
            </span>
            <span className="sftp__size">
              {entry.kind === "dir" ? "—" : formatSize(entry.size)}
            </span>
            <span className="sftp__actions">
              <button className="sftp__link" onClick={() => download(entry)}>
                {t("common.download")}
              </button>
              <button className="sftp__link sftp__link--danger" onClick={() => remove(entry)}>
                {t("common.delete")}
              </button>
            </span>
          </div>
        ))}
        {entries.length === 0 && <p className="sftp__empty">{t("files.empty_dir")}</p>}

        {isOver && <div className="sftp__drop-hint">{t("files.drop_upload")}</div>}
      </div>

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}
