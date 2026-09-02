import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FolderRecord } from "../lib/types";
import { IconFolder, IconNewFolder, IconSearch } from "./icons";
import "./MoveToFolderDialog.css";

interface FolderChoice {
  name: string;
  label: string;
  color?: string;
  depth: number;
}

function folderLabel(name: string): string {
  return name.split("/").filter(Boolean).pop() ?? name;
}

function buildChoices(records: FolderRecord[], extraNames: string[]): FolderChoice[] {
  const byName = new Map(records.map((record) => [record.name, record]));
  const children = new Map<string | null, FolderRecord[]>();

  for (const record of records) {
    const parent = record.parent_id && byName.has(record.parent_id) ? record.parent_id : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(record);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => folderLabel(a.name).localeCompare(folderLabel(b.name), undefined, {
      sensitivity: "base",
      numeric: true,
    }));
  }

  const result: FolderChoice[] = [];
  const visited = new Set<string>();
  const visit = (record: FolderRecord, depth: number) => {
    if (visited.has(record.name)) return;
    visited.add(record.name);
    result.push({
      name: record.name,
      label: folderLabel(record.name),
      color: record.color ?? undefined,
      depth,
    });
    for (const child of children.get(record.name) ?? []) visit(child, depth + 1);
  };

  for (const root of children.get(null) ?? []) visit(root, 0);
  // Preserve malformed/cyclic records as selectable destinations too.
  for (const record of records) visit(record, 0);

  const legacy = [...new Set(extraNames)]
    .filter((name) => !visited.has(name))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  for (const name of legacy) {
    result.push({ name, label: folderLabel(name), depth: 0 });
  }

  return result;
}

export function MoveToFolderDialog({
  sessionName,
  currentFolder,
  folders,
  extraFolderNames,
  onMove,
  onNewFolder,
  onClose,
}: {
  sessionName: string;
  currentFolder: string | null;
  folders: FolderRecord[];
  extraFolderNames: string[];
  onMove: (folder: string | null) => void;
  onNewFolder: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const choices = useMemo(
    () => buildChoices(folders, extraFolderNames),
    [folders, extraFolderNames],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleChoices = normalizedQuery
    ? choices.filter((choice) => choice.name.toLocaleLowerCase().includes(normalizedQuery))
    : choices;

  useEffect(() => {
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const choose = (folder: string | null) => {
    if (folder === currentFolder) return;
    onMove(folder);
    onClose();
  };

  return (
    <div className="move-folder-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="move-folder-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-folder-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="move-folder-header">
          <div>
            <h2 id="move-folder-title">{t("sidebar.move_session")}</h2>
            <p>{t("sidebar.move_session_description", { session: sessionName })}</p>
          </div>
          <button className="move-folder-close" onClick={onClose} aria-label={t("common.close")}>
            ×
          </button>
        </header>

        <label className="move-folder-search">
          <IconSearch size={14} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("sidebar.search_folders")}
          />
        </label>

        <div className="move-folder-list" role="listbox" aria-label={t("sidebar.folder_destination")}>
          {!normalizedQuery && (
            <button
              className={`move-folder-option${currentFolder === null ? " is-current" : ""}`}
              onClick={() => choose(null)}
              disabled={currentFolder === null}
              role="option"
              aria-selected={currentFolder === null}
            >
              <span className="move-folder-root-icon">⌂</span>
              <span className="move-folder-option-text">
                <strong>{t("sidebar.no_folder")}</strong>
                <small>{t("sidebar.sessions_root")}</small>
              </span>
              {currentFolder === null && <span className="move-folder-current">{t("sidebar.current_folder")}</span>}
            </button>
          )}

          {visibleChoices.map((choice) => {
            const current = currentFolder === choice.name;
            return (
              <button
                key={choice.name}
                className={`move-folder-option${current ? " is-current" : ""}`}
                style={{ paddingLeft: 12 + choice.depth * 18 }}
                onClick={() => choose(choice.name)}
                disabled={current}
                role="option"
                aria-selected={current}
                title={choice.name}
              >
                <span className="move-folder-folder-icon" style={choice.color ? { color: choice.color } : undefined}>
                  <IconFolder size={16} />
                </span>
                <span className="move-folder-option-text">
                  <strong>{choice.label}</strong>
                  {(normalizedQuery || choice.name !== choice.label) && <small>{choice.name}</small>}
                </span>
                {current && <span className="move-folder-current">{t("sidebar.current_folder")}</span>}
              </button>
            );
          })}

          {visibleChoices.length === 0 && (
            <div className="move-folder-empty">{t("sidebar.no_folders_found")}</div>
          )}
        </div>

        <footer className="move-folder-footer">
          <button onClick={onNewFolder}>
            <IconNewFolder size={15} />
            {t("sidebar.move_to_new_folder")}
          </button>
          <span>{t("sidebar.folder_count", { count: choices.length })}</span>
        </footer>
      </section>
    </div>
  );
}
