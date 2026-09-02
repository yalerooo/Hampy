import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc, isTauri } from "../lib/ipc";
import type {
  DockerConfig,
  FolderRecord,
  FtpConfig,
  KubernetesConfig,
  Protocol,
  RdpConfig,
  SerialConfig,
  Session,
  SshConfig,
  VncConfig,
} from "../lib/types";
import { clearSecrets, injectSecrets } from "../lib/secrets";
import { exportSessions, importSessions } from "../lib/sessionTransfer";
import { useAppStore } from "../store/appStore";
import { SidebarFiles } from "./SidebarFiles";
import {
  IconCollapse,
  IconDownload,
  IconExpand,
  IconFolder,
  IconNewFolder,
  IconRefresh,
  IconSearch,
  IconSort,
  IconStar,
  IconUpload,
} from "./icons";
import { ContextMenu, type CtxItem, type CtxState } from "./ContextMenu";
import { MoveToFolderDialog } from "./MoveToFolderDialog";
import "./Sidebar.css";

// ---- Protocol dot color ----

const PROTO_COLOR: Partial<Record<Protocol, string>> = {
  local_shell: "var(--color-primary)",
  ssh: "var(--color-success)",
  sftp: "var(--color-info)",
  ftp: "hsl(199 70% 55%)",
  rdp: "hsl(280 65% 60%)",
  vnc: "hsl(30 90% 55%)",
  serial: "hsl(180 60% 48%)",
  mosh: "hsl(160 60% 48%)",
  docker: "hsl(199 85% 55%)",
  kubernetes: "hsl(230 70% 62%)",
};

function ProtoDot({ protocol }: { protocol: Protocol }) {
  return (
    <span
      className="sb-session__dot"
      style={{ background: PROTO_COLOR[protocol] ?? "var(--color-muted-soft)" }}
    />
  );
}

// ---- Session row ----

function SessionRow({
  session,
  isEditing,
  dragging,
  onOpen,
  onMenuOpen,
  onRename,
  onStartRename,
  onToggleFavorite,
  onDragStart,
}: {
  session: Session;
  isEditing: boolean;
  dragging: boolean;
  onOpen: () => void;
  onMenuOpen: (x: number, y: number) => void;
  onRename: (newName: string) => void;
  onStartRename: () => void;
  onToggleFavorite: () => void;
  onDragStart: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(session.name);

  useEffect(() => {
    if (isEditing) {
      setDraft(session.name);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing, session.name]);

  const submit = () => {
    const name = draft.trim();
    onRename(name || session.name);
  };

  const handleKeyDownInput = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onRename(session.name); // cancel by sending same name
    }
  };

  const handleKeyDownMain = (e: React.KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      onStartRename();
    }
  };

  const handleMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = btnRef.current?.getBoundingClientRect();
    if (r) onMenuOpen(r.right + 4, r.top);
  };

  const handleCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    onMenuOpen(e.clientX, e.clientY);
  };


  if (isEditing) {
    return (
      <div className="sb-session sb-session--editing">
        <ProtoDot protocol={session.protocol} />
        <input
          ref={inputRef}
          className="sb-session__edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDownInput}
          onBlur={submit}
        />
      </div>
    );
  }

  return (
    <div
      className={`sb-session${dragging ? " is-dragging" : ""}`}
      onContextMenu={handleCtx}
      // Cancel any native text/element drag so it can't steal pointer tracking.
      onDragStart={(e) => e.preventDefault()}
    >
      <button
        className="sb-session__main"
        onClick={onOpen}
        onKeyDown={handleKeyDownMain}
        onMouseDown={onDragStart}
      >
        <ProtoDot protocol={session.protocol} />
        <span className="sb-session__name">{session.name}</span>
      </button>
      <button
        className={`sb-session__star-btn${session.favorite ? " is-fav" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        data-tooltip={session.favorite ? t("sidebar.remove_from_favorites") : t("sidebar.add_to_favorites")}
        data-tooltip-pos="left"
        aria-pressed={session.favorite}
      >
        {session.favorite ? "★" : "☆"}
      </button>
      <button
        ref={btnRef}
        className="sb-session__more"
        onClick={handleMenu}
        data-tooltip={t("sidebar.more_options")}
        data-tooltip-pos="left"
      >
        ⋮
      </button>
    </div>
  );
}

// ---- Folder tree types ----

interface TreeNode {
  name: string;
  color?: string;
  children: TreeNode[];
  sessions: Session[];
}

/** Props shared across all FolderNode instances in the tree (passed down unchanged). */
interface FolderShared {
  isOpen: (name: string) => boolean;
  dropTarget: string | null;
  draggingId: string | null;
  draggingFolder: string | null;
  editingFolder: string | null;
  editingId: string | null;
  onOpen: (s: Session) => void;
  onSessionMenu: (s: Session, x: number, y: number) => void;
  onFolderMenu: (name: string, x: number, y: number) => void;
  onRename: (s: Session, newName: string) => void;
  onStartRename: (s: Session) => void;
  onToggleFavorite: (s: Session) => void;
  onSessionDragStart: (s: Session, e: React.MouseEvent) => void;
  onFolderDragStart: (name: string, e: React.MouseEvent) => void;
  onToggleFolder: (name: string) => void;
  onRenameFolder: (oldName: string, newName: string) => void;
  /** undefined = not creating; null = root; "name" = inside that folder */
  newFolderParent: string | null | undefined;
  newFolderDraft: string;
  setNewFolderDraft: (v: string) => void;
  newFolderInputRef: React.RefObject<HTMLInputElement>;
  onSubmitFolder: () => void;
  onCancelFolder: () => void;
  folderNamePlaceholder: string;
}

// ---- Folder node (recursive) ----

function FolderNode({ node, shared }: { node: TreeNode; shared: FolderShared }) {
  const { name, color, children, sessions } = node;
  const displayName = name.split("/").filter(Boolean).pop() ?? name;
  const open = shared.isOpen(name);
  const isDropTarget = shared.dropTarget === name;
  const isRenaming = shared.editingFolder === name;
  const creatingSubfolder = shared.newFolderParent === name;

  const [draft, setDraft] = useState(displayName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setDraft(displayName);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isRenaming, displayName]);

  const submit = () => {
    const next = draft.trim() || displayName;
    shared.onRenameFolder(name, next === displayName ? name : next);
  };

  return (
    <div className={`sb-folder${isDropTarget ? " is-dragover" : ""}`} data-folder={name}>
      {isRenaming ? (
        <div className="sb-folder__row sb-folder__row--editing">
          <span className="sb-folder__arrow" />
          <span className="sb-folder__icon" style={color ? { color } : undefined}>
            <IconFolder size={15} />
          </span>
          <input
            ref={inputRef}
            className="sb-folder__edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                shared.onRenameFolder(name, name); // cancel
              }
            }}
            onBlur={submit}
          />
        </div>
      ) : (
        <button
          className="sb-folder__row"
          onClick={() => shared.onToggleFolder(name)}
          onMouseDown={(e) => shared.onFolderDragStart(name, e)}
          onContextMenu={(e) => {
            e.preventDefault();
            shared.onFolderMenu(name, e.clientX, e.clientY);
          }}
        >
          <span className={`sb-folder__arrow${open ? " is-open" : ""}`}>▶</span>
          <span className="sb-folder__icon" style={color ? { color } : undefined}>
            <IconFolder size={15} />
          </span>
          <span className="sb-folder__name" title={name}>{displayName}</span>
          <span className="sb-folder__count">{sessions.length}</span>
        </button>
      )}
      {open && (
        <div className="sb-folder__children">
          {children.map((child) => (
            <FolderNode key={child.name} node={child} shared={shared} />
          ))}
          {creatingSubfolder && (
            <div className="sb-folder">
              <div className="sb-folder__row sb-folder__row--editing">
                <span className="sb-folder__arrow" />
                <span className="sb-folder__icon">
                  <IconFolder size={15} />
                </span>
                <input
                  ref={shared.newFolderInputRef}
                  className="sb-folder__edit"
                  placeholder={shared.folderNamePlaceholder}
                  value={shared.newFolderDraft}
                  onChange={(e) => shared.setNewFolderDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      shared.onSubmitFolder();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      shared.onCancelFolder();
                    }
                  }}
                  onBlur={shared.onSubmitFolder}
                />
              </div>
            </div>
          )}
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              isEditing={shared.editingId === s.id}
              dragging={shared.draggingId === s.id}
              onOpen={() => shared.onOpen(s)}
              onMenuOpen={(x, y) => shared.onSessionMenu(s, x, y)}
              onRename={(n) => shared.onRename(s, n)}
              onStartRename={() => shared.onStartRename(s)}
              onToggleFavorite={() => shared.onToggleFavorite(s)}
              onDragStart={(e) => shared.onSessionDragStart(s, e)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Sidebar ----

type SidebarView = "sessions" | "files";
type SortMode = "name" | "recent" | "favorites";

// Palette offered for folder personalization (pastels + default yellow + white).
const FOLDER_COLORS: { value: string | null; label: string }[] = [
  { value: null, label: "Default" },
  { value: "#faff69", label: "Yellow" },
  { value: "#ffadcd", label: "Pink" },
  { value: "#a9d3ff", label: "Blue" },
  { value: "#aef2c5", label: "Green" },
  { value: "#ff9b9b", label: "Red" },
  { value: "#cdb8ff", label: "Purple" },
  { value: "#ffce9e", label: "Orange" },
  { value: "#ffffff", label: "White" },
];

function sortSessions(list: Session[], mode: SortMode): Session[] {
  const byName = (a: Session, b: Session) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const copy = [...list];
  if (mode === "recent") {
    copy.sort((a, b) => {
      const ta = a.last_used_at ? Date.parse(a.last_used_at) : 0;
      const tb = b.last_used_at ? Date.parse(b.last_used_at) : 0;
      return tb - ta || byName(a, b);
    });
  } else if (mode === "favorites") {
    copy.sort((a, b) => Number(b.favorite) - Number(a.favorite) || byName(a, b));
  } else {
    copy.sort(byName);
  }
  return copy;
}

function buildTree(
  records: FolderRecord[],
  filtered: Session[],
  sortMode: SortMode,
  showEmpty: boolean,
  parentId: string | null,
): TreeNode[] {
  const recordNames = new Set(records.map((r) => r.name));

  const children = records
    .filter((r) => (r.parent_id ?? null) === parentId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({
      name: r.name,
      color: r.color ?? undefined,
      children: buildTree(records, filtered, sortMode, showEmpty, r.name),
      sessions: sortSessions(
        filtered.filter((s) => s.folder_id === r.name),
        sortMode,
      ),
    }));

  // Orphan folders: referenced by sessions but not in records (legacy data, root only).
  const orphans: TreeNode[] =
    parentId === null
      ? [
          ...new Set(
            filtered
              .map((s) => s.folder_id)
              .filter((id): id is string => !!id && !recordNames.has(id)),
          ),
        ]
          .sort()
          .map((name) => ({
            name,
            color: undefined,
            children: [],
            sessions: sortSessions(
              filtered.filter((s) => s.folder_id === name),
              sortMode,
            ),
          }))
      : [];

  const all = [...children, ...orphans];
  return showEmpty ? all : all.filter((n) => n.sessions.length > 0 || n.children.length > 0);
}

function allNamesInTree(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => [n.name, ...allNamesInTree(n.children)]);
}

/** Returns the set of a folder's name + all its nested descendants. */
function getDescendants(folderName: string, records: FolderRecord[]): Set<string> {
  const result = new Set<string>();
  const queue = [folderName];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.add(current);
    for (const r of records) {
      if (r.parent_id === current && !result.has(r.name)) queue.push(r.name);
    }
  }
  return result;
}

const WIDTH_KEY = "hampy:sidebar-width";
const MIN_WIDTH = 200;
const MAIN_MIN = 100; // minimum visible width for the main content area
const getMaxWidth = () =>
  typeof window !== "undefined" ? window.innerWidth - MAIN_MIN : 2000;

function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    const max = getMaxWidth();
    return saved >= MIN_WIDTH && saved <= max ? saved : 240;
  });
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const onResize = () => {
      const max = getMaxWidth();
      if (width > max) {
        const next = Math.max(MIN_WIDTH, max);
        setWidth(next);
        localStorage.setItem(WIDTH_KEY, String(next));
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [width]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startWidth = width;

    const onMove = (ev: MouseEvent) => {
      const max = getMaxWidth();
      const next = Math.max(MIN_WIDTH, Math.min(max, startWidth + (ev.clientX - startX)));
      setWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return { width, resizing, startResize };
}

export function Sidebar() {
  const { t } = useTranslation();
  const openTab = useAppStore((s) => s.openTab);
  const openNewSessionModal = useAppStore((s) => s.openNewSessionModal);
  const openEditSession = useAppStore((s) => s.openEditSession);
  const sessionListVersion = useAppStore((s) => s.sessionListVersion);
  const bumpSessionVersion = useAppStore((s) => s.bumpSessionVersion);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [folderRecords, setFolderRecords] = useState<FolderRecord[]>([]);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const [view, setView] = useState<SidebarView>("sessions");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [transferMsg, setTransferMsg] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("name");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Pointer-based drag of a session onto a folder. (Tauri's native drag-drop
  // handler breaks HTML5 DnD inside the WebView2, so we track pointer events.)
  const [drag, setDrag] = useState<{ kind: "session"; id: string; name: string } | { kind: "folder"; name: string } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder name | "__root__" | null
  const [newFolderDraft, setNewFolderDraft] = useState<string>("");
  // undefined = not creating; null = root-level; "name" = subfolder of that folder
  const [newFolderParent, setNewFolderParent] = useState<string | null | undefined>(undefined);
  const [newFolderMoveSession, setNewFolderMoveSession] = useState<Session | null>(null);
  const [movePickerSession, setMovePickerSession] = useState<Session | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const suppressClickRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { width, resizing, startResize } = useSidebarWidth();

  // The machine shown in the main area, used to drive the Files browser.
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeSsh =
    activeTab?.kind === "session" &&
    (activeTab.protocol === "ssh" || activeTab.protocol === "sftp")
      ? activeTab.sshConfig
      : undefined;

  // Auto-reveal the Files browser when the active tab becomes an SSH machine,
  // and fall back to the session list on tabs that aren't a remote machine.
  const lastTabId = useRef<string | null>(activeTabId);
  useEffect(() => {
    if (activeTabId === lastTabId.current) return;
    lastTabId.current = activeTabId;
    if (
      activeTab?.kind === "session" &&
      activeTab.protocol === "ssh" &&
      activeTab.sshConfig
    ) {
      setView("files");
    } else if (!activeSsh) {
      setView("sessions");
    }
  }, [activeTabId, activeTab, activeSsh]);

  const refresh = useCallback(() => {
    if (!isTauri) return;
    ipc.listSessions().then(setSessions).catch(() => setSessions([]));
  }, []);

  const refreshFolders = useCallback(() => {
    if (!isTauri) return;
    ipc.listFolders().then(setFolderRecords).catch(() => setFolderRecords([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, sessionListVersion]);

  useEffect(() => {
    refreshFolders();
  }, [refreshFolders, sessionListVersion]);

  // Focus the filter input the moment it is revealed.
  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen]);

  // Look up a folder's display color from the persisted records.
  const folderColor = (name: string): string | undefined =>
    folderRecords.find((f) => f.name === name)?.color ?? undefined;

  // Persist a folder's color change (upserts the record).
  const setFolderColor = async (folder: string, color: string | null) => {
    if (!isTauri) return;
    const existing = folderRecords.find((r) => r.name === folder);
    await ipc.saveFolder({ name: folder, color, parent_id: existing?.parent_id ?? null });
    refreshFolders();
  };

  // Start a pointer-driven drag from a session row. A real drag only begins once
  // the pointer moves past a small threshold, so plain clicks still open.
  const beginDrag = (s: Session, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let started = false;
    let target: string | null = null;

    // Resolve the drop target under a screen point by hit-testing the folder
    // rectangles directly (deterministic; avoids WebView elementFromPoint
    // quirks with the floating ghost / stacking).
    const hit = (el: Element | null, x: number, y: number) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const resolveTarget = (x: number, y: number): string | null => {
      // Iterate in reverse document order so the deepest (most specific) folder wins
      // when the pointer is over a sub-folder whose ancestor also matches the hit test.
      const all = [...document.querySelectorAll<HTMLElement>("[data-folder]")];
      for (let i = all.length - 1; i >= 0; i--) {
        if (hit(all[i], x, y)) return all[i].getAttribute("data-folder");
      }
      return hit(document.querySelector("[data-droproot]"), x, y) ? "__root__" : null;
    };

    const onMove = (ev: MouseEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        started = true;
        setDrag({ kind: "session", id: s.id, name: s.name });
      }
      setGhost({ x: ev.clientX, y: ev.clientY });
      target = resolveTarget(ev.clientX, ev.clientY);
      setDropTarget(target);
    };

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (started) {
        suppressClickRef.current = true; // swallow the click that follows the drop
        // Recompute at the exact release point; fall back to the last hover.
        const dropped = resolveTarget(ev.clientX, ev.clientY) ?? target;
        const dest = dropped === "__root__" ? null : dropped;
        if (dropped && (s.folder_id ?? null) !== dest) {
          updateSession({ ...s, folder_id: dest });
          if (dest) {
            // Expand the destination folder so the moved session is visible.
            setCollapsed((prev) => {
              if (!prev.has(dest)) return prev;
              const next = new Set(prev);
              next.delete(dest);
              return next;
            });
          }
        }
      }
      setDrag(null);
      setDropTarget(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Pointer-driven drag for a folder into another folder.
  const beginFolderDrag = (folderName: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let started = false;
    let target: string | null = null;

    // Pre-compute descendants so we can exclude them as valid targets.
    const invalid = getDescendants(folderName, folderRecords);

    const hit = (el: Element | null, x: number, y: number) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const resolveTarget = (x: number, y: number): string | null => {
      const all = [...document.querySelectorAll<HTMLElement>("[data-folder]")];
      for (let i = all.length - 1; i >= 0; i--) {
        const candidate = all[i].getAttribute("data-folder");
        if (candidate && !invalid.has(candidate) && hit(all[i], x, y)) return candidate;
      }
      return hit(document.querySelector("[data-droproot]"), x, y) ? "__root__" : null;
    };

    const onMove = (ev: MouseEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        started = true;
        setDrag({ kind: "folder", name: folderName });
      }
      setGhost({ x: ev.clientX, y: ev.clientY });
      target = resolveTarget(ev.clientX, ev.clientY);
      setDropTarget(target);
    };

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (started) {
        suppressClickRef.current = true;
        const dropped = resolveTarget(ev.clientX, ev.clientY) ?? target;
        if (dropped !== null && isTauri) {
          const newParent = dropped === "__root__" ? null : dropped;
          const record = folderRecords.find((r) => r.name === folderName);
          if (record && (record.parent_id ?? null) !== newParent) {
            ipc.saveFolder({ ...record, parent_id: newParent }).then(() => {
              refreshFolders();
              if (newParent) {
                setCollapsed((prev) => {
                  if (!prev.has(newParent)) return prev;
                  const next = new Set(prev);
                  next.delete(newParent);
                  return next;
                });
              }
            });
          }
        }
      }
      setDrag(null);
      setDropTarget(null);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Open a session, unless the click is the tail end of a drag gesture.
  const handleOpen = (s: Session) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    openSession(s);
  };

  const openSession = async (s: Session) => {
    // Resolve any keychain-stored credentials back into the config before
    // handing it to the live tab.
    const resolved = isTauri ? await injectSecrets(s) : s;
    const opts = resolved.options as Record<string, unknown>;
    const sshCfg = opts?.sshConfig as SshConfig | undefined;
    const serialCfg = opts?.serialConfig as SerialConfig | undefined;
    const rdpCfg = opts?.rdpConfig as RdpConfig | undefined;
    const vncCfg = opts?.vncConfig as VncConfig | undefined;
    const ftpCfg = opts?.ftpConfig as FtpConfig | undefined;
    const dockerCfg = opts?.dockerConfig as DockerConfig | undefined;
    const kubernetesCfg = opts?.kubernetesConfig as KubernetesConfig | undefined;
    openTab({
      title: s.name,
      kind: "session",
      protocol: s.protocol,
      sshConfig: sshCfg,
      serialConfig: serialCfg,
      rdpConfig: rdpCfg,
      vncConfig: vncCfg,
      ftpConfig: ftpCfg,
      dockerConfig: dockerCfg,
      kubernetesConfig: kubernetesCfg,
    });
  };

  const deleteSession = async (s: Session) => {
    if (!isTauri) return;
    await ipc.deleteSession(s.id);
    await clearSecrets(s.id);
    bumpSessionVersion();
    refresh();
  };

  // Show a transient status under the action buttons (auto-clears).
  const flash = (msg: string) => {
    setTransferMsg(msg);
    window.setTimeout(() => setTransferMsg(null), 4000);
  };

  const doImport = async () => {
    if (!isTauri) return;
    try {
      const n = await importSessions();
      if (n === null) return; // cancelled
      bumpSessionVersion();
      refresh();
      flash(n ? `Imported ${n} session${n === 1 ? "" : "s"}` : "No sessions found");
    } catch (e) {
      flash(`Import failed: ${e}`);
    }
  };

  const doExport = async () => {
    if (!isTauri) return;
    try {
      const n = await exportSessions();
      if (n === null) return; // cancelled
      flash(`Exported ${n} session${n === 1 ? "" : "s"}`);
    } catch (e) {
      flash(`Export failed: ${e}`);
    }
  };

  const updateSession = async (updated: Session) => {
    if (!isTauri) return;
    await ipc.saveSession(updated);
    bumpSessionVersion();
    refresh();
  };

  const moveToFolder = (s: Session, folder: string | null) =>
    updateSession({ ...s, folder_id: folder });

  const toggleFavorite = (s: Session) => updateSession({ ...s, favorite: !s.favorite });

  const renameSession = (s: Session) => {
    setEditingId(s.id);
  };

  const finishRename = async (s: Session, newName: string) => {
    setEditingId(null);
    if (newName === s.name) return;
    await updateSession({ ...s, name: newName });
  };

  const openSessionMenu = (s: Session, x: number, y: number) => {
    const items: CtxItem[] = [
      { kind: "action", label: t("sidebar.open"), onClick: () => openSession(s) },
      { kind: "action", label: t("sidebar.edit_session"), onClick: () => { setCtx(null); openEditSession(s); } },
      {
        kind: "action",
        label: s.favorite ? t("sidebar.remove_from_favorites") : t("sidebar.add_to_favorites"),
        icon: <IconStar />,
        onClick: () => updateSession({ ...s, favorite: !s.favorite }),
      },
      { kind: "sep" },
      { kind: "action", label: t("common.rename"), onClick: () => { setCtx(null); renameSession(s); } },
      {
        kind: "action",
        label: t("sidebar.move_to"),
        icon: <IconFolder size={15} />,
        onClick: () => setMovePickerSession(s),
      },
      { kind: "sep" },
      {
        kind: "action" as const,
        danger: true,
        label: t("common.delete"),
        onClick: () => deleteSession(s),
      },
    ];
    setCtx({ x, y, items });
  };

  const openFolderMenu = (folder: string, x: number, y: number) => {
    const items: CtxItem[] = [
      {
        kind: "swatches",
        label: t("sidebar.folder_color"),
        colors: FOLDER_COLORS,
        current: folderColor(folder) ?? null,
        onPick: (value) => setFolderColor(folder, value),
      },
      { kind: "sep" },
      {
        kind: "action",
        label: t("sidebar.new_subfolder"),
        onClick: () => {
          setCtx(null);
          newFolder(folder);
        },
      },
      {
        kind: "action",
        label: t("sidebar.rename_folder"),
        onClick: () => {
          setCtx(null);
          setEditingFolder(folder);
        },
      },
      { kind: "sep" },
      {
        kind: "action",
        danger: true,
        label: t("sidebar.delete_folder_keep"),
        onClick: async () => {
          // Move direct sessions to root.
          const toMove = sessions.filter((s) => s.folder_id === folder);
          for (const s of toMove) {
            await ipc.saveSession({ ...s, folder_id: null });
          }
          // Re-parent sub-folders to this folder's parent (or root).
          const parentId = folderRecords.find((r) => r.name === folder)?.parent_id ?? null;
          const subFolders = folderRecords.filter((r) => r.parent_id === folder);
          for (const sub of subFolders) {
            await ipc.saveFolder({ ...sub, parent_id: parentId });
          }
          if (isTauri) await ipc.deleteFolder(folder);
          bumpSessionVersion();
          refresh();
          refreshFolders();
        },
      },
    ];
    setCtx({ x, y, items });
  };

  // ---- Quick-access toolbar handlers ----

  const newFolder = (parent: string | null = null, moveSession: Session | null = null) => {
    setNewFolderDraft("");
    setNewFolderParent(parent);
    setNewFolderMoveSession(moveSession);
    // Open the parent folder so the inline input is visible
    if (parent !== null) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parent);
        return next;
      });
    }
    requestAnimationFrame(() => newFolderInputRef.current?.focus());
  };

  const submitNewFolder = async () => {
    const name = newFolderDraft.trim();
    const parent = newFolderParent;
    setNewFolderParent(undefined);
    setNewFolderDraft("");
    if (!name || !isTauri) return;
    await ipc.saveFolder({ name, color: null, parent_id: parent ?? null });
    if (newFolderMoveSession) {
      await moveToFolder(newFolderMoveSession, name);
      setNewFolderMoveSession(null);
    }
    refreshFolders();
  };

  const cancelNewFolder = () => {
    setNewFolderParent(undefined);
    setNewFolderDraft("");
    setNewFolderMoveSession(null);
  };

  // Rename a folder: the backend updates the record and all session references
  // atomically, so the frontend only needs to sync the collapsed state.
  const finishFolderRename = async (oldName: string, rawNew: string): Promise<void> => {
    setEditingFolder(null);
    const name = rawNew.trim();
    if (!name || name === oldName) return;
    if (isTauri) await ipc.renameFolder(oldName, name);
    setCollapsed((prev) => {
      if (!prev.has(oldName)) return prev;
      const next = new Set(prev);
      next.delete(oldName);
      next.add(name);
      return next;
    });
    bumpSessionVersion();
    refresh();
    refreshFolders();
  };

  const toggleFolder = (folder: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  // Suppresses the click that fires after a folder drag ends.
  const handleToggleFolder = (name: string) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    toggleFolder(name);
  };

  const openSortMenu = (x: number, y: number) => {
    const opt = (mode: SortMode, label: string): CtxItem => ({
      kind: "action",
      label: `${sortMode === mode ? "✓ " : "   "}${label}`,
      onClick: () => setSortMode(mode),
    });
    setCtx({
      x,
      y,
      items: [
        opt("name", "Name (A–Z)"),
        opt("recent", "Recently used"),
        opt("favorites", "Favorites first"),
      ],
    });
  };

  // ---- Filtered + sorted view of the session tree ----

  const q = search.trim().toLowerCase();
  const matches = (s: Session) =>
    (!favoritesOnly || s.favorite) && (!q || s.name.toLowerCase().includes(q));
  const filtered = sessions.filter(matches);

  // Show user-created (possibly empty) folders only when not actively filtering.
  // During a folder drag also force all folders visible so they can be drop targets.
  const showExtras = !q && !favoritesOnly;
  const isDraggingFolder = drag?.kind === "folder";
  const rootTree = buildTree(folderRecords, filtered, sortMode, showExtras || isDraggingFolder, null);
  const unfiled = sortSessions(filtered.filter((s) => !s.folder_id), sortMode);

  // When filtering, force all folders open so matches are visible.
  const isFolderOpen = (folder: string) => (q ? true : !collapsed.has(folder));
  const allFolderNames = allNamesInTree(rootTree);
  const allCollapsed = allFolderNames.length > 0 && allFolderNames.every((f) => collapsed.has(f));
  const toggleAllFolders = () =>
    setCollapsed(allCollapsed ? new Set() : new Set(allFolderNames));

  const folderShared: FolderShared = {
    isOpen: isFolderOpen,
    dropTarget,
    draggingId: drag?.kind === "session" ? drag.id : null,
    draggingFolder: drag?.kind === "folder" ? drag.name : null,
    editingFolder,
    editingId,
    onOpen: handleOpen,
    onSessionMenu: openSessionMenu,
    onFolderMenu: openFolderMenu,
    onRename: finishRename,
    onStartRename: renameSession,
    onToggleFavorite: toggleFavorite,
    onSessionDragStart: beginDrag,
    onFolderDragStart: beginFolderDrag,
    onToggleFolder: handleToggleFolder,
    onRenameFolder: finishFolderRename,
    newFolderParent,
    newFolderDraft,
    setNewFolderDraft,
    newFolderInputRef,
    onSubmitFolder: submitNewFolder,
    onCancelFolder: cancelNewFolder,
    folderNamePlaceholder: t("sidebar.folder_name_placeholder"),
  };

  return (
    <nav
      className="sidebar"
      style={{ width, flexBasis: width, userSelect: resizing || drag ? "none" : undefined }}
    >
      <div
        className={`sidebar__resize-handle${resizing ? " is-active" : ""}`}
        onMouseDown={startResize}
      />
      {/* Two tabs: the saved-machine list and the SFTP browser of the active one. */}
      <div className="sidebar__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={view === "sessions"}
          className={`sidebar__tab${view === "sessions" ? " is-active" : ""}`}
          onClick={() => setView("sessions")}
        >
          {t("sidebar.tab_sessions")}
        </button>
        <button
          role="tab"
          aria-selected={view === "files"}
          className={`sidebar__tab${view === "files" ? " is-active" : ""}`}
          onClick={() => setView("files")}
        >
          {t("sidebar.tab_files")}
          {activeSsh && <span className="sidebar__tab-dot" />}
        </button>
      </div>

      {/* Sessions view */}
      <div
        className="sidebar__view"
        style={{ display: view === "sessions" ? "flex" : "none" }}
      >
        <div className="sidebar__top">
          <button className="sidebar__btn-new" onClick={openNewSessionModal}>
            <span className="sidebar__btn-plus">＋</span>
            {t("sidebar.new_session")}
          </button>
          {/* Quick-access toolbar. */}
          <div className="sidebar__quickbar">
            <button
              className={`sidebar__quick-btn${searchOpen ? " is-active" : ""}`}
              onClick={() => setSearchOpen((o) => !o)}
              data-tooltip={t("sidebar.search_tooltip")}
              data-tooltip-pos="bottom"
            >
              <IconSearch size={13} />
            </button>
            <button
              className={`sidebar__quick-btn${favoritesOnly ? " is-active" : ""}`}
              onClick={() => setFavoritesOnly((v) => !v)}
              data-tooltip={t("sidebar.favorites_tooltip")}
              data-tooltip-pos="bottom"
            >
              <IconStar size={13} />
            </button>
            <button
              className={`sidebar__quick-btn${sortMode !== "name" ? " is-active" : ""}`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                openSortMenu(r.left, r.bottom + 4);
              }}
              data-tooltip={t("sidebar.sort_tooltip")}
              data-tooltip-pos="bottom"
            >
              <IconSort size={13} />
            </button>
            <button
              className="sidebar__quick-btn"
              onClick={() => newFolder(null)}
              data-tooltip={t("sidebar.new_folder_tooltip")}
              data-tooltip-pos="bottom"
            >
              <IconNewFolder size={13} />
            </button>
            <button
              className="sidebar__quick-btn"
              onClick={toggleAllFolders}
              disabled={allFolderNames.length === 0}
              data-tooltip={allCollapsed ? t("sidebar.expand_all") : t("sidebar.collapse_all")}
              data-tooltip-pos="bottom"
            >
              {allCollapsed ? <IconExpand size={13} /> : <IconCollapse size={13} />}
            </button>
            <button
              className="sidebar__quick-btn"
              onClick={() => refresh()}
              data-tooltip={t("sidebar.refresh_tooltip")}
              data-tooltip-pos="bottom"
            >
              <IconRefresh size={13} />
            </button>
            <span className="sidebar__quick-sep" />
            <button
              className="sidebar__quick-btn"
              onClick={doImport}
              data-tooltip={t("sidebar.import_tooltip")}
              data-tooltip-pos="bottom"
            >
              <IconDownload size={13} />
            </button>
            <button
              className="sidebar__quick-btn"
              onClick={doExport}
              data-tooltip={t("sidebar.export_tooltip")}
              data-tooltip-pos="bottom"
            >
              <IconUpload size={13} />
            </button>
          </div>

          {searchOpen && (
            <input
              ref={searchInputRef}
              className="sidebar__search"
              placeholder={t("sidebar.filter_placeholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearch("");
                  setSearchOpen(false);
                }
              }}
            />
          )}
          {transferMsg && <span className="sidebar__top-msg">{transferMsg}</span>}
        </div>

        <div
          className={`sidebar__tree${dropTarget === "__root__" ? " is-dragover-root" : ""}`}
          data-droproot
        >
          {sessions.length === 0 ? (
            <div className="sidebar__empty">
              <p>{t("sidebar.no_sessions")}</p>
              <button className="sidebar__empty-cta" onClick={openNewSessionModal}>
                {t("sidebar.add_first_session")}
              </button>
            </div>
          ) : rootTree.length === 0 && unfiled.length === 0 ? (
            <div className="sidebar__empty">
              <p>{favoritesOnly || q ? t("sidebar.no_matching") : t("sidebar.no_sessions")}</p>
            </div>
          ) : (
            <>
              {newFolderParent === null && (
                <div className="sb-folder">
                  <div className="sb-folder__row sb-folder__row--editing">
                    <span className="sb-folder__arrow" />
                    <span className="sb-folder__icon">
                      <IconFolder size={15} />
                    </span>
                    <input
                      ref={newFolderInputRef}
                      className="sb-folder__edit"
                      placeholder={t("sidebar.folder_name_placeholder")}
                      value={newFolderDraft}
                      onChange={(e) => setNewFolderDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          submitNewFolder();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelNewFolder();
                        }
                      }}
                      onBlur={submitNewFolder}
                    />
                  </div>
                </div>
              )}
              {rootTree.map((node) => (
                <FolderNode key={node.name} node={node} shared={folderShared} />
              ))}
              {unfiled.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  isEditing={editingId === s.id}
                  dragging={drag?.kind === "session" && drag.id === s.id}
                  onOpen={() => handleOpen(s)}
                  onMenuOpen={(x, y) => openSessionMenu(s, x, y)}
                  onRename={(name) => finishRename(s, name)}
                  onStartRename={() => renameSession(s)}
                  onToggleFavorite={() => toggleFavorite(s)}
                  onDragStart={(e) => beginDrag(s, e)}
                />
              ))}
            </>
          )}
        </div>
      </div>

      {/* Files view (kept mounted so the SFTP connection survives tab flips). */}
      <div
        className="sidebar__view"
        style={{ display: view === "files" ? "flex" : "none" }}
      >
        <SidebarFiles
          active={view === "files"}
          sshConfig={activeSsh}
          sessionKey={activeSsh ? activeTabId : null}
          sessionTitle={activeTab?.title}
        />
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctx.items}
          onClose={() => setCtx(null)}
        />
      )}

      {movePickerSession && (
        <MoveToFolderDialog
          sessionName={movePickerSession.name}
          currentFolder={movePickerSession.folder_id ?? null}
          folders={folderRecords}
          extraFolderNames={sessions
            .map((session) => session.folder_id)
            .filter((folder): folder is string => !!folder)}
          onMove={(folder) => moveToFolder(movePickerSession, folder)}
          onNewFolder={() => {
            const session = movePickerSession;
            setMovePickerSession(null);
            newFolder(null, session);
          }}
          onClose={() => setMovePickerSession(null)}
        />
      )}

      {drag && (
        <div
          className="sb-drag-ghost"
          style={{ left: ghost.x + 12, top: ghost.y + 8 }}
        >
          {drag.name}
        </div>
      )}
    </nav>
  );
}
