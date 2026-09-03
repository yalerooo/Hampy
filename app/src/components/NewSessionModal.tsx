import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import dockerLogo from "../assets/icons/docker.svg?raw";
import ftpLogo from "../assets/icons/ftp.svg?raw";
import kubernetesLogo from "../assets/icons/kubernetes.svg?raw";
import rdpLogo from "../assets/icons/rdp.svg?raw";
import vncLogo from "../assets/icons/vnc.svg?raw";
import { ipc, isTauri } from "../lib/ipc";
import { injectSecrets, stashSecrets } from "../lib/secrets";
import type {
  DockerConfig,
  FtpConfig,
  KubernetesConfig,
  Protocol,
  RdpConfig,
  Session,
  SshConfig,
  VncConfig,
} from "../lib/types";
import { useAppStore } from "../store/appStore";
import "./NewSessionModal.css";

type AuthMethod = "password" | "key" | "agent";

interface ProtoMeta {
  id: Protocol | "local_shell";
  label: string;
  description: string;
  phase: number;
  /** Whether the interactive client is implemented yet. */
  implemented: boolean;
}

const PROTOCOL_DEFS: { id: ProtoMeta["id"]; label: string; phase: number; implemented: boolean }[] = [
  { id: "local_shell", label: "Terminal", phase: 1, implemented: true },
  { id: "ssh", label: "SSH", phase: 2, implemented: true },
  { id: "sftp", label: "SFTP", phase: 2, implemented: true },
  { id: "ftp", label: "FTP", phase: 3, implemented: true },
  { id: "serial", label: "Serial", phase: 3, implemented: true },
  { id: "rdp", label: "RDP", phase: 3, implemented: true },
  { id: "vnc", label: "VNC", phase: 3, implemented: true },
  { id: "docker", label: "Docker", phase: 4, implemented: true },
  { id: "kubernetes", label: "Kubernetes", phase: 4, implemented: true },
];

// Brand logos shipped as raw SVG; the wrapper just centers and lets CSS size them.
function Logo({ svg }: { svg: string }) {
  return (
    <span
      style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// Minimal inline SVG icons — one per protocol
function ProtoIcon({ id }: { id: string }) {
  const props = {
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    width: 28,
    height: 28,
  };
  switch (id) {
    case "local_shell":
      return (
        <svg {...props}>
          <rect x="2" y="4" width="16" height="12" rx="2" />
          <path d="M5 8l3 3-3 3M11 14h4" />
        </svg>
      );
    case "ssh":
      return (
        <svg {...props}>
          <rect x="4" y="9.5" width="12" height="8" rx="2" />
          <path d="M7 9.5V7a3 3 0 016 0v2.5" />
          <circle cx="10" cy="13.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "sftp":
      return (
        <svg {...props}>
          <path d="M3 5h5l2 2h7v9H3V5z" />
          <path d="M10 9v4M8 11.5l2 2 2-2" />
        </svg>
      );
    case "ftp":
      return <Logo svg={ftpLogo} />;
    case "rdp":
      return <Logo svg={rdpLogo} />;
    case "vnc":
      return <Logo svg={vncLogo} />;
    case "serial":
      return (
        <svg {...props}>
          <rect x="6" y="6" width="8" height="8" rx="1.5" />
          <path d="M9 6V4M11 6V4M9 14v2M11 14v2M6 9H4M6 11H4M14 9h2M14 11h2" />
        </svg>
      );
    case "docker":
      return <Logo svg={dockerLogo} />;
    case "kubernetes":
      return <Logo svg={kubernetesLogo} />;
    default:
      return (
        <svg {...props}>
          <circle cx="10" cy="10" r="7" />
          <path d="M10 6v4l2.5 2.5" />
        </svg>
      );
  }
}

type Step = "pick" | "configure";

export function NewSessionModal() {
  const { t } = useTranslation();
  const closeModal = useAppStore((s) => s.closeNewSessionModal);
  const open = useAppStore((s) => s.newSessionModalOpen);
  const editingSession = useAppStore((s) => s.editingSession);
  const closeEditSession = useAppStore((s) => s.closeEditSession);
  const openTab = useAppStore((s) => s.openTab);
  const bumpSessionVersion = useAppStore((s) => s.bumpSessionVersion);
  const isEditing = editingSession !== null;

  const PROTO_DESC_KEYS = {
    local_shell: "newSession.proto_terminal_desc",
    ssh: "newSession.proto_ssh_desc",
    sftp: "newSession.proto_sftp_desc",
    ftp: "newSession.proto_ftp_desc",
    serial: "newSession.proto_serial_desc",
    rdp: "newSession.proto_rdp_desc",
    vnc: "newSession.proto_vnc_desc",
    docker: "newSession.proto_docker_desc",
    kubernetes: "newSession.proto_k8s_desc",
  } as const;

  const PROTOCOLS: ProtoMeta[] = PROTOCOL_DEFS.map((p) => ({
    ...p,
    description: t(
      (PROTO_DESC_KEYS as Record<string, (typeof PROTO_DESC_KEYS)[keyof typeof PROTO_DESC_KEYS]>)[p.id]
        ?? "newSession.proto_terminal_desc",
    ),
  }));

  const [step, setStep] = useState<Step>("pick");
  const [proto, setProto] = useState<ProtoMeta | null>(null);

  // Form fields
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [domain, setDomain] = useState("");
  const [rdpClipboard, setRdpClipboard] = useState(false);
  // Docker / Kubernetes fields
  const [container, setContainer] = useState("");
  const [dockerHost, setDockerHost] = useState("");
  const [pod, setPod] = useState("");
  const [namespace, setNamespace] = useState("");
  const [k8sContainer, setK8sContainer] = useState("");
  const [k8sContext, setK8sContext] = useState("");
  const [shellProg, setShellProg] = useState("sh");
  // Connect picker (browse containers/pods)
  const [browseList, setBrowseList] = useState<{ name: string; sub: string }[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus name field when step changes to configure
  useEffect(() => {
    if (step === "configure") {
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [step]);

  const reset = () => {
    setStep("pick");
    setProto(null);
    setName("");
    setHost("");
    setPort("22");
    setUsername("");
    setAuthMethod("password");
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
    setDomain("");
    setRdpClipboard(false);
    setContainer("");
    setDockerHost("");
    setPod("");
    setNamespace("");
    setK8sContainer("");
    setK8sContext("");
    setShellProg("sh");
    setBrowseList(null);
    setBrowsing(false);
    setBrowseError("");
    setError("");
    setSaving(false);
  };

  const close = () => {
    reset();
    closeModal();
    closeEditSession();
  };

  // Pre-fill step/proto synchronously to avoid flashing the protocol picker.
  useLayoutEffect(() => {
    if (!editingSession) return;
    const protoMeta = PROTOCOLS.find((p) => p.id === editingSession.protocol);
    if (protoMeta) {
      setProto(protoMeta);
      setStep("configure");
    }
    setName(editingSession.name);
  }, [editingSession]);

  // Asynchronously inject secrets from keychain and populate all form fields.
  useEffect(() => {
    if (!editingSession) return;
    (async () => {
      let s = editingSession;
      if (isTauri) {
        try { s = await injectSecrets(editingSession); } catch { /* ignore */ }
      }
      const opts = s.options as {
        sshConfig?: SshConfig;
        rdpConfig?: RdpConfig;
        vncConfig?: VncConfig;
        ftpConfig?: FtpConfig;
        dockerConfig?: DockerConfig;
        kubernetesConfig?: KubernetesConfig;
      };
      if (opts.sshConfig) {
        const cfg = opts.sshConfig;
        setHost(cfg.host ?? "");
        setPort(String(cfg.port ?? 22));
        const auth = cfg.auth;
        setUsername(auth.username ?? "");
        if (auth.method === "password") {
          setAuthMethod("password");
          setPassword((auth as { password?: string }).password ?? "");
        } else if (auth.method === "key") {
          setAuthMethod("key");
          setPrivateKey((auth as { private_key?: string }).private_key ?? "");
          setPassphrase((auth as { passphrase?: string }).passphrase ?? "");
        } else {
          setAuthMethod("agent");
        }
      } else if (opts.rdpConfig) {
        const cfg = opts.rdpConfig;
        setHost(cfg.host ?? "");
        setPort(String(cfg.port ?? 3389));
        setUsername(cfg.username ?? "");
        setPassword(cfg.password ?? "");
        setDomain(cfg.domain ?? "");
        setRdpClipboard(cfg.clipboard_enabled ?? false);
      } else if (opts.vncConfig) {
        const cfg = opts.vncConfig;
        setHost(cfg.host ?? "");
        setPort(String(cfg.port ?? 5900));
        setPassword(cfg.password ?? "");
      } else if (opts.ftpConfig) {
        const cfg = opts.ftpConfig;
        setHost(cfg.host ?? "");
        setPort(String(cfg.port ?? 21));
        setUsername(cfg.username ?? "");
        setPassword(cfg.password ?? "");
      } else if (opts.dockerConfig) {
        const cfg = opts.dockerConfig;
        setContainer(cfg.container ?? "");
        setShellProg(cfg.shell ?? "sh");
        setDockerHost((cfg.host as string | null) ?? "");
      } else if (opts.kubernetesConfig) {
        const cfg = opts.kubernetesConfig;
        setPod(cfg.pod ?? "");
        setNamespace(cfg.namespace ?? "");
        setK8sContainer(cfg.container ?? "");
        setK8sContext(cfg.context ?? "");
        setShellProg(cfg.shell ?? "sh");
      }
    })();
  }, [editingSession]);

  if (!open && !isEditing) return null;

  const pickProtocol = (p: ProtoMeta) => {
    if (p.id === "local_shell") {
      openTab({ title: "Terminal", kind: "terminal", shell: "default" });
      close();
      return;
    }
    setProto(p);
    setPort(p.id === "rdp" ? "3389" : p.id === "vnc" ? "5900" : "22");
    setStep("configure");
  };

  const buildSshConfig = (): SshConfig => {
    const auth: SshConfig["auth"] =
      authMethod === "password"
        ? { method: "password", username, password }
        : authMethod === "key"
          ? { method: "key", username, private_key: privateKey, passphrase: passphrase || null }
          : { method: "agent", username };
    return { host, port: parseInt(port) || 22, auth, host_key_policy: "accept_new" };
  };

  const buildRdpConfig = (): RdpConfig => ({
    host,
    port: parseInt(port) || 3389,
    username,
    password,
    domain: domain || null,
    width: 1280,
    height: 800,
    clipboard_enabled: rdpClipboard,
  });

  const buildVncConfig = (): VncConfig => ({
    host,
    port: parseInt(port) || 5900,
    password,
  });

  const buildFtpConfig = (): FtpConfig => ({
    host,
    port: parseInt(port) || 21,
    username: username || "anonymous",
    password,
  });

  const buildDockerConfig = (): DockerConfig => ({
    container: container.trim(),
    shell: shellProg.trim() || "sh",
    host: dockerHost.trim() || null,
  });

  const buildK8sConfig = (): KubernetesConfig => ({
    pod: pod.trim(),
    namespace: namespace.trim() || null,
    container: k8sContainer.trim() || null,
    context: k8sContext.trim() || null,
    shell: shellProg.trim() || "sh",
  });

  const browseContainers = async () => {
    setBrowsing(true);
    setBrowseError("");
    setBrowseList(null);
    try {
      const items = await ipc.listDockerContainers(dockerHost.trim() || null);
      setBrowseList(
        items.map((c) => ({ name: c.name, sub: [c.image, c.status].filter(Boolean).join(" · ") })),
      );
    } catch (e) {
      setBrowseError(String(e));
    } finally {
      setBrowsing(false);
    }
  };

  const browsePods = async () => {
    setBrowsing(true);
    setBrowseError("");
    setBrowseList(null);
    try {
      const items = await ipc.listKubernetesPods(k8sContext.trim() || null, namespace.trim() || null);
      setBrowseList(items.map((p) => ({ name: p.name, sub: p.status })));
    } catch (e) {
      setBrowseError(String(e));
    } finally {
      setBrowsing(false);
    }
  };

  const renderBrowse = (onPick: (name: string) => void) => (
    <>
      {browseError && <p className="nsm-error">{browseError}</p>}
      {browseList &&
        (browseList.length === 0 ? (
          <p className="nsm-note">{t("newSession.nothing_running")}</p>
        ) : (
          <div className="nsm-picker">
            {browseList.map((it) => (
              <button
                type="button"
                key={it.name}
                className="nsm-picker-item"
                onClick={() => onPick(it.name)}
              >
                <span className="nsm-picker-name">{it.name}</span>
                {it.sub && <span className="nsm-picker-sub">{it.sub}</span>}
              </button>
            ))}
          </div>
        ))}
    </>
  );

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t("newSession.error_name_required"));
      return;
    }
    const isSsh = proto?.id === "ssh" || proto?.id === "sftp";
    const isRdp = proto?.id === "rdp";
    const isVnc = proto?.id === "vnc";
    const isFtp = proto?.id === "ftp";
    const isDocker = proto?.id === "docker";
    const isK8s = proto?.id === "kubernetes";
    const needsHost = isSsh || isRdp || isVnc || isFtp;
    if (needsHost && !host.trim()) {
      setError(t("newSession.error_host_required"));
      return;
    }
    if (isDocker && !container.trim()) {
      setError(t("newSession.error_container_required"));
      return;
    }
    if (isK8s && !pod.trim()) {
      setError(t("newSession.error_pod_required"));
      return;
    }

    setSaving(true);
    setError("");

    try {
      const sshCfg = isSsh ? buildSshConfig() : undefined;
      const rdpCfg = isRdp ? buildRdpConfig() : undefined;
      const vncCfg = isVnc ? buildVncConfig() : undefined;
      const ftpCfg = isFtp ? buildFtpConfig() : undefined;
      const dockerCfg = isDocker ? buildDockerConfig() : undefined;
      const k8sCfg = isK8s ? buildK8sConfig() : undefined;
      const options = sshCfg
        ? { sshConfig: sshCfg }
        : rdpCfg
          ? { rdpConfig: rdpCfg }
          : vncCfg
            ? { vncConfig: vncCfg }
            : ftpCfg
              ? { ftpConfig: ftpCfg }
              : dockerCfg
                ? { dockerConfig: dockerCfg }
                : k8sCfg
                  ? { kubernetesConfig: k8sCfg }
                  : {};

      const session: Session = isEditing
        ? {
            ...editingSession!,
            name: name.trim(),
            options,
          }
        : {
            id: crypto.randomUUID(),
            name: name.trim(),
            protocol: proto!.id as Protocol,
            folder_id: null,
            tags: [],
            favorite: false,
            options,
            created_at: new Date().toISOString(),
            last_used_at: null,
          };

      if (isTauri) {
        let toPersist = session;
        try {
          const cfg = await ipc.getConfig();
          if (cfg.security.use_os_keychain) {
            toPersist = await stashSecrets(session);
          }
        } catch {
          // Config unreadable — fall back to persisting as-is.
        }
        await ipc.saveSession(toPersist);
      }

      bumpSessionVersion();

      // Only open a tab for new sessions, not edits.
      if (!isEditing && proto!.implemented) {
        openTab({
          title: name.trim(),
          kind: "session",
          protocol: proto!.id as Protocol,
          sshConfig: sshCfg,
          rdpConfig: rdpCfg,
          vncConfig: vncCfg,
          ftpConfig: ftpCfg,
          dockerConfig: dockerCfg,
          kubernetesConfig: k8sCfg,
        });
      }

      close();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const isSoon = proto ? !proto.implemented : false;
  const isSsh = proto?.id === "ssh" || proto?.id === "sftp";
  const isRdp = proto?.id === "rdp";
  const isVnc = proto?.id === "vnc";
  const isFtp = proto?.id === "ftp";
  const isDocker = proto?.id === "docker";
  const isK8s = proto?.id === "kubernetes";
  const needsHost = isSsh || isRdp || isVnc || isFtp;
  const needsPassword = isRdp || isVnc || isFtp;

  return (
    <div className="nsm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="nsm-card" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="nsm-header">
          {step === "configure" && !isEditing && (
            <button
              className="nsm-header-back"
              onClick={() => { setStep("pick"); setError(""); }}
              aria-label={t("newSession.back")}
            >
              ←
            </button>
          )}
          {step === "configure" && proto && (
            <span className={`nsm-header-icon nsm-proto--${proto.id}`}>
              <ProtoIcon id={proto.id} />
            </span>
          )}
          <div className="nsm-header-text">
            <span className="nsm-title">
              {isEditing
                ? t("newSession.edit_title")
                : step === "pick"
                  ? t("newSession.title")
                  : proto?.label ?? ""}
            </span>
            <span className="nsm-subtitle">
              {step === "pick" && !isEditing
                ? t("newSession.choose_protocol")
                : proto?.description ?? ""}
            </span>
          </div>
          <button className="nsm-close" onClick={close} aria-label={t("common.close")}>✕</button>
        </div>

        {/* Step 1: protocol picker */}
        {step === "pick" && (
          <div className="nsm-grid">
            {PROTOCOLS.map((p) => (
              <button
                key={p.id}
                className={`nsm-proto nsm-proto--${p.id}${p.implemented ? "" : " nsm-proto--soon"}`}
                onClick={() => pickProtocol(p)}
              >
                <span className="nsm-proto-icon">
                  <ProtoIcon id={p.id} />
                </span>
                <span className="nsm-proto-label">{p.label}</span>
                <span className="nsm-proto-desc">{p.description}</span>
                {!p.implemented && (
                  <span className="nsm-proto-badge">{t("newSession.phase", { n: p.phase })}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Step 2: configure */}
        {step === "configure" && proto && (
          <div className="nsm-form">
            {isSoon ? (
              <div className="nsm-soon-msg">
                <ProtoIcon id={proto.id} />
                <p>
                  <strong>{proto.label}</strong>{" "}
                  {t("newSession.coming_soon", { phase: proto.phase })}
                </p>
              </div>
            ) : null}

            <div className="nsm-field">
              <label htmlFor="nsm-name">{t("newSession.session_name")}</label>
              <input
                id="nsm-name"
                ref={nameRef}
                className="nsm-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("newSession.ph_session_name", { protocol: proto.label })}
                onKeyDown={(e) => e.key === "Enter" && handleSave()}
              />
            </div>

            {needsHost && (
              <>
                <div className="nsm-row">
                  <div className="nsm-field">
                    <label htmlFor="nsm-host">{t("form.host")}</label>
                    <input
                      id="nsm-host"
                      className="nsm-input"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder={t("form.ph_host")}
                    />
                  </div>
                  <div className="nsm-field">
                    <label htmlFor="nsm-port">{t("form.port")}</label>
                    <input
                      id="nsm-port"
                      className="nsm-input"
                      type="number"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      min={1}
                      max={65535}
                    />
                  </div>
                </div>

                {!isVnc && (
                  <div className="nsm-field">
                    <label htmlFor="nsm-user">{t("form.username")}</label>
                    <input
                      id="nsm-user"
                      className="nsm-input"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder={isFtp ? "anonymous" : t("form.ph_root")}
                    />
                  </div>
                )}

                {isSsh && (
                  <>
                <div className="nsm-auth-tabs">
                  {(["password", "key", "agent"] as AuthMethod[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`nsm-auth-tab${authMethod === m ? " is-active" : ""}`}
                      onClick={() => setAuthMethod(m)}
                    >
                      {m === "password" ? t("form.auth_password") : m === "key" ? t("form.auth_key") : t("form.auth_agent")}
                    </button>
                  ))}
                </div>

                {authMethod === "password" && (
                  <div className="nsm-field">
                    <label htmlFor="nsm-pass">{t("form.password")}</label>
                    <input
                      id="nsm-pass"
                      className="nsm-input"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t("form.ph_leave_empty")}
                    />
                  </div>
                )}

                {authMethod === "key" && (
                  <>
                    <div className="nsm-field">
                      <label htmlFor="nsm-key">{t("form.private_key")}</label>
                      <textarea
                        id="nsm-key"
                        className="nsm-input nsm-textarea"
                        value={privateKey}
                        onChange={(e) => setPrivateKey(e.target.value)}
                        placeholder={t("form.ph_private_key")}
                        rows={4}
                      />
                    </div>
                    <div className="nsm-field">
                      <label htmlFor="nsm-phrase">{t("form.passphrase_optional")}</label>
                      <input
                        id="nsm-phrase"
                        className="nsm-input"
                        type="password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                      />
                    </div>
                  </>
                )}

                {authMethod === "agent" && (
                  <p className="nsm-note">
                    <Trans i18nKey="newSession.agent_note" components={{ code: <code /> }} />
                  </p>
                )}
                  </>
                )}

                {needsPassword && (
                  <>
                    <div className="nsm-field">
                      <label htmlFor="nsm-rdp-pass">{t("form.password")}</label>
                      <input
                        id="nsm-rdp-pass"
                        className="nsm-input"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={isVnc ? t("form.ph_vnc_pass") : t("form.ph_leave_empty")}
                      />
                    </div>
                    {isRdp && (
                      <>
                        <div className="nsm-field">
                          <label htmlFor="nsm-domain">{t("form.domain_optional")}</label>
                          <input
                            id="nsm-domain"
                            className="nsm-input"
                            value={domain}
                            onChange={(e) => setDomain(e.target.value)}
                            placeholder={t("form.ph_domain")}
                          />
                        </div>
                        <label className="nsm-rdp-permission">
                          <input
                            type="checkbox"
                            checked={rdpClipboard}
                            onChange={(e) => setRdpClipboard(e.target.checked)}
                          />
                          <span>
                            <strong>{t("rdp.clipboard")}</strong>
                            <small>{t("rdp.clipboard_description")}</small>
                          </span>
                        </label>
                      </>
                    )}
                  </>
                )}
              </>
            )}

            {isDocker && (
              <>
                <div className="nsm-field">
                  <div className="nsm-field-head">
                    <label htmlFor="nsm-container">{t("newSession.container")}</label>
                    <button
                      type="button"
                      className="nsm-browse"
                      onClick={browseContainers}
                      disabled={browsing}
                    >
                      {browsing ? t("common.loading") : t("newSession.browse_running")}
                    </button>
                  </div>
                  <input
                    id="nsm-container"
                    className="nsm-input"
                    value={container}
                    onChange={(e) => setContainer(e.target.value)}
                    placeholder={t("newSession.ph_container")}
                    onKeyDown={(e) => e.key === "Enter" && handleSave()}
                  />
                  {renderBrowse(setContainer)}
                </div>
                <div className="nsm-row">
                  <div className="nsm-field">
                    <label htmlFor="nsm-shell">{t("newSession.shell")}</label>
                    <input
                      id="nsm-shell"
                      className="nsm-input"
                      value={shellProg}
                      onChange={(e) => setShellProg(e.target.value)}
                      placeholder={t("newSession.ph_shell")}
                    />
                  </div>
                  <div className="nsm-field">
                    <label htmlFor="nsm-dhost">{t("newSession.docker_host_optional")}</label>
                    <input
                      id="nsm-dhost"
                      className="nsm-input"
                      value={dockerHost}
                      onChange={(e) => setDockerHost(e.target.value)}
                      placeholder={t("newSession.ph_docker_host")}
                    />
                  </div>
                </div>
                <p className="nsm-note">
                  <Trans i18nKey="newSession.docker_note" components={{ code: <code /> }} />
                </p>
              </>
            )}

            {isK8s && (
              <>
                <div className="nsm-row">
                  <div className="nsm-field">
                    <div className="nsm-field-head">
                      <label htmlFor="nsm-pod">{t("newSession.pod")}</label>
                      <button
                        type="button"
                        className="nsm-browse"
                        onClick={browsePods}
                        disabled={browsing}
                      >
                        {browsing ? t("common.loading") : t("newSession.browse_pods")}
                      </button>
                    </div>
                    <input
                      id="nsm-pod"
                      className="nsm-input"
                      value={pod}
                      onChange={(e) => setPod(e.target.value)}
                      placeholder={t("newSession.ph_pod")}
                      onKeyDown={(e) => e.key === "Enter" && handleSave()}
                    />
                  </div>
                  <div className="nsm-field">
                    <label htmlFor="nsm-ns">{t("newSession.namespace_optional")}</label>
                    <input
                      id="nsm-ns"
                      className="nsm-input"
                      value={namespace}
                      onChange={(e) => setNamespace(e.target.value)}
                      placeholder={t("newSession.ph_namespace")}
                    />
                  </div>
                </div>
                {renderBrowse(setPod)}
                <div className="nsm-row">
                  <div className="nsm-field">
                    <label htmlFor="nsm-kcontainer">{t("newSession.container_optional")}</label>
                    <input
                      id="nsm-kcontainer"
                      className="nsm-input"
                      value={k8sContainer}
                      onChange={(e) => setK8sContainer(e.target.value)}
                      placeholder={t("newSession.ph_k8s_container")}
                    />
                  </div>
                  <div className="nsm-field">
                    <label htmlFor="nsm-kctx">{t("newSession.context_optional")}</label>
                    <input
                      id="nsm-kctx"
                      className="nsm-input"
                      value={k8sContext}
                      onChange={(e) => setK8sContext(e.target.value)}
                      placeholder={t("newSession.ph_k8s_context")}
                    />
                  </div>
                </div>
                <div className="nsm-field">
                  <label htmlFor="nsm-kshell">{t("newSession.shell")}</label>
                  <input
                    id="nsm-kshell"
                    className="nsm-input"
                    value={shellProg}
                    onChange={(e) => setShellProg(e.target.value)}
                    placeholder={t("newSession.ph_shell")}
                  />
                </div>
                <p className="nsm-note">
                  <Trans i18nKey="newSession.k8s_note" components={{ code: <code /> }} />
                </p>
              </>
            )}

            {error && <p className="nsm-error">{error}</p>}

            <div className="nsm-footer">
              <button className="nsm-btn-cancel" onClick={close}>
                {t("newSession.cancel")}
              </button>
              <button
                className="nsm-btn-save"
                onClick={handleSave}
                disabled={saving}
              >
                {saving
                  ? t("newSession.saving")
                  : isEditing
                    ? t("newSession.save_changes")
                    : needsHost || isDocker || isK8s
                      ? t("newSession.save_connect")
                      : t("newSession.save_session")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
