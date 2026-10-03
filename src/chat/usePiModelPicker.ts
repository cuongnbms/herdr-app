import { useEffect, useRef, useState } from "react";
import { herdrCall } from "../lib/ipc";
import type { PaneRef } from "../lib/types";
import { parseInteractivePrompt } from "./prompt/screenPrompt";

/** How often the screen is re-read while the picker is awaited or open. */
export const PI_MODEL_POLL_MS = 1500;
/** How long to wait for the picker: `/model <name>` can switch without one. */
export const PI_MODEL_WAIT_MS = 10_000;

interface ReadResult {
  text?: string;
  read?: { text?: string };
}

/**
 * pi's `/model` picker, which pi waits on while `idle`, so herdr never reports it blocked.
 * Armed once the Composer sends `/model`, it reads the pane's screen until the picker shows,
 * gives up if it never does, and once seen keeps reading until it is gone. `onDone` disarms it.
 */
export function usePiModelPicker(pane: PaneRef, armed: boolean, onDone: () => void) {
  const [open, setOpen] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    setOpen(false);
    if (!armed) return;
    let live = true;
    let seen = false;
    let reading = false;
    const finish = () => {
      if (!live) return;
      live = false;
      clearInterval(timer);
      clearTimeout(wait);
      setOpen(false);
      done.current();
    };
    const read = () => {
      // No reads while the window is in the background; the next tick after it returns reads.
      if (document.hidden || reading) return;
      reading = true;
      herdrCall(pane.machine_id, pane.session, "pane.read", {
        pane_id: pane.pane_id,
        source: "visible",
        format: "text",
        strip_ansi: true,
      })
        .then(
          (r) => {
            if (!live) return;
            const text = (r as ReadResult | undefined)?.text ?? (r as ReadResult | undefined)?.read?.text ?? "";
            const showing = parseInteractivePrompt("pi", text) !== null;
            if (showing) {
              seen = true;
              setOpen(true);
            } else if (seen) finish();
          },
          (e) => console.error("pane.read failed", e),
        )
        .finally(() => {
          reading = false;
        });
    };
    read();
    const timer = setInterval(read, PI_MODEL_POLL_MS);
    const wait = setTimeout(() => {
      if (!seen) finish();
    }, PI_MODEL_WAIT_MS);
    return () => {
      live = false;
      clearInterval(timer);
      clearTimeout(wait);
    };
  }, [armed, pane.machine_id, pane.session, pane.pane_id]);

  return { open };
}
