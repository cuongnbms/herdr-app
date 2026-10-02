import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import "../fonts/fonts.css";
import { attachKeyString, termAck, termOpen, termRelease, termResize, termWrite } from "../lib/ipc";
import type { AttachEvent, PaneRef } from "../lib/types";
import { useApp } from "../store/app";
import { Banner, type BannerKind } from "./Banner";
import { dispose, getOrCreate } from "./termCache";

interface Props {
  pane: PaneRef;
  terminalId: string;
}

function createEntry() {
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: { background: "#16171a", foreground: "#e4e5e8" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => !e.metaKey);
  return { term, fit };
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
  const [banner, setBanner] = useState<{ kind: BannerKind; code?: number | null } | null>(null);
  const [generation, setGeneration] = useState(0);
  const [detached, setDetached] = useState(false);
  const machineState = useApp((s) => s.machines[pane.machine_id]?.state);

  const attach = { machine_id: pane.machine_id, session: pane.session, terminal_id: terminalId };
  const cacheKey = attachKeyString(attach);

  // Re-attach after an SSH drop once the machine is back.
  useEffect(() => {
    if (detached && machineState === "connected") {
      setDetached(false);
      setBanner(null);
      setGeneration((g) => g + 1);
    }
  }, [detached, machineState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const key = { machine_id: pane.machine_id, session: pane.session, terminal_id: terminalId };
    let live = true;
    const { term, fit } = getOrCreate(cacheKey, createEntry);
    if (!term.element) {
      term.open(container);
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => gl.dispose());
        term.loadAddon(gl);
      } catch {
        /* DOM renderer fallback */
      }
    } else {
      container.appendChild(term.element);
    }
    try {
      fit.fit();
    } catch {
      /* container not measurable yet */
    }

    const open = (takeover: boolean) => {
      const data = new Channel<ArrayBuffer>();
      data.onmessage = (buf) => {
        const bytes = toBytes(buf);
        if (!live || !bytes) return;
        term.write(bytes, () => void termAck(key, bytes.byteLength).catch(() => {}));
      };
      const events = new Channel<AttachEvent>();
      events.onmessage = (ev) => {
        if (!live) return;
        switch (ev.type) {
          case "attached":
            setBanner(null);
            break;
          case "held":
            setBanner({ kind: "held" });
            break;
          case "exited":
            setBanner({ kind: "exited", code: ev.code });
            break;
          case "detached":
            dispose(cacheKey);
            setBanner({ kind: "detached" });
            setDetached(true);
            break;
        }
      };
      termOpen(key, term.cols, term.rows, takeover, data, events).catch((e) =>
        console.error("term_open failed", e),
      );
    };
    takeoverRef.current = () => open(true);
    open(false);

    // Input, coalesced per animation frame.
    let pending = "";
    let raf = 0;
    const input = term.onData((d) => {
      pending += d;
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          const out = pending;
          pending = "";
          if (out) void termWrite(key, out).catch(() => {});
        });
    });
    const resize = term.onResize(({ cols, rows }) => void termResize(key, cols, rows).catch(() => {}));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }, 50);
    });
    ro.observe(container);

    return () => {
      live = false;
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      input.dispose();
      resize.dispose();
      takeoverRef.current = null;
      void termRelease(key).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, generation]);

  return (
    <div className="term-lens">
      {banner && <Banner kind={banner.kind} code={banner.code} onTakeOver={() => takeoverRef.current?.()} />}
      <div className="term-host" ref={containerRef} />
    </div>
  );
}
