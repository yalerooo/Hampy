// Native, versioned Hampy session exchange format. Files intentionally omit
// credentials: secrets remain in the originating machine's OS keychain.

import type { FolderRecord, Protocol, Session } from "./types";

const FORMAT = "hampy-sessions";
const VERSION = 1;

const PROTOCOLS = new Set<Protocol>([
  "local_shell",
  "ssh",
  "sftp",
  "ftp",
  "rdp",
  "vnc",
  "serial",
  "mosh",
  "docker",
  "kubernetes",
]);

export interface HampySessionFile {
  format: typeof FORMAT;
  version: typeof VERSION;
  exported_at: string;
  folders: FolderRecord[];
  sessions: Session[];
}

export interface ImportedHampyData {
  folders: FolderRecord[];
  sessions: Session[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function withoutSecrets(session: Session): Session {
  const copy = JSON.parse(JSON.stringify(session)) as Session;
  const options = copy.options as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const blank = (target: any, key: string) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (target && typeof target === "object" && key in target) target[key] = "";
  };

  blank(options.sshConfig?.auth, "password");
  blank(options.sshConfig?.auth, "passphrase");
  blank(options.sshConfig?.auth, "private_key");
  blank(options.rdpConfig, "password");
  blank(options.vncConfig, "password");
  blank(options.ftpConfig, "password");
  return copy;
}

export function serializeHampySessions(
  sessions: Session[],
  folders: FolderRecord[],
): string {
  const file: HampySessionFile = {
    format: FORMAT,
    version: VERSION,
    exported_at: new Date().toISOString(),
    folders: folders.map((folder) => ({ ...folder })),
    sessions: sessions.map(withoutSecrets),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function parseFolder(value: unknown, index: number): FolderRecord {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) {
    throw new Error(`Invalid folder at index ${index}`);
  }
  if (value.color !== null && value.color !== undefined && typeof value.color !== "string") {
    throw new Error(`Invalid color for folder "${value.name}"`);
  }
  if (
    value.parent_id !== null &&
    value.parent_id !== undefined &&
    typeof value.parent_id !== "string"
  ) {
    throw new Error(`Invalid parent for folder "${value.name}"`);
  }
  return {
    name: value.name.trim(),
    color: typeof value.color === "string" ? value.color : null,
    parent_id: typeof value.parent_id === "string" ? value.parent_id : null,
  };
}

function parseSession(value: unknown, index: number): Session {
  if (!isRecord(value)) throw new Error(`Invalid session at index ${index}`);
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error(`Session ${index + 1} has no name`);
  }
  if (typeof value.protocol !== "string" || !PROTOCOLS.has(value.protocol as Protocol)) {
    throw new Error(`Unsupported protocol in session "${value.name}"`);
  }
  if (!isRecord(value.options)) {
    throw new Error(`Invalid options in session "${value.name}"`);
  }

  const createdAt =
    typeof value.created_at === "string" && !Number.isNaN(Date.parse(value.created_at))
      ? value.created_at
      : new Date().toISOString();
  const tags = Array.isArray(value.tags)
    ? value.tags.flatMap((tag) => {
        if (!isRecord(tag) || typeof tag.name !== "string") return [];
        return [{
          name: tag.name,
          color: typeof tag.color === "string" ? tag.color : null,
        }];
      })
    : [];

  return withoutSecrets({
    ...(value as unknown as Session),
    id: crypto.randomUUID(),
    name: value.name.trim(),
    protocol: value.protocol as Protocol,
    folder_id: typeof value.folder_id === "string" ? value.folder_id : null,
    tags,
    favorite: value.favorite === true,
    options: value.options,
    created_at: createdAt,
    last_used_at:
      typeof value.last_used_at === "string" && !Number.isNaN(Date.parse(value.last_used_at))
        ? value.last_used_at
        : null,
  });
}

export function parseHampySessions(text: string): ImportedHampyData {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Invalid .hampy file: malformed JSON");
  }
  if (!isRecord(value) || value.format !== FORMAT) {
    throw new Error("Invalid .hampy file: unrecognized format");
  }
  if (value.version !== VERSION) {
    throw new Error(`Unsupported .hampy version: ${String(value.version)}`);
  }
  if (!Array.isArray(value.sessions) || !Array.isArray(value.folders)) {
    throw new Error("Invalid .hampy file: sessions or folders are missing");
  }

  const folders = value.folders.map(parseFolder);
  const folderNames = new Set(folders.map((folder) => folder.name));
  if (folderNames.size !== folders.length) {
    throw new Error("Invalid .hampy file: duplicate folder names");
  }
  const parents = new Map(folders.map((folder) => [folder.name, folder.parent_id]));
  for (const folder of folders) {
    if (folder.parent_id && !folderNames.has(folder.parent_id)) {
      throw new Error(`Folder "${folder.name}" references a missing parent`);
    }
    const visited = new Set<string>();
    let current: string | null = folder.name;
    while (current) {
      if (visited.has(current)) {
        throw new Error(`Folder cycle detected at "${folder.name}"`);
      }
      visited.add(current);
      current = parents.get(current) ?? null;
    }
  }

  return {
    folders,
    sessions: value.sessions.map(parseSession),
  };
}
