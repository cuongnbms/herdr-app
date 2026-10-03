import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useReducer, useRef } from "react";
import "../fonts/fonts.css";
import { attachKeyString, termAck, termOpen, termRelease, termResize, termWrite } from "../lib/ipc";
import type { AttachEvent, PaneRef } from "../lib/types";
import { useApp } from "../store/app";
import { Banner } from "./Banner";
import { ensureTermFont, useSettings, watchTermFont } from "../settings/store";
import { watchTermTheme } from "../settings/theme";
import { createAckBatcher, createInputQueue } from "./ipcBatch";
import { createKeyHandler } from "./keyHandler";
import { initialLensState, lensReducer } from "./lensState";
import { createOutputBuffer } from "./outputBuffer";
import { claim, disposeIf, getOrCreate } from "./termCache";
import { applyUnicode11 } from "./unicode";
import { forgetWebgl, showWebgl } from "./webgl";

const RESIZE_SETTLE_MS = 150;

interface Props {
  pane: PaneRef;
  terminalId: string;
}

function createEntry(key: string) {
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    // No smooth scroll: at 100ms trackpad scrolling lagged behind the fingers and felt rubbery.
    smoothScrollDuration: 0,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  applyUnicode11(term);
  term.attachCustomKeyEventHandler(createKeyHandler((text) => term.input(text)));
  const unwatchFont = watchTermFont(term, fit);
  const unwatchTheme = watchTermTheme(term);
  const output = createOutputBuffer((data, onParsed) => term.write(data, onParsed));
  return {
    term,
    fit,
    output,
    cleanup: () => {
      output.dispose();
      forgetWebgl(key);
      unwatchFont();
      unwatchTheme();
    },
  };
}

function toBytes(buf: unknown): Uint8Array | null {
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (buf instanceof Uint8Array) return buf;
  if (Array.isArray(buf)) return Uint8Array.from(buf as number[]);
  return null;
}

export function TerminalLens({ pane, terminalId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const takeoverRef = useRef<(() => void) | null>(null);
  const [lens, dispatch] = useReducer(lensReducer, initialLensState);
  const machineState = useApp((s) => s.machines[pane.machine_id]?.state);
  const machineRef = useRef(machineState);
  machineRef.current = machineState;

  const cacheKey = attachKeyString({ machine_id: pane.machine_id, session: pane.session, terminal_id: terminalId });

  useEffect(() => {
    dispatch({ type: "machine", machine: machineState });
  }, [machineState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const key = { machine_id: pane.machine_id, session: pane.session, terminal_id: terminalId };
    let live = true;
    const { term, fit, output } = getOrCreate(cacheKey, () => createEntry(cacheKey));
    const revealed = !!term.element;
    if (revealed) container.appendChild(term.element!);
    else term.open(container);
    try {
      fit.fit();
    } catch {
      /* container not measurable yet */
    }
    // Only the mounted terminal writes straight through; cached ones batch until shown again.
    output.setVisible(true);
    let frame = 0;
    // The WebGL atlas rasterizes ASCII up front, so the font must be a web font first
    // (see ensureTermFont); the DOM renderer covers the wait.
    void ensureTermFont(useSettings.getState().terminalFontFamily).then(() => {
      if (!live) return;
      showWebgl(cacheKey, term);
      if (!revealed) return;
      // Cells parsed while hidden, or under the other renderer's metrics, can composite stale
      // pixels; redraw once layout has settled.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (!live) return;
          term.clearTextureAtlas();
          term.refresh(0, term.rows - 1);
          try {
            fit.fit();
          } catch {
            /* ignore */
          }
        });
      });
    });

    const open = (takeover: boolean) => {
      // Data and detach handling deliberately ignore `live`: the cached xterm must keep
      // streaming (and acking) while hidden, and a hidden pane must still be disposed on detach.
      let closed = false;
      const token = claim(cacheKey);
      const acks = createAckBatcher((n) => termAck(key, n));
      const data = new Channel<ArrayBuffer>();
      data.onmessage = (buf) => {
        const bytes = toBytes(buf);
        if (!bytes || closed) return;
        output.write(bytes, () => acks.add(bytes.byteLength));
      };
      const events = new Channel<AttachEvent>();
      events.onmessage = (ev) => {
        if (ev.type === "detached") {
          closed = true;
          disposeIf(cacheKey, token);
        }
        if (live) dispatch({ type: "event", event: ev, machine: machineRef.current });
      };
      termOpen(key, term.cols, term.rows, takeover, data, events).catch((e) => {
        console.error("term_open failed", e);
        if (live) dispatch({ type: "open_failed", machine: machineRef.current });
      });
    };
    takeoverRef.current = () => open(true);
    open(false);

    const inputQueue = createInputQueue((d) => termWrite(key, d));
    const input = term.onData((d) => inputQueue.push(d));
    const resize = term.onResize(({ cols, rows }) => void termResize(key, cols, rows).catch(() => {}));

    // Refit once a split or window drag settles: each grid change reflows the scrollback and
    // makes herdr redraw the whole screen. fit() itself skips unchanged grids.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }, RESIZE_SETTLE_MS);
    });
    ro.observe(container);

    return () => {
      live = false;
      output.setVisible(false);
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      inputQueue.dispose();
      ro.disconnect();
      input.dispose();
      resize.dispose();
      takeoverRef.current = null;
      void termRelease(key).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, lens.generation]);

  return (
    <div className="term-lens">
      {lens.banner && (
        <Banner
          kind={lens.banner.kind}
          code={lens.banner.code}
          onTakeOver={() => takeoverRef.current?.()}
          onReattach={() => dispatch({ type: "reattach" })}
        />
      )}
      <div className="term-host" ref={containerRef} />
    </div>
  );
}
