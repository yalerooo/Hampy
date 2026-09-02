// Shared session import/export flows, used by both the Settings dialog and the
// sidebar. Each prompts for a file, then reads/parses or serializes/writes using
// either MobaXterm or Hampy's native versioned format. Returns the affected
// count, or null if the user cancelled the file dialog.

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ipc } from "./ipc";
import { parseHampySessions, serializeHampySessions } from "./hampyFormat";
import { parseMxtSessionFile } from "./mobaxterm";

/** Prompt for a session file and import its sessions. Returns how many were added. */
export async function importSessions(): Promise<number | null> {
  const path = await openDialog({
    multiple: false,
    filters: [
      { name: "Hampy and MobaXterm sessions", extensions: ["hampy", "mxtsessions"] },
      { name: "Hampy sessions", extensions: ["hampy"] },
      { name: "MobaXterm sessions", extensions: ["mxtsessions", "ini", "txt"] },
    ],
  });
  if (!path || Array.isArray(path)) return null;
  const text = await ipc.readTextFile(path);
  const parsed = path.toLowerCase().endsWith(".hampy") || text.trimStart().startsWith("{")
    ? parseHampySessions(text)
    : parseMxtSessionFile(text);
  for (const folder of parsed.folders) await ipc.saveFolder(folder);
  for (const session of parsed.sessions) await ipc.saveSession(session);
  return parsed.sessions.length;
}

/** Prompt for a destination and export all sessions. Returns how many were written. */
export async function exportSessions(): Promise<number | null> {
  const sessions = await ipc.listSessions();
  const folders = await ipc.listFolders();
  const text = serializeHampySessions(sessions, folders);
  const path = await saveDialog({
    defaultPath: "hampy-sessions.hampy",
    filters: [{ name: "Hampy sessions", extensions: ["hampy"] }],
  });
  if (!path) return null;
  const outputPath = path.toLowerCase().endsWith(".hampy") ? path : `${path}.hampy`;
  await ipc.writeTextFile(outputPath, text);
  return sessions.length;
}
