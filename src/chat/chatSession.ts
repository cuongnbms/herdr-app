import type { Channel } from "@tauri-apps/api/core";
import * as ipc from "../lib/ipc";
import { paneKey, type AppError, type ChatEvent, type Located, type MachineState, type PaneRef } from "../lib/types";

export interface ChatDeps {
  chatOpen: (p: PaneRef, path: string | null, events: Channel<ChatEvent>) => Promise<Located>;
  chatClose: (p: PaneRef) => Promise<void>;
}

const realDeps: ChatDeps = { chatOpen: ipc.chatOpen, chatClose: ipc.chatClose };

// Per pane: the latest open's sequence number and a promise that settles when it has finished.
const tails = new Map<string, { seq: number; settled: Promise<void> }>();

/**
 * Opens a chat tail. Opens for the same pane are serialised (a newer open starts only after the
 * previous one settled), and `close` runs the backend close only after its own open settled and
 * only when no newer open was started for that pane, so a stale close never kills a live tail and
 * a stale open never leaks an orphan one. `opened` resolves to null when cancelled before it ran.
 */
export function openChat(pane: PaneRef, path: string | null, events: Channel<ChatEvent>, deps: ChatDeps = realDeps) {
  const key = paneKey(pane);
  const prev = tails.get(key);
  const seq = (prev?.seq ?? 0) + 1;
  let cancelled = false;
  const opened: Promise<Located | null> = (prev?.settled ?? Promise.resolve()).then(() =>
    cancelled ? null : deps.chatOpen(pane, path, events),
  );
  const settled = opened.then(
    () => {},
    () => {},
  );
  tails.set(key, { seq, settled });
  const close = () => {
    cancelled = true;
    void settled.then(() => {
      if (tails.get(key)?.seq !== seq) return;
      tails.delete(key);
      return deps.chatClose(pane).catch(() => {});
    });
  };
  return { opened, close };
}

/**
 * What a failed chat open leads to: a remembered transcript that is gone is forgotten and the
 * transcript located again (once: that retry has no path); no transcript at all falls back to
 * the Terminal lens (in memory only). A Machine that is not connected is just an error: the
 * chat reopens when the Machine comes back.
 */
export function onOpenFailure(path: string | null, e: AppError | null | undefined, machine: MachineState | undefined): "retry_auto" | "fallback" | "error" {
  if (e?.code !== "not_found" || machine !== "connected") return "error";
  return path !== null ? "retry_auto" : "fallback";
}

/** Tracks a Machine going down and back up; `reopen` is true on the down -> connected edge. */
export function watchMachine(sawDown: boolean, machine: MachineState | undefined): { sawDown: boolean; reopen: boolean } {
  if (machine !== "connected") return { sawDown: true, reopen: false };
  return { sawDown: false, reopen: sawDown };
}
