import { useEffect } from "react";
import * as ipc from "../lib/ipc";
import { paneKey, type AgentStatus, type Located, type PaneRef } from "../lib/types";

/**
 * A chat opened on a pending transcript (Claude writes it on the first prompt) tails the path
 * Claude is expected to write. If Claude started in another directory, the file turns up
 * elsewhere: while the chat is still empty, look again when the pane is shown and whenever its
 * agent changes status, then once more after `retryMs`, and `reopen` once it is found at
 * another path.
 */
export function usePendingTranscript(
  pane: PaneRef,
  located: Located | null,
  empty: boolean,
  status: AgentStatus | undefined,
  reopen: () => void,
  locate: (p: PaneRef) => Promise<Located> = ipc.chatLocate,
  retryMs = 1500,
) {
  const key = paneKey(pane);
  const waiting = !!located?.pending && empty;
  const path = located?.path;
  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = (retry: boolean) => {
      const again = () => {
        if (!cancelled && retry) timer = setTimeout(() => probe(false), retryMs);
      };
      locate(pane).then((l) => {
        if (cancelled) return;
        if (l.path !== path) reopen();
        else again();
      }, again);
    };
    probe(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, waiting, path, status]);
}
