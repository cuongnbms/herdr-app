import { Channel } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { filesUnwatch, filesWatch } from "../lib/ipc";
import type { FileChange, WatchEvent } from "../lib/types";

interface Options {
  enabled: boolean;
  machineId: string;
  root: string;
  onChanges(changes: FileChange[]): void;
  onResync(): void;
  onError(message: string): void;
}

/** Serializes watch starts across effects. Never rejects. */
let pending: Promise<void> = Promise.resolve();

/** Follows `root` on the backend while enabled; events arrive over a Channel. */
export function useWatch(opts: Options) {
  const latest = useRef(opts);
  latest.current = opts;
  const { enabled, machineId, root } = opts;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let id: number | null = null;
    const events = new Channel<WatchEvent>();
    events.onmessage = (e) => {
      if (stopped) return;
      if (e.type === "resync") latest.current.onResync();
      else if (e.type === "changes") latest.current.onChanges(e.changes);
      else latest.current.onError(e.message);
    };
    // Start in effect order: the backend holds one watch, so a stale start must never land after a newer one.
    pending = pending
      .then(() => (stopped ? null : filesWatch(machineId, root, events)))
      .then(
        (watchId) => {
          if (watchId === null) return;
          id = watchId;
          if (stopped) void filesUnwatch(watchId).catch(() => {});
        },
        (e) => {
          if (!stopped) latest.current.onError(e?.message ?? String(e));
        },
      );
    return () => {
      stopped = true;
      if (id !== null) void filesUnwatch(id).catch(() => {});
    };
  }, [enabled, machineId, root]);
}
