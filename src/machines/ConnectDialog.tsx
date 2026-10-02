import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import "../fonts/fonts.css";
import {
  connectClose,
  connectOpen,
  connectResize,
  connectWrite,
  machineConnect,
  machineMasterAlive,
} from "../lib/ipc";
import type { AttachEvent, MachineView } from "../lib/types";
import { watchTermFont } from "../settings/store";
import { watchTermTheme } from "../settings/theme";

function toBytes(buf: unknown): Uint8Array | null {
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (buf instanceof Uint8Array) return buf;
  if (Array.isArray(buf)) return Uint8Array.from(buf as number[]);
  return null;
}

/** Runs the interactive ssh master in a terminal so passwords, passphrases and host-key prompts work. */
export function ConnectDialog({ machine, onClose }: { machine: MachineView; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = machine.id;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const unwatchFont = watchTermFont(term, fit);
    const unwatchTheme = watchTermTheme(term);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* not measurable yet */
    }
    let done = false;
    let succeeded = false;
    const finish = () => {
      if (done) return;
      done = true;
      succeeded = true;
      closeRef.current();
    };

    const data = new Channel<ArrayBuffer>();
    data.onmessage = (buf) => {
      const bytes = toBytes(buf);
      if (bytes) term.write(bytes);
    };
    const events = new Channel<AttachEvent>();
    events.onmessage = (ev) => {
      if (ev.type !== "exited") return;
      // Exit 0: ssh authenticated and went to the background; the backend connects the Machine.
      if (ev.code === 0) finish();
      else setExitCode(ev.code ?? -1);
    };
    connectOpen(id, term.cols, term.rows, data, events).catch((e) =>
      setError((e as { message?: string } | null)?.message ?? String(e)),
    );

    const input = term.onData((d) => void connectWrite(id, d).catch(() => {}));
    const resize = term.onResize(({ cols, rows }) => void connectResize(id, cols, rows).catch(() => {}));

    // Safety net: if the exit event never arrives (ssh -f keeps the PTY), notice the live master.
    const poll = setInterval(() => {
      void machineMasterAlive(id)
        .then((alive) => {
          if (!alive || done) return;
          void machineConnect(id).catch(() => {});
          finish();
        })
        .catch(() => {});
    }, 500);

    return () => {
      done = true;
      clearInterval(poll);
      input.dispose();
      resize.dispose();
      unwatchFont();
      unwatchTheme();
      term.dispose();
      // After success the master must be left alone (it may still be detaching).
      if (!succeeded) void connectClose(id).catch(() => {});
    };
  }, [id]);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog connect" role="dialog" aria-label={`Connect to ${machine.label}`} onMouseDown={(e) => e.stopPropagation()}>
        <h3>Connect to {machine.label}</h3>
        <div className="connect-term" ref={host} />
        {exitCode !== null && <p className="error dialog-error">ssh exited with code {exitCode}</p>}
        {error && <p className="error dialog-error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn" onClick={onClose}>{exitCode !== null ? "Close" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
}
