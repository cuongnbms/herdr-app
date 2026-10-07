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
    filesWatch(machineId, root, events).then(
      (watchId) => {
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
