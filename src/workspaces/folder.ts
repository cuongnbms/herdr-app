import { useSyncExternalStore } from "react";
import type { SessionView, WorkspaceView } from "../lib/types";

export interface WorkspaceRef {
  machine_id: string;
  session: string;
  workspace_id: string;
}

const PREFIX = "herdr-app:ws-folder:";

const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function folderKey(ref: WorkspaceRef): string {
  return PREFIX + [ref.machine_id, ref.session, ref.workspace_id].map(encodeURIComponent).join("/");
}

export function getFolder(ref: WorkspaceRef): string | null {
  try {
    return localStorage.getItem(folderKey(ref)) || null;
  } catch {
    return null;
  }
}

export function setFolder(ref: WorkspaceRef, path: string): void {
  const value = path.trim();
  try {
    if (value) localStorage.setItem(folderKey(ref), value);
    else localStorage.removeItem(folderKey(ref));
  } catch {
    /* ignore */
  }
  notify();
}

export function suggestFolder(ws: WorkspaceView): string {
  for (const tab of ws.tabs) {
    for (const pane of tab.panes) {
      if (pane.cwd) return pane.cwd;
    }
  }
  return "";
}

export function pruneFolders(machineId: string, session: SessionView): void {
  if (!session.running || session.error || session.workspaces.length === 0) return;
  const prefix = PREFIX + encodeURIComponent(machineId) + "/" + encodeURIComponent(session.name) + "/";
  const live = new Set(session.workspaces.map((w) => w.workspace_id));
  let removed = false;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      let id: string;
      try {
        id = decodeURIComponent(key.slice(prefix.length));
      } catch {
        continue;
      }
      if (!live.has(id)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
    removed = doomed.length > 0;
  } catch {
    /* ignore */
  }
  if (removed) notify();
}

export function useFolder(ref: WorkspaceRef): string | null {
  return useSyncExternalStore(subscribe, () => getFolder(ref));
}

export function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}
