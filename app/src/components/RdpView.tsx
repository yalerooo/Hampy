// An RDP tab: a connection form, then a <canvas> rendering the remote desktop.
// Framebuffer regions arrive on the rdp-event channel (base64 RGBA) and are
// blitted with putImageData; keyboard/mouse are captured on the canvas and sent
// back as RdpInput. The canvas uses the native desktop resolution and is scaled
// to fit with CSS, so pointer coordinates are mapped back to desktop space.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc, onRdpEvent } from "../lib/ipc";
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

export function RdpView({ initialConfig }: { initialConfig?: RdpConfig }) {
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<RdpUiError | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const idRef = useRef<string | null>(null);
  const didAuto = useRef(false);

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
    };
  }, []);

  const connect = async (config: RdpConfig) => {
    setError(null);
    setConnecting(true);
    try {
      const opened = await ipc.openRdp(config);
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
    const x = Math.round(((e.clientX - r.left) / r.width) * size.w);
    const y = Math.round(((e.clientY - r.top) / r.height) * size.h);
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
    <div className="rdp">
      {error && (
        <div className="rdp__banner">
          <span className="rdp__banner-text">
            <strong>{error.title}</strong>
            <span>{error.message}</span>
          </span>
          <button
            className="rdp__reconnect"
            onClick={() => {
              setError(null);
              setSessionId(null);
              setConnecting(false);
            }}
          >
            {t("common.reconnect")}
          </button>
        </div>
      )}
      <div className="rdp__stage">
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
    });
  };

  if (busy) {
    return <div className="rdp__connecting">{t("form.connecting_to", { host })}</div>;
  }

  return (
    <div className="rdp-connect">
      <form className="rdp-connect__card" onSubmit={submit}>
        <h2 className="rdp-connect__title">RDP</h2>

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
