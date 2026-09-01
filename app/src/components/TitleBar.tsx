// Custom window chrome. The native title bar is disabled (decorations:false)
// so we paint our own draggable bar with the brand mark + window controls,
// matching DESIGN.md's 64px top-nav on the canvas color.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { isTauri } from "../lib/ipc";
import { useAppStore } from "../store/appStore";
import "./TitleBar.css";

const appWindow = isTauri ? getCurrentWindow() : null;

export function TitleBar() {
  const { t } = useTranslation();
  const togglePalette = useAppStore((s) => s.togglePalette);
  const openSettings = useAppStore((s) => s.openSettings);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar__brand" data-tauri-drag-region>
        <svg
          className="titlebar__bolt"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
        >
          <path d="M13 2L4 14h6l-1 8 9-12h-6z" fill="currentColor" />
        </svg>
        <span className="titlebar__wordmark">Hampy</span>
      </div>

      <button
        className="titlebar__search"
        onClick={togglePalette}
        data-tooltip={t("titlebar.command_palette_tooltip")}
        data-tooltip-pos="bottom"
      >
        <span>{t("titlebar.search_placeholder")}</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="titlebar__controls">
        <button
          className="titlebar__ctl titlebar__ctl--settings"
          onClick={openSettings}
          aria-label={t("titlebar.settings_tooltip")}
          data-tooltip={t("titlebar.settings_tooltip")}
          data-tooltip-pos="bottom"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button
          className="titlebar__ctl"
          onClick={() => appWindow?.minimize()}
          aria-label={t("titlebar.minimize")}
          data-tooltip={t("titlebar.minimize")}
          data-tooltip-pos="bottom-end"
        >
          <Glyph d="M3 8h10" />
        </button>
        <button
          className="titlebar__ctl"
          onClick={() => appWindow?.toggleMaximize()}
          aria-label={t("titlebar.maximize")}
          data-tooltip={t("titlebar.maximize")}
          data-tooltip-pos="bottom-end"
        >
          <Glyph d="M3.5 3.5h9v9h-9z" fill="none" />
        </button>
        <button
          className="titlebar__ctl titlebar__ctl--close"
          onClick={() => appWindow?.close()}
          aria-label={t("titlebar.close")}
          data-tooltip={t("titlebar.close")}
          data-tooltip-pos="bottom-end"
        >
          <Glyph d="M4 4l8 8M12 4l-8 8" />
        </button>
      </div>
    </header>
  );
}

function Glyph({ d, fill = "none" }: { d: string; fill?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill={fill}>
      <path d={d} stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
