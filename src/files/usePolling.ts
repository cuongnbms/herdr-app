import { useEffect, useRef } from "react";
import { filesChanged, filesStat } from "../lib/ipc";
import type { Changed } from "../lib/types";
import { POLL_MS } from "./limits";

interface Options {
  enabled: boolean;
  machineId: string;
  root: string;
  /** The open file, if any. */
  rel: string | null;
  mtime: number | null;
  size: number | null;
  onChanged(reason?: "removed"): void;
  onChanges(changed: Changed): void;
}

/** Every POLL_MS while enabled: stat the open file, then fetch the changed list. Never overlaps itself. */
export function usePolling(opts: Options) {
  const latest = useRef(opts);
  latest.current = opts;
  const { enabled, machineId, root, rel, mtime, size } = opts;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        if (rel !== null) {
          const [stat] = await filesStat(machineId, root, [rel]);
          if (stopped) return;
          if (stat === null || stat === undefined) latest.current.onChanged("removed");
          else if (stat.size !== size || stat.mtime !== mtime) latest.current.onChanged();
        }
      } catch {
        /* the next tick retries */
      }
      try {
        const changed = await filesChanged(machineId, root);
        if (!stopped) latest.current.onChanges(changed);
      } catch {
        /* the next tick retries */
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };

    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, machineId, root, rel, mtime, size]);
}
