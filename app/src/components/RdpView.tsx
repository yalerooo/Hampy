// An RDP tab: a connection form, then a <canvas> rendering the remote desktop.
// Framebuffer regions arrive on the rdp-event channel (base64 RGBA) and are
// blitted with putImageData; keyboard/mouse are captured on the canvas and sent
// back as RdpInput. The canvas uses the native desktop resolution and is scaled
// to fit with CSS, so pointer coordinates are mapped back to desktop space.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ipc, isTauri, onRdpEvent } from "../lib/ipc";
import type { RdpConfig, RdpInput } from "../lib/types";
import { SCANCODES } from "../lib/rdpKeymap";
import "./RdpView.css";

function usableUsername(value: string | undefined): string {
  const username = value?.trim() ?? "";
  return username.toLocaleLowerCase() === "<default>" ? "" : username;
}

interface RdpUiError {
  title: string;
  message: string;
}

type RdpViewMode = "embedded" | "focus" | "fullscreen";

export function RdpView({ initialConfig }: { initialConfig?: RdpConfig }) {
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<RdpUiError | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [activeConfig, setActiveConfig] = useState<RdpConfig | null>(null);
  const [viewMode, setViewMode] = useState<RdpViewMode>("embedded");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [clipboardStatus, setClipboardStatus] = useState<"off" | "ready" | "blocked">("off");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<string | null>(null);
  const viewModeRef = useRef<RdpViewMode>("embedded");
  const windowTransitionRef = useRef(false);
  const controlsTimerRef = useRef<number | null>(null);
  const didAuto = useRef(false);
  const lastClipboard = useRef("");

  const friendlyError = (reason: unknown): RdpUiError => {
    const raw = String(reason);
    if (/STATUS_?LOGON_?FAILURE|0xC000006D/i.test(raw)) {
      return {
        title: t("rdp.invalid_credentials_title"),
        message: t("rdp.invalid_credentials_message"),
      };
    }
    if (/timed out/i.test(raw)) {
      return {
        title: t("rdp.timeout_title"),
        message: t("rdp.timeout_message"),
      };
    }
    return {
      title: t("rdp.connection_error_title"),
      message: raw.replace(/^rdp error:\s*/i, ""),
    };
  };

  useEffect(() => {
    idRef.current = sessionId;
  }, [sessionId]);

  // Close the session on unmount.
  useEffect(() => {
    return () => {
      if (idRef.current) ipc.closeRdp(idRef.current);
      if (viewModeRef.current === "fullscreen") {
        void ipc.setRdpFullscreen(false).catch(() => {});
      }
      if (controlsTimerRef.current !== null) {
        window.clearTimeout(controlsTimerRef.current);
      }
    };
  }, []);

  const connect = async (config: RdpConfig) => {
    setError(null);
    setConnecting(true);
    try {
      const opened = await ipc.openRdp(config);
      setActiveConfig(config);
      setClipboardStatus(config.clipboard_enabled ? "ready" : "off");
      setSize({ w: opened.width, h: opened.height });
      setSessionId(opened.id);
      setConnecting(false);
    } catch (e) {
      setError(friendlyError(e));
      setConnecting(false);
    }
  };

  // Auto-connect from a saved session.
  useEffect(() => {
    // Imported sessions intentionally contain no passwords. Keep the form open
    // so the user can provide one instead of starting a doomed CredSSP attempt.
    if (initialConfig?.password && usableUsername(initialConfig.username) && !didAuto.current) {
      didAuto.current = true;
      connect(initialConfig);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to graphics/lifecycle events once connected.
  useEffect(() => {
    if (!sessionId) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let startFrame: number | undefined;

    onRdpEvent(sessionId, (ev) => {
      const canvas = canvasRef.current;
      if (ev.kind === "resized") {
        setSize({ w: ev.width, h: ev.height });
        setConnecting(false);
        if (canvas) {
          canvas.width = ev.width;
          canvas.height = ev.height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, ev.width, ev.height);
          }
        }
      } else if (ev.kind === "frame" && ev.data && canvas) {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const bin = atob(ev.data);
        const arr = new Uint8ClampedArray(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const img = new ImageData(arr, ev.width, ev.height);
        ctx.putImageData(img, ev.x, ev.y);
      } else if (ev.kind === "clipboard" && ev.text !== null) {
        lastClipboard.current = ev.text;
        writeText(ev.text).catch(() => setClipboardStatus("blocked"));
      } else if (ev.kind === "disconnected") {
        setError(friendlyError(ev.reason ?? t("rdp.session_ended")));
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
        // Deferring one frame avoids starting from Strict Mode's disposable
        // first effect pass, after which no listener would remain attached.
        startFrame = requestAnimationFrame(() => {
          if (!disposed) {
            ipc.startRdpEvents(sessionId).catch((reason) => {
              if (!disposed) setError(friendlyError(reason));
            });
          }
        });
      })
      .catch((reason) => {
        if (!disposed) setError(friendlyError(reason));
      });

    return () => {
      disposed = true;
      if (startFrame !== undefined) cancelAnimationFrame(startFrame);
      unlisten?.();
    };
  }, [sessionId]);

  // The WebView is the permission boundary for the local clipboard. Polling
  // only while focused avoids background reads and keeps CLIPRDR bidirectional.
  useEffect(() => {
    if (!sessionId || !activeConfig?.clipboard_enabled) return;
    let disposed = false;
    const syncClipboard = async () => {
      if (disposed || !document.hasFocus()) return;
      try {
        const text = await readText();
        setClipboardStatus("ready");
        if (text !== lastClipboard.current) {
          lastClipboard.current = text;
          await ipc.rdpInput(sessionId, { kind: "clipboard", text });
        }
      } catch {
        setClipboardStatus("blocked");
      }
    };
    void syncClipboard();
    const timer = window.setInterval(syncClipboard, 900);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [sessionId, activeConfig?.clipboard_enabled]);

  const changeViewMode = (mode: RdpViewMode) => {
    viewModeRef.current = mode;
    setViewMode(mode);
  };

  const toggleFullscreen = async () => {
    if (windowTransitionRef.current) return;
    windowTransitionRef.current = true;
    try {
      const entering = viewMode !== "fullscreen";
      if (!isTauri) {
        if (entering) await document.documentElement.requestFullscreen();
        else await document.exitFullscreen();
      } else {
        await ipc.setRdpFullscreen(entering);
      }
      changeViewMode(entering ? "fullscreen" : "embedded");
      setControlsVisible(true);
      requestAnimationFrame(() => canvasRef.current?.focus());
    } catch (reason) {
      if (viewModeRef.current === "fullscreen") {
        await ipc.setRdpFullscreen(false).catch(() => {});
      }
      changeViewMode("embedded");
      setError(friendlyError(reason));
    } finally {
      windowTransitionRef.current = false;
    }
  };

  const toggleFocusMode = async () => {
    if (viewMode === "fullscreen") await toggleFullscreen();
    else changeViewMode(viewMode === "focus" ? "embedded" : "focus");
    requestAnimationFrame(() => canvasRef.current?.focus());
  };

  const revealControls = () => {
    if (viewMode !== "fullscreen") return;
    setControlsVisible(true);
    if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = window.setTimeout(() => setControlsVisible(false), 1800);
  };

  useEffect(() => {
    if (viewMode !== "fullscreen") return;
    revealControls();
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void toggleFullscreen();
    };
    window.addEventListener("keydown", exitOnEscape, true);
    return () => window.removeEventListener("keydown", exitOnEscape, true);
  }, [viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.documentElement.classList.toggle("rdp-fullscreen-active", viewMode === "fullscreen");
    return () => document.documentElement.classList.remove("rdp-fullscreen-active");
  }, [viewMode]);

  const reconnectAtResolution = async (width: number, height: number) => {
    if (!activeConfig) return;
    const normalizedWidth = Math.max(200, Math.min(8192, Math.floor(width / 2) * 2));
    const normalizedHeight = Math.max(200, Math.min(8192, Math.floor(height)));
    const currentId = idRef.current;
    idRef.current = null;
    setSessionId(null);
    if (currentId) await ipc.closeRdp(currentId).catch(() => {});
    await connect({ ...activeConfig, width: normalizedWidth, height: normalizedHeight });
  };

  const reconnectToViewport = async () => {
    // Changing the negotiated desktop resolution requires a new RDP session.
    // This is only called by the explicit "Fit to current window" action; visual
    // window mode changes scale the existing framebuffer without reconnecting.
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    const stage = stageRef.current;
    if (!stage || !activeConfig) return;
    const rect = stage.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * scale);
    const height = Math.round(rect.height * scale);
    if (!size || Math.abs(size.w - width) > 2 || Math.abs(size.h - height) > 2) {
      await reconnectAtResolution(width, height);
    }
  };

  const disconnect = async () => {
    if (viewMode === "fullscreen") {
      await ipc.setRdpFullscreen(false).catch(() => {});
    }
    changeViewMode("embedded");
    if (sessionId) await ipc.closeRdp(sessionId).catch(() => {});
    setSessionId(null);
    setSize(null);
    setError(null);
  };

  // ---- input ----

  const send = (input: RdpInput) => {
    const id = idRef.current;
    if (id) ipc.rdpInput(id, input).catch(() => {});
  };

  const toDesktop = (e: React.MouseEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;

    // `object-fit: contain` may add bars around the remote framebuffer. Map
    // input against the rendered image rather than the canvas element box so
    // clicks remain exact at every aspect ratio and DPI.
    const scale = Math.min(r.width / size.w, r.height / size.h);
    const renderedWidth = size.w * scale;
    const renderedHeight = size.h * scale;
    const left = r.left + (r.width - renderedWidth) / 2;
    const top = r.top + (r.height - renderedHeight) / 2;
    if (
      e.clientX < left || e.clientX > left + renderedWidth
      || e.clientY < top || e.clientY > top + renderedHeight
    ) return null;
    const x = Math.round(((e.clientX - left) / renderedWidth) * size.w);
    const y = Math.round(((e.clientY - top) / renderedHeight) * size.h);
    return {
      x: Math.max(0, Math.min(size.w - 1, x)),
      y: Math.max(0, Math.min(size.h - 1, y)),
    };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const p = toDesktop(e);
    if (p) send({ kind: "mouse_move", x: p.x, y: p.y });
  };

  const onMouseButton = (e: React.MouseEvent, pressed: boolean) => {
    const p = toDesktop(e);
    if (p) send({ kind: "mouse_move", x: p.x, y: p.y });
    send({ kind: "mouse_button", button: e.button, pressed });
  };

  const onWheel = (e: React.WheelEvent) => {
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const raw = horizontal ? e.deltaX : e.deltaY;
    if (raw === 0) return;
    send({ kind: "wheel", delta: raw > 0 ? -120 : 120, horizontal });
  };

  const onKey = (e: React.KeyboardEvent, pressed: boolean) => {
    const sc = SCANCODES[e.code];
    if (sc !== undefined) {
      e.preventDefault();
      send({ kind: "key", scancode: sc, pressed });
    } else if (pressed && e.key.length === 1) {
      // Fallback for keys without a scancode mapping.
      send({ kind: "unicode", ch: e.key, pressed: true });
      send({ kind: "unicode", ch: e.key, pressed: false });
    }
  };

  if (!sessionId || connecting) {
    return (
      <RdpConnectForm
        busy={connecting}
        error={error}
        initialConfig={initialConfig}
        onConnect={connect}
      />
    );
  }

  return (
    <div
      className={`rdp rdp--${viewMode} ${controlsVisible ? "rdp--controls-visible" : ""}`}
      onMouseMove={revealControls}
    >
      {viewMode === "fullscreen" && <div className="rdp__reveal-strip" aria-hidden="true" />}
      <header className="rdp__toolbar">
        <div className="rdp__session-meta">
          <span className="rdp__session-icon" aria-hidden="true"><DesktopIcon /></span>
          <span className="rdp__session-copy">
            <strong>{activeConfig?.host}</strong>
            <span><i aria-hidden="true" />{t("rdp.connected")} · {size ? `${size.w} × ${size.h}` : "RDP"}</span>
          </span>
        </div>
        <div className="rdp__toolbar-actions">
          <label className="rdp__resolution">
            <span>{t("rdp.resolution")}</span>
            <select
              value={size ? `${size.w}x${size.h}` : ""}
              onChange={(event) => {
                if (event.target.value === "fit") {
                  void reconnectToViewport();
                  return;
                }
                const [width, height] = event.target.value.split("x").map(Number);
                if (width && height) void reconnectAtResolution(width, height);
              }}
              aria-label={t("rdp.resolution")}
            >
              {size && ![
                "1280x720",
                "1366x768",
                "1600x900",
                "1920x1080",
                "2560x1440",
              ].includes(`${size.w}x${size.h}`) && (
                <option value={`${size.w}x${size.h}`}>{size.w} × {size.h}</option>
              )}
              <option value="fit">{t("rdp.fit_to_window")}</option>
              <option value="1280x720">1280 × 720</option>
              <option value="1366x768">1366 × 768</option>
              <option value="1600x900">1600 × 900</option>
              <option value="1920x1080">1920 × 1080</option>
              <option value="2560x1440">2560 × 1440</option>
            </select>
          </label>
          {activeConfig?.clipboard_enabled && (
            <span className={`rdp__permission rdp__permission--${clipboardStatus}`}>
              <ClipboardIcon />
              <span>{clipboardStatus === "blocked" ? t("rdp.clipboard_blocked") : t("rdp.clipboard_on")}</span>
            </span>
          )}
          <span className="rdp__toolbar-divider" aria-hidden="true" />
          <button
            className={`rdp__toolbar-button ${viewMode === "focus" ? "rdp__toolbar-button--active" : ""}`}
            type="button"
            onClick={toggleFocusMode}
            aria-pressed={viewMode === "focus"}
            title={viewMode === "focus" ? t("rdp.exit_focus_mode") : t("rdp.focus_mode")}
          >
            <FocusIcon active={viewMode === "focus"} />
            <span>{viewMode === "focus" ? t("rdp.exit_focus_mode") : t("rdp.focus_mode")}</span>
          </button>
          <button
            className={`rdp__toolbar-button ${viewMode === "fullscreen" ? "rdp__toolbar-button--primary" : ""}`}
            type="button"
            onClick={toggleFullscreen}
            aria-pressed={viewMode === "fullscreen"}
            title={viewMode === "fullscreen" ? t("rdp.exit_fullscreen") : t("rdp.fullscreen")}
          >
            <FullscreenIcon active={viewMode === "fullscreen"} />
            <span>{viewMode === "fullscreen" ? t("rdp.exit_fullscreen") : t("rdp.fullscreen")}</span>
          </button>
          <button
            className="rdp__toolbar-button rdp__toolbar-button--danger"
            type="button"
            onClick={disconnect}
            title={t("rdp.disconnect")}
          >
            <DisconnectIcon />
            <span>{t("rdp.disconnect")}</span>
          </button>
        </div>
      </header>
      {error && (
        <div className="rdp__banner">
          <span className="rdp__banner-text">
            <strong>{error.title}</strong>
            <span>{error.message}</span>
          </span>
          <button
            className="rdp__reconnect"
            onClick={disconnect}
          >
            {t("common.reconnect")}
          </button>
        </div>
      )}
      <div ref={stageRef} className="rdp__stage">
        <canvas
          ref={canvasRef}
          className="rdp__canvas"
          width={size?.w ?? initialConfig?.width ?? 1280}
          height={size?.h ?? initialConfig?.height ?? 800}
          tabIndex={0}
          onMouseMove={onMouseMove}
          onMouseDown={(e) => {
            e.currentTarget.focus();
            onMouseButton(e, true);
          }}
          onMouseUp={(e) => onMouseButton(e, false)}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={onWheel}
          onKeyDown={(e) => onKey(e, true)}
          onKeyUp={(e) => onKey(e, false)}
        />
        {viewMode === "fullscreen" && controlsVisible && (
          <span className="rdp__fullscreen-hint">{t("rdp.fullscreen_hint")}</span>
        )}
      </div>
    </div>
  );
}

function RdpConnectForm({
  busy,
  error,
  initialConfig,
  onConnect,
}: {
  busy: boolean;
  error: RdpUiError | null;
  initialConfig?: RdpConfig;
  onConnect: (config: RdpConfig) => void;
}) {
  const { t } = useTranslation();
  const [host, setHost] = useState(initialConfig?.host ?? "");
  const [port, setPort] = useState(initialConfig?.port ?? 3389);
  const [username, setUsername] = useState(usableUsername(initialConfig?.username));
  const [password, setPassword] = useState(initialConfig?.password ?? "");
  const [domain, setDomain] = useState(initialConfig?.domain ?? "");
  const [resolution, setResolution] = useState(
    `${initialConfig?.width ?? 1280}x${initialConfig?.height ?? 800}`,
  );
  const [clipboardEnabled, setClipboardEnabled] = useState(initialConfig?.clipboard_enabled ?? false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const [w, h] = resolution.split("x").map(Number);
    onConnect({
      host,
      port,
      username,
      password,
      domain: domain || null,
      width: w || 1280,
      height: h || 800,
      clipboard_enabled: clipboardEnabled,
    });
  };

  if (busy) {
    return <div className="rdp__connecting">{t("form.connecting_to", { host })}</div>;
  }

  return (
    <div className="rdp-connect">
      <form className="rdp-connect__card" onSubmit={submit}>
        <header className="rdp-connect__header">
          <span className="rdp-connect__mark"><DesktopIcon /></span>
          <span>
            <span className="rdp-connect__eyebrow">{t("rdp.remote_desktop")}</span>
            <h2 className="rdp-connect__title">{t("rdp.connect_title")}</h2>
          </span>
        </header>

        <div className="rdp-connect__divider" />

        <div className="rdp-connect__row">
          <label className="rdp-connect__field rdp-connect__field--grow">
            <span>{t("form.host")}</span>
            <input
              className="rdp-connect__input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={t("form.ph_ip")}
              required
              autoFocus
            />
          </label>
          <label className="rdp-connect__field rdp-connect__field--port">
            <span>{t("form.port")}</span>
            <input
              className="rdp-connect__input"
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              min={1}
              max={65535}
            />
          </label>
        </div>

        <label className="rdp-connect__field">
          <span>{t("form.username")}</span>
          <input
            className="rdp-connect__input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("form.ph_admin")}
            required
          />
          <small className="rdp-connect__hint">{t("form.rdp_username_hint")}</small>
        </label>

        <label className="rdp-connect__field">
          <span>{t("form.password")}</span>
          <input
            className="rdp-connect__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <div className="rdp-connect__row">
          <label className="rdp-connect__field rdp-connect__field--grow">
            <span>{t("form.domain_optional")}</span>
            <input
              className="rdp-connect__input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder={t("form.ph_domain")}
            />
            <small className="rdp-connect__hint">{t("form.rdp_domain_hint")}</small>
          </label>
          <label className="rdp-connect__field">
            <span>{t("form.resolution")}</span>
            <select
              className="rdp-connect__input"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            >
              <option>1280x800</option>
              <option>1366x768</option>
              <option>1600x900</option>
              <option>1920x1080</option>
              <option>1024x768</option>
            </select>
          </label>
        </div>

        <section className="rdp-connect__resources">
          <div className="rdp-connect__section-heading">
            <span>{t("rdp.local_resources")}</span>
            <small>{t("rdp.permissions_apply_once")}</small>
          </div>
          <label className={`rdp-connect__resource ${clipboardEnabled ? "rdp-connect__resource--active" : ""}`}>
            <span className="rdp-connect__resource-icon"><ClipboardIcon /></span>
            <span className="rdp-connect__resource-copy">
              <strong>{t("rdp.clipboard")}</strong>
              <small>{t("rdp.clipboard_description")}</small>
            </span>
            <input
              className="rdp-connect__toggle-input"
              type="checkbox"
              checked={clipboardEnabled}
              onChange={(e) => setClipboardEnabled(e.target.checked)}
            />
            <span className="rdp-connect__toggle" aria-hidden="true" />
          </label>
        </section>

        {error && (
          <div className="rdp-connect__error" role="alert">
            <span className="rdp-connect__error-icon" aria-hidden="true">!</span>
            <span className="rdp-connect__error-text">
              <strong>{error.title}</strong>
              <span>{error.message}</span>
            </span>
          </div>
        )}

        <button className="rdp-connect__submit" type="submit">
          {t("common.connect")}
        </button>
      </form>
    </div>
  );
}

function DesktopIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>;
}

function ClipboardIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2M9 10h6M9 14h6"/></svg>;
}

function FullscreenIcon({ active }: { active: boolean }) {
  return active
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>;
}

function FocusIcon({ active }: { active: boolean }) {
  return active
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9H4V4M15 9h5V4M9 15H4v5M15 15h5v5"/></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>;
}

function DisconnectIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.6 6.6a8 8 0 1 0 10.8 0"/></svg>;
}
