// Compact SFTP file browser embedded in the sidebar. Mirrors the file tree of
// the active SSH/SFTP machine over the same connection, with Windows-Explorer
// parity: click / Ctrl / Shift / arrow-key selection, F2 rename, Delete, Ctrl+A,
// copy (Ctrl+C), cut & move (Ctrl+X), paste (Ctrl+V), drag-to-move onto folders,
// a clickable breadcrumb, upload (button or OS drag & drop), download, new
// folder (inline), copy path, plus a footer with live remote telemetry.
//
// Stays mounted (toggled by CSS) so the SFTP connection survives flipping
// between the "Sessions" and "Files" sidebar tabs.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ipc, onTransferProgress } from "../lib/ipc";
import { useFileDrop } from "../lib/useFileDrop";
import type { MachineTelemetry, SftpEntry, SshConfig, TransferProgress } from "../lib/types";
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

type SortField = "name" | "size" | "modified";
type SortDir = "asc" | "desc";

function sortEntries(list: SftpEntry[], field: SortField, dir: SortDir): SftpEntry[] {
  const cmp = (a: SftpEntry, b: SftpEntry) => {
    let c: number;
    if (field === "size") c = a.size - b.size;
    else if (field === "modified") c = (a.modified ?? 0) - (b.modified ?? 0);
    else c = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    return dir === "asc" ? c : -c;
  };
  const dirs = list.filter((e) => e.kind === "dir").sort(cmp);
  const files = list.filter((e) => e.kind !== "dir").sort(cmp);
  return [...dirs, ...files];
}

const joinPath = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;
const basename = (p: string) => p.split(/[/\\]/).pop() ?? p;
const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let s = n;
  let i = 0;
  while (s >= 1024 && i < u.length - 1) {
    s /= 1024;
    i++;
  }
  return `${s.toFixed(s >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// Compact, monospace-friendly timestamp: "2026-06-19 14:30".
function fmtDate(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Windows-style: select the name without its extension when focusing a rename.
function selectStem(input: HTMLInputElement) {
  const v = input.value;
  const dot = v.lastIndexOf(".");
  if (dot > 0) input.setSelectionRange(0, dot);
  else input.select();
}

type Clipboard = { items: { path: string; name: string }[]; mode: "copy" | "cut" } | null;

export function SidebarFiles({
  active,
  sshConfig,
  sessionKey,
  sessionTitle,
}: {
  active: boolean;
  sshConfig?: SshConfig;
  sessionKey: string | null;
  sessionTitle?: string;
}) {
  const { t } = useTranslation();
  const [id, setId] = useState<string | null>(null);
  const [home, setHome] = useState("/");
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clipboard, setClipboard] = useState<Clipboard>(null);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [createValue, setCreateValue] = useState("");
  const [telemetry, setTelemetry] = useState<MachineTelemetry | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null); // range base
  const [lead, setLead] = useState<string | null>(null); // focused row
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<{ kind: "upload" | "download"; progress: TransferProgress } | null>(
    null,
  );
  const [pathEditing, setPathEditing] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const idRef = useRef<string | null>(null);
  const connectedKey = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragItems = useRef<SftpEntry[]>([]);

  useEffect(() => {
    idRef.current = id;
  }, [id]);

  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.path)),
    [entries, selected],
  );

  const cutPaths = useMemo(
    () => (clipboard?.mode === "cut" ? new Set(clipboard.items.map((i) => i.path)) : new Set<string>()),
    [clipboard],
  );

  const view = useMemo(() => sortEntries(entries, sortField, sortDir), [entries, sortField, sortDir]);

  const crumbs = useMemo(() => {
    const parts = cwd.split("/").filter(Boolean);
    const acc: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let cur = "";
    for (const p of parts) {
      cur += `/${p}`;
      acc.push({ label: p, path: cur });
    }
    return acc;
  }, [cwd]);

  const refresh = async (sessionId: string, path: string) => {
    setError(null);
    try {
      const list = await ipc.sftpList(sessionId, path);
      setEntries(list);
      setCwd(path);
      setSelected(new Set());
      setAnchor(null);
      setLead(null);
    } catch (e) {
      setError(String(e));
    }
  };

  // Tear down whenever the active machine changes (or unmount).
  useEffect(() => {
    return () => {
      if (idRef.current) ipc.sftpDisconnect(idRef.current);
      idRef.current = null;
      connectedKey.current = null;
      setId(null);
      setEntries([]);
      setCwd("/");
      setError(null);
      setClipboard(null);
      setTelemetry(null);
      setEditing(null);
      setCreating(false);
      setSelected(new Set());
    };
  }, [sessionKey]);

  // Lazily connect the first time the Files tab is opened for this machine.
  useEffect(() => {
    if (!active || !sshConfig || !sessionKey) return;
    if (connectedKey.current === sessionKey) return;
    connectedKey.current = sessionKey;

    let cancelled = false;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        const conn = await ipc.sftpConnect(sshConfig);
        if (cancelled) {
          ipc.sftpDisconnect(conn.id);
          return;
        }
        setId(conn.id);
        setHome(conn.home);
        await refresh(conn.id, conn.home);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          connectedKey.current = null;
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, sshConfig, sessionKey]);

  // Poll remote telemetry while the Files tab is open and connected.
  useEffect(() => {
    if (!active || !id) return;
    let alive = true;
    const poll = async () => {
      try {
        const t = await ipc.machineTelemetry(id);
        if (alive) setTelemetry(t);
      } catch {
        /* transient; keep last reading */
      }
    };
    poll();
    const iv = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [active, id]);

  // Track upload/download progress for the active session's transfers.
  useEffect(() => {
    if (!id) return;
    let unlisten: (() => void) | undefined;
    onTransferProgress(id, (p) => {
      setTransfer((prev) => ({ kind: prev?.kind ?? "download", progress: p }));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [id]);

  // Keep the focused (lead) row in view during keyboard navigation.
  useEffect(() => {
    if (!lead) return;
    listRef.current?.querySelector(".sbf__row.is-lead")?.scrollIntoView({ block: "nearest" });
  }, [lead]);

  // ---- navigation ----

  const navigate = (entry: SftpEntry) => {
    if (id && entry.kind === "dir" && !editing) refresh(id, entry.path);
  };

  const goUp = () => {
    if (id) refresh(id, parentOf(cwd));
  };

  // Click a sort key: toggle direction if already active, else switch to it with
  // a sensible default (names ascending, size/date descending — newest/biggest first).
  const applySort = (field: SortField) => {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "name" ? "asc" : "desc");
    }
  };

  // A sortable column header: shows the active arrow and toggles order on click.
  const sortKey = (field: SortField, label: string, cls?: string) => {
    const isActive = sortField === field;
    return (
      <button
        className={`sbf__sort-key${cls ? ` ${cls}` : ""}${isActive ? " is-active" : ""}`}
        onClick={() => applySort(field)}
        data-tooltip={t("files.sort_by", { field: label.toLowerCase() })}
        data-tooltip-pos="bottom"
      >
        {label}
        <span className="sbf__sort-arrow">{isActive ? (sortDir === "asc" ? "↑" : "↓") : ""}</span>
      </button>
    );
  };

  const guard = async (fn: () => Promise<unknown>, transferKind?: "upload" | "download") => {
    setBusy(true);
    if (transferKind) {
      setTransfer({
        kind: transferKind,
        progress: { id: id ?? "", path: "", bytes_done: 0, bytes_total: 0 },
      });
    }
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      if (transferKind) setTransfer(null);
    }
  };

  // ---- selection ----

  const selectOne = (path: string) => {
    setSelected(new Set([path]));
    setAnchor(path);
    setLead(path);
  };

  const clickRow = (entry: SftpEntry, e: React.MouseEvent) => {
    if (e.shiftKey && anchor) {
      const ia = view.findIndex((x) => x.path === anchor);
      const ib = view.findIndex((x) => x.path === entry.path);
      if (ia >= 0 && ib >= 0) {
        const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
        setSelected(new Set(view.slice(lo, hi + 1).map((x) => x.path)));
        setLead(entry.path);
      }
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const n = new Set(prev);
        if (n.has(entry.path)) n.delete(entry.path);
        else n.add(entry.path);
        return n;
      });
      setAnchor(entry.path);
      setLead(entry.path);
    } else {
      selectOne(entry.path);
    }
  };

  const moveLead = (delta: number, extend: boolean, to?: number) => {
    if (view.length === 0) return;
    const li = lead ? view.findIndex((e) => e.path === lead) : -1;
    let ni = to ?? (li < 0 ? 0 : li + delta);
    ni = Math.max(0, Math.min(view.length - 1, ni));
    const np = view[ni].path;
    setLead(np);
    if (extend && anchor) {
      const ai = view.findIndex((e) => e.path === anchor);
      const [lo, hi] = ai < ni ? [ai, ni] : [ni, ai];
      setSelected(new Set(view.slice(lo, hi + 1).map((e) => e.path)));
    } else {
      setSelected(new Set([np]));
      setAnchor(np);
    }
  };

  const leadEntry = (): SftpEntry | undefined =>
    view.find((e) => e.path === lead) ??
    (selected.size === 1 ? view.find((e) => selected.has(e.path)) : undefined);

  // ---- operations ----

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
    }, "download");

  const downloadMany = (items: SftpEntry[]) =>
    guard(async () => {
      if (items.length === 0 || !id) return;
      if (items.length === 1) {
        await download(items[0]);
        return;
      }
      const dir = await openDialog({ directory: true });
      if (!dir || Array.isArray(dir)) return;
      const sep = dir.includes("\\") ? "\\" : "/";
      for (const item of items) {
        const dest = `${dir}${sep}${item.name}`;
        if (item.kind === "dir") await ipc.sftpDownloadDir(id, item.path, dest);
        else await ipc.sftpDownload(id, item.path, dest);
      }
    }, "download");

  const uploadDialog = () =>
    guard(async () => {
      const src = await openDialog({ multiple: true });
      if (!src || !id) return;
      const paths = Array.isArray(src) ? src : [src];
      for (const p of paths) await ipc.sftpUpload(id, p, joinPath(cwd, basename(p)));
      await refresh(id, cwd);
    }, "upload");

  const uploadFolderDialog = () =>
    guard(async () => {
      const src = await openDialog({ directory: true, multiple: true });
      if (!src || !id) return;
      const paths = Array.isArray(src) ? src : [src];
      for (const p of paths) await ipc.sftpUpload(id, p, joinPath(cwd, basename(p)));
      await refresh(id, cwd);
    }, "upload");

  const uploadPaths = (paths: string[]) =>
    guard(async () => {
      if (!id) return;
      for (const p of paths) await ipc.sftpUpload(id, p, joinPath(cwd, basename(p)));
      await refresh(id, cwd);
    }, "upload");

  const removeMany = (items: SftpEntry[]) =>
    guard(async () => {
      if (items.length === 0 || !id) return;
      const msg =
        items.length === 1 ? `Delete "${items[0].name}"?` : `Delete ${items.length} items?`;
      if (!window.confirm(msg)) return;
      for (const e of items) await ipc.sftpRemove(id, e.path, e.kind === "dir");
      await refresh(id, cwd);
    });

  const copyToClipboard = (items: SftpEntry[]) => {
    const files = items.filter((e) => e.kind === "file").map((e) => ({ path: e.path, name: e.name }));
    if (files.length) setClipboard({ items: files, mode: "copy" });
  };

  const cutToClipboard = (items: SftpEntry[]) => {
    // Cut can move both files and directories (move = rename).
    const all = items.map((e) => ({ path: e.path, name: e.name }));
    if (all.length) setClipboard({ items: all, mode: "cut" });
  };

  const paste = () =>
    guard(async () => {
      if (!clipboard || clipboard.items.length === 0 || !id) return;
      const existing = new Set(entries.map((e) => e.name));
      for (const item of clipboard.items) {
        if (clipboard.mode === "cut") {
          // Move into cwd; skip if it's already here.
          if (parentOf(item.path) === cwd) continue;
          await ipc.sftpRename(id, item.path, joinPath(cwd, item.name));
        } else {
          let name = item.name;
          if (existing.has(name) || joinPath(cwd, name) === item.path) {
            const dot = name.lastIndexOf(".");
            const stem = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : "";
            name = `${stem} copy${ext}`;
          }
          await ipc.sftpCopy(id, item.path, joinPath(cwd, name));
        }
      }
      if (clipboard.mode === "cut") setClipboard(null);
      await refresh(id, cwd);
    });

  const copyPaths = (items: SftpEntry[]) => {
    navigator.clipboard?.writeText(items.map((e) => e.path).join("\n")).catch(() => {});
  };

  // ---- inline rename / new folder ----

  const startRename = (entry: SftpEntry) => {
    setCreating(false);
    setEditing(entry.path);
    setEditValue(entry.name);
  };

  const commitRename = (entry: SftpEntry) => {
    const name = editValue.trim();
    setEditing(null);
    if (!name || name === entry.name || !id) return;
    guard(async () => {
      await ipc.sftpRename(id, entry.path, joinPath(cwd, name));
      await refresh(id, cwd);
    });
  };

  const startCreate = () => {
    setEditing(null);
    setCreateValue("");
    setCreating(true);
  };

  const commitCreate = () => {
    const name = createValue.trim();
    setCreating(false);
    if (!name || !id) return;
    guard(async () => {
      await ipc.sftpMkdir(id, joinPath(cwd, name));
      await refresh(id, cwd);
    });
  };

  // ---- drag-to-move (within the server) ----

  const onRowDragStart = (entry: SftpEntry, e: React.DragEvent) => {
    const items = selected.has(entry.path) ? selectedEntries : [entry];
    dragItems.current = items;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", items.map((i) => i.path).join("\n"));
  };

  const canDropInto = (folder: SftpEntry) => {
    if (folder.kind !== "dir" || dragItems.current.length === 0) return false;
    // Don't allow dropping a folder into itself or items already in it.
    return !dragItems.current.some((i) => i.path === folder.path || parentOf(i.path) === folder.path);
  };

  const onFolderDrop = (folder: SftpEntry) => {
    const items = dragItems.current;
    dragItems.current = [];
    setDropTarget(null);
    if (!id || items.length === 0 || folder.kind !== "dir") return;
    guard(async () => {
      for (const it of items) {
        if (it.path === folder.path) continue;
        await ipc.sftpRename(id, it.path, joinPath(folder.path, it.name));
      }
      await refresh(id, cwd);
    });
  };

  // ---- keyboard (Windows-like) ----

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (editing || creating) return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (k === "F2") {
      const t = leadEntry();
      if (t) {
        e.preventDefault();
        startRename(t);
      }
    } else if (k === "Delete") {
      if (selectedEntries.length) {
        e.preventDefault();
        removeMany(selectedEntries);
      }
    } else if (k === "Escape") {
      setSelected(new Set());
    } else if (mod && k.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(view.map((x) => x.path)));
    } else if (mod && k.toLowerCase() === "c") {
      copyToClipboard(selectedEntries);
    } else if (mod && k.toLowerCase() === "x") {
      cutToClipboard(selectedEntries);
    } else if (mod && k.toLowerCase() === "v") {
      if (clipboard) paste();
    } else if (k === "ArrowDown") {
      e.preventDefault();
      moveLead(1, e.shiftKey);
    } else if (k === "ArrowUp") {
      e.preventDefault();
      moveLead(-1, e.shiftKey);
    } else if (k === "Home") {
      e.preventDefault();
      moveLead(0, e.shiftKey, 0);
    } else if (k === "End") {
      e.preventDefault();
      moveLead(0, e.shiftKey, view.length - 1);
    } else if (k === "Enter") {
      const t = leadEntry();
      if (t) {
        e.preventDefault();
        if (t.kind === "dir") navigate(t);
        else download(t);
      }
    }
  };

  // ---- menus ----

  const openRowMenu = (targets: SftpEntry[], x: number, y: number) => {
    const many = targets.length > 1;
    const files = targets.filter((e) => e.kind === "file");
    const pasteLabel = clipboard
      ? clipboard.mode === "cut"
        ? t("files.move_here", { count: clipboard.items.length })
        : t("files.paste", { count: clipboard.items.length })
      : "";
    const items: CtxItem[] = many
      ? [
          {
            kind: "action" as const,
            label: t("files.download_items", { count: targets.length }),
            icon: <IconDownload />,
            onClick: () => downloadMany(targets),
          },
          ...(files.length
            ? [
                {
                  kind: "action" as const,
                  label: t("files.copy", { count: files.length }),
                  icon: <IconCopy />,
                  onClick: () => copyToClipboard(targets),
                },
              ]
            : []),
          { kind: "action", label: t("files.cut", { count: targets.length }), icon: <IconCopy />, onClick: () => cutToClipboard(targets) },
          ...(clipboard ? [{ kind: "action" as const, label: pasteLabel, icon: <IconPaste />, onClick: paste }] : []),
          { kind: "action", label: t("files.copy_paths"), icon: <IconLink />, onClick: () => copyPaths(targets) },
          { kind: "sep" },
          {
            kind: "action",
            label: t("files.delete_items", { count: targets.length }),
            danger: true,
            icon: <IconTrash />,
            onClick: () => removeMany(targets),
          },
        ]
      : [
          targets[0].kind === "dir"
            ? { kind: "action", label: t("files.open"), icon: <IconUp />, onClick: () => navigate(targets[0]) }
            : { kind: "action", label: t("common.download"), icon: <IconDownload />, onClick: () => download(targets[0]) },
          ...(targets[0].kind === "dir"
            ? [{ kind: "action" as const, label: t("files.download_folder"), icon: <IconDownload />, onClick: () => download(targets[0]) }]
            : []),
          { kind: "action", label: t("common.rename"), icon: <IconRename />, onClick: () => startRename(targets[0]) },
          ...(targets[0].kind === "file"
            ? [{ kind: "action" as const, label: t("files.copy"), icon: <IconCopy />, onClick: () => copyToClipboard(targets) }]
            : []),
          { kind: "action", label: t("files.cut"), icon: <IconCopy />, onClick: () => cutToClipboard(targets) },
          ...(clipboard ? [{ kind: "action" as const, label: pasteLabel, icon: <IconPaste />, onClick: paste }] : []),
          { kind: "action", label: t("files.copy_path"), icon: <IconLink />, onClick: () => copyPaths(targets) },
          { kind: "sep" },
          { kind: "action", label: t("common.delete"), danger: true, icon: <IconTrash />, onClick: () => removeMany(targets) },
        ];
    setCtx({ x, y, items });
  };

  const rowContext = (entry: SftpEntry, e: React.MouseEvent) => {
    e.preventDefault();
    let targets: SftpEntry[];
    if (selected.has(entry.path)) {
      targets = selectedEntries;
    } else {
      selectOne(entry.path);
      targets = [entry];
    }
    openRowMenu(targets, e.clientX, e.clientY);
  };

  const openBackgroundMenu = (x: number, y: number) => {
    if (!id) return;
    const pasteLabel = clipboard
      ? clipboard.mode === "cut"
        ? t("files.move_here", { count: clipboard.items.length })
        : t("files.paste", { count: clipboard.items.length })
      : "";
    const items: CtxItem[] = [
      { kind: "action", label: t("files.new_folder"), icon: <IconNewFolder />, onClick: startCreate },
      { kind: "action", label: t("files.upload_files"), icon: <IconUpload />, onClick: uploadDialog },
      { kind: "action", label: t("files.upload_folder"), icon: <IconUpload />, onClick: uploadFolderDialog },
      ...(clipboard ? [{ kind: "action" as const, label: pasteLabel, icon: <IconPaste />, onClick: paste }] : []),
      { kind: "sep" },
      { kind: "action", label: t("files.refresh"), icon: <IconRefresh />, onClick: () => id && refresh(id, cwd) },
    ];
    setCtx({ x, y, items });
  };

  const isOver = useFileDrop(listRef, active && !!id, uploadPaths);

  // ---- render ----

  if (!sshConfig) {
    return (
      <div className="sbf__empty">
        <p>{t("files.no_machine")}</p>
        <p className="sbf__empty-hint">{t("files.no_machine_hint")}</p>
      </div>
    );
  }

  return (
    <div className="sbf">
      <div className="sbf__head">
        <span className="sbf__host" data-tooltip={sessionTitle} data-tooltip-pos="bottom">
          {sessionTitle ?? t("files.files_title")}
        </span>
        <div className="sbf__actions">
          <button className="sbf__icon-btn" onClick={() => id && refresh(id, home)} disabled={!id} data-tooltip={t("sftp.home_tooltip")} data-tooltip-pos="bottom">
            <IconHome />
          </button>
          <button className="sbf__icon-btn" onClick={goUp} disabled={!id || cwd === "/"} data-tooltip={t("sftp.up_tooltip")} data-tooltip-pos="bottom">
            <IconUp />
          </button>
          <button className="sbf__icon-btn" onClick={() => id && refresh(id, cwd)} disabled={!id} data-tooltip={t("sftp.refresh_tooltip")} data-tooltip-pos="bottom">
            <IconRefresh />
          </button>
          <button className="sbf__icon-btn" onClick={startCreate} disabled={!id || busy} data-tooltip={t("sftp.new_folder_tooltip")} data-tooltip-pos="bottom">
            <IconNewFolder />
          </button>
          <button className="sbf__icon-btn" onClick={uploadDialog} disabled={!id || busy} data-tooltip={t("sftp.upload_tooltip")} data-tooltip-pos="bottom">
            <IconUpload />
          </button>
          <button className="sbf__icon-btn" onClick={uploadFolderDialog} disabled={!id || busy} data-tooltip={t("files.upload_folder")} data-tooltip-pos="bottom">
            <IconUpload />
          </button>
        </div>
      </div>

      {/* Clickable breadcrumb, or an editable address bar when toggled */}
      <div className="sbf__crumbs">
        {pathEditing ? (
          <input
            className="sbf__path-input"
            autoFocus
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                const target = pathInput.trim();
                setPathEditing(false);
                if (id && target) refresh(id, target);
              } else if (e.key === "Escape") {
                setPathEditing(false);
              }
            }}
            onBlur={() => setPathEditing(false)}
          />
        ) : (
          <>
            {crumbs.map((c, i) => (
              <span key={c.path} className="sbf__crumb-wrap">
                {i > 0 && <span className="sbf__crumb-sep">›</span>}
                <button
                  className={`sbf__crumb${i === crumbs.length - 1 ? " is-current" : ""}`}
                  onClick={() => id && refresh(id, c.path)}
                  data-tooltip={c.path}
                  data-tooltip-pos="bottom"
                >
                  {c.label}
                </button>
              </span>
            ))}
          </>
        )}
        <button
          className="sbf__icon-btn sbf__path-btn"
          onClick={() => {
            setPathInput(cwd);
            setPathEditing(true);
          }}
          disabled={!id}
          data-tooltip={t("files.edit_path")}
          data-tooltip-pos="bottom"
        >
          <IconRename size={13} />
        </button>
        <button
          className="sbf__icon-btn sbf__path-btn"
          onClick={() => navigator.clipboard?.writeText(cwd).catch(() => {})}
          disabled={!id}
          data-tooltip={t("files.copy_current_path")}
          data-tooltip-pos="bottom"
        >
          <IconLink size={13} />
        </button>
      </div>

      {/* Column headers — Name/Size/Modified sort; Perms/Owner/Group are labels.
          Shares its grid template with each row so values sit under their header. */}
      <div className="sbf__cols">
        {sortKey("name", t("files.col_name"), "sbf__col-name")}
        <span className="sbf__col-label">{t("files.col_perms")}</span>
        <span className="sbf__col-label">{t("files.col_owner")}</span>
        <span className="sbf__col-label">{t("files.col_group")}</span>
        {sortKey("size", t("files.col_size"))}
        {sortKey("modified", t("files.col_modified"))}
      </div>

      {error && <p className="sbf__error">{error}</p>}

      {transfer && (
        <div className="sbf__transfer">
          <div className="sbf__transfer-top">
            <span className="sbf__transfer-label">
              {transfer.kind === "upload" ? t("files.uploading") : t("files.downloading")}{" "}
              {basename(transfer.progress.path) || "…"}
            </span>
            <span className="sbf__transfer-pct">
              {transfer.progress.bytes_total > 0
                ? `${Math.min(100, Math.round((transfer.progress.bytes_done / transfer.progress.bytes_total) * 100))}%`
                : fmtBytes(transfer.progress.bytes_done)}
            </span>
          </div>
          <div className="sbf__transfer-track">
            <div
              className="sbf__transfer-fill"
              style={{
                width:
                  transfer.progress.bytes_total > 0
                    ? `${Math.min(100, (transfer.progress.bytes_done / transfer.progress.bytes_total) * 100)}%`
                    : "100%",
              }}
              data-indeterminate={transfer.progress.bytes_total === 0}
            />
          </div>
        </div>
      )}

      <div
        ref={listRef}
        className={`sbf__list${isOver ? " is-drop" : ""}`}
        tabIndex={0}
        onKeyDown={onListKeyDown}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(new Set());
        }}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            openBackgroundMenu(e.clientX, e.clientY);
          }
        }}
      >
        {!id && busy && <p className="sbf__status">{t("files.connecting")}</p>}

        {creating && (
          <div className="sbf__row sbf__row--editing">
            <span className="sbf__icon">
              <FileIcon name="" kind="dir" size={16} />
            </span>
            <input
              className="sbf__edit"
              autoFocus
              value={createValue}
              placeholder={t("files.folder_name_placeholder")}
              onChange={(e) => setCreateValue(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitCreate();
                else if (e.key === "Escape") setCreating(false);
              }}
              onBlur={commitCreate}
            />
          </div>
        )}

        {id &&
          view.map((entry) =>
            editing === entry.path ? (
              <div key={entry.path} className="sbf__row sbf__row--editing">
                <span className="sbf__icon">
                  <FileIcon name={entry.name} kind={entry.kind} size={16} />
                </span>
                <input
                  className="sbf__edit"
                  autoFocus
                  value={editValue}
                  onFocus={(e) => selectStem(e.currentTarget)}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commitRename(entry);
                    else if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={() => commitRename(entry)}
                />
              </div>
            ) : (
              <div
                key={entry.path}
                className={
                  "sbf__row" +
                  (selected.has(entry.path) ? " is-selected" : "") +
                  (lead === entry.path ? " is-lead" : "") +
                  (cutPaths.has(entry.path) ? " is-cut" : "") +
                  (dropTarget === entry.path ? " is-droptarget" : "")
                }
                draggable
                onDragStart={(e) => onRowDragStart(entry, e)}
                onDragEnd={() => {
                  dragItems.current = [];
                  setDropTarget(null);
                }}
                onDragOver={(e) => {
                  if (canDropInto(entry)) {
                    e.preventDefault();
                    if (dropTarget !== entry.path) setDropTarget(entry.path);
                  }
                }}
                onDragLeave={() => {
                  if (dropTarget === entry.path) setDropTarget(null);
                }}
                onDrop={(e) => {
                  if (canDropInto(entry)) {
                    e.preventDefault();
                    onFolderDrop(entry);
                  }
                }}
                onClick={(e) => clickRow(entry, e)}
                onDoubleClick={() => navigate(entry)}
                onContextMenu={(e) => rowContext(entry, e)}
                data-tooltip={entry.kind === "dir" ? t("sftp.open_hint") : t("sftp.download_hint")}
              >
                <span className="sbf__cell sbf__cell-name">
                  <span className="sbf__icon">
                    <FileIcon name={entry.name} kind={entry.kind} size={16} />
                  </span>
                  <span className="sbf__name" data-tooltip={entry.name}>{entry.name}</span>
                </span>
                <span className="sbf__cell sbf__perm" data-tooltip={entry.permissions ?? undefined}>
                  {entry.permissions ?? "—"}
                </span>
                <span className="sbf__cell sbf__owner" data-tooltip={entry.owner ?? undefined}>
                  {entry.owner ?? "—"}
                </span>
                <span className="sbf__cell sbf__group" data-tooltip={entry.group ?? undefined}>
                  {entry.group ?? "—"}
                </span>
                <span className="sbf__cell sbf__size">
                  {entry.kind !== "dir" ? fmtBytes(entry.size) : ""}
                </span>
                <span className="sbf__cell sbf__mtime">
                  {entry.modified != null ? fmtDate(entry.modified) : "—"}
                </span>
                {entry.kind !== "dir" && (
                  <button
                    className="sbf__dl"
                    onClick={(e) => {
                      e.stopPropagation();
                      download(entry);
                    }}
                    data-tooltip={t("sftp.download_tooltip")}
                  >
                    <IconDownload size={14} />
                  </button>
                )}
              </div>
            ),
          )}
        {id && !busy && entries.length === 0 && !creating && (
          <p className="sbf__status">{t("files.empty_dir")}</p>
        )}

        {isOver && <div className="sbf__drop-hint">{t("files.drop_upload")}</div>}
      </div>

      {selected.size > 1 && <div className="sbf__selbar">{t("files.selected", { count: selected.size })}</div>}

      {telemetry && (
        <div className="sbf__telemetry">
          {telemetry.os_name && (
            <div className="sbf__tel-os" data-tooltip={telemetry.os_name}>
              {telemetry.os_name}
            </div>
          )}
          {telemetry.mem_total > 0 && (
            <Meter label={t("files.cpu")} percent={telemetry.cpu_percent} detail={`${telemetry.cpu_percent.toFixed(0)}%`} />
          )}
          {telemetry.mem_total > 0 && (
            <Meter
              label={t("files.ram")}
              percent={telemetry.mem_percent}
              detail={`${fmtBytes(telemetry.mem_used)} / ${fmtBytes(telemetry.mem_total)}`}
            />
          )}
          {telemetry.disk_total > 0 && (
            <Meter label={t("files.disk")} percent={telemetry.disk_percent} detail={`${fmtBytes(telemetry.disk_avail)} ${t("files.free")}`} />
          )}
        </div>
      )}

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
    </div>
  );
}

function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const p = Math.max(0, Math.min(100, percent));
  const level = p >= 90 ? "crit" : p >= 70 ? "warn" : "ok";
  return (
    <div className="sbf__meter">
      <div className="sbf__meter-top">
        <span className="sbf__meter-label">{label}</span>
        <span className="sbf__meter-detail">{detail}</span>
      </div>
      <div className="sbf__meter-track">
        <div className="sbf__meter-fill" data-level={level} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}
