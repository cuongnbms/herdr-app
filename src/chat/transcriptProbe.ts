import { useEffect } from "react";
import * as ipc from "../lib/ipc";
import { paneKey, type AgentStatus, type Located, type PaneRef } from "../lib/types";
import { useLensSettings } from "../settings/lens";
import { useApp } from "../store/app";
import { showToast } from "../ui/Toast";

/**
 * A pane that fell back to the Terminal lens because its agent had no transcript yet (Claude
 * writes it on the first prompt) returns to the Chat lens once the transcript exists. Looks
 * when the pane is shown and again when its agent starts or finishes work (the moments a
 * transcript appears; blocked/idle flips would only repeat the ssh lookups), each time once
 * more after `retryMs`, since the status can change just before the file is written. Off
 * when the user turned off switching to Chat after the first prompt.
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
  const phase = status === "working" || status === "done" ? status : "other";
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
  }, [key, phase, fallenBack, enabled]);
}
