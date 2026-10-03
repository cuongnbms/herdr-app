import { useEffect } from "react";
import * as ipc from "../lib/ipc";
import { paneKey, type AgentStatus, type Located, type PaneRef } from "../lib/types";
import { useLensSettings } from "../settings/lens";
import { useApp } from "../store/app";
import { showToast } from "../ui/Toast";

/**
 * A pane that fell back to the Terminal lens because its agent had no transcript yet (Claude
 * writes it on the first prompt) returns to the Chat lens once the transcript exists. Looks
 * again when the pane is shown and whenever its agent changes status, then once more after
 * `retryMs`, since the status can change just before the file is written. Off when the user
 * turned off switching to Chat after the first prompt.
 */
export function useTranscriptProbe(
  pane: PaneRef | null,
  status: AgentStatus | undefined,
  locate: (p: PaneRef) => Promise<Located> = ipc.chatLocate,
  retryMs = 1500,
) {
  const key = pane ? paneKey(pane) : "";
  const fallenBack = useApp((s) => (key ? s.lensOverride[key] === "terminal" : false));
  const enabled = useLensSettings((s) => s.chatAfterFirstPrompt);
  useEffect(() => {
    if (!pane || !fallenBack || !enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = (retry: boolean) =>
      locate(pane).then(
        (l) => {
          if (cancelled) return;
          // Before herdr reports the session, the newest file in the folder is another pane's.
          if (l.agent === "claude" && l.ambiguous) {
            if (retry) timer = setTimeout(() => void probe(false), retryMs);
            return;
          }
          useApp.getState().setLensOverride(key, null);
          showToast("Switched to Chat", { alert: false });
        },
        () => {
          if (!cancelled && retry) timer = setTimeout(() => void probe(false), retryMs);
        },
      );
    void probe(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, status, fallenBack, enabled]);
}
