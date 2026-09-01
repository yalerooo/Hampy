// Shared session import/export flows, used by both the Settings dialog and the
// sidebar. Each prompts for a file, then reads/parses or serializes/writes using
// the MobaXterm-format helpers. Returns the affected count, or null if the user
// cancelled the file dialog. Callers handle their own UI feedback / refresh.

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ipc } from "./ipc";
import { parseMxtSessions, serializeMxtSessions } from "./mobaxterm";

/** Prompt for a session file and import its sessions. Returns how many were added. */
export async function importSessions(): Promise<number | null> {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: "Sessions", extensions: ["mxtsessions", "ini", "txt"] }],
  });
  if (!path || Array.isArray(path)) return null;
  const text = await ipc.readTextFile(path);
  const parsed = parseMxtSessions(text);
  for (const s of parsed) await ipc.saveSession(s);
  return parsed.length;
}

/** Prompt for a destination and export all sessions. Returns how many were written. */
export async function exportSessions(): Promise<number | null> {
  const sessions = await ipc.listSessions();
  const text = serializeMxtSessions(sessions);
  const path = await saveDialog({ defaultPath: "hampy-sessions.mxtsessions" });
  if (!path) return null;
  await ipc.writeTextFile(path, text);
  return sessions.length;
}
