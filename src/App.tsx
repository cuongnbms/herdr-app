import { lazy, Suspense, useEffect, useState } from "react";
import "./styles.css";
import { machinesList, onMachine, onPaneStatus, sessionStart } from "./lib/ipc";
import { notifyPaneStatus } from "./notify";
import { Palette } from "./palette/Palette";
import { Settings } from "./settings/Settings";
import { Header } from "./main/Header";
import { Sidebar } from "./sidebar/Sidebar";
import { useShallow } from "zustand/react/shallow";
import { paneKey } from "./lib/types";
import { selectedPane, useApp } from "./store/app";
import { Toasts } from "./ui/Toast";
import { openUrl } from "@tauri-apps/plugin-opener";
import { defaultLens } from "./lens";

function EmptyMain() {
  const local = useApp((s) => s.machines["local"]);
  if (local?.state === "error" && local.error?.code === "herdr_not_found") {
    return (
      <div className="empty">
        <p>herdr is not installed on this Mac</p>
        <p>
          <a
            href="https://herdr.dev"
            onClick={(e) => {
              e.preventDefault();
              void openUrl("https://herdr.dev").catch((err) => console.error("openUrl failed", err));
            }}
          >
            Install herdr
          </a>
        </p>
      </div>
    );
  }
  if (local?.state === "connected" && !local.sessions.some((s) => s.running)) {
    return (
      <div className="empty">
        <p>No running sessions</p>
        <button
          type="button"
          onClick={() => void sessionStart("local", "default").catch((err) => console.error("session_start failed", err))}
        >
          Start default session
        </button>
      </div>
    );
  }
  return <p className="empty">Select a pane</p>;
}

const ChatLens = lazy(() => import("./chat/ChatLens").then((m) => ({ default: m.ChatLens })));
const TerminalLens = lazy(() => import("./terminal/TerminalLens").then((m) => ({ default: m.TerminalLens })));

export default function App() {
  const upsert = useApp((s) => s.upsertMachine);
  const sel = useApp(useShallow(selectedPane));
  const remembered = useApp((s) => (s.selected ? s.lens[paneKey(s.selected)] : undefined));
  const note = useApp((s) => (s.selected ? s.lensNote[paneKey(s.selected)] : undefined));
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void machinesList().then((ms) => {
      if (!cancelled) ms.forEach(upsert);
    }).catch((e) => console.error("machines_list failed", e));
    void onMachine(upsert).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [upsert]);

  // Notifications: the permission prompt only happens lazily inside notifyPaneStatus.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onPaneStatus((ev) => {
      const { selected, machines } = useApp.getState();
      void notifyPaneStatus(ev, selected, machines);
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ref = sel ? { machine_id: sel.machine.id, session: sel.session.name, pane_id: sel.pane.pane_id } : null;
  const key = ref ? paneKey(ref) : "";

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Machines">
        <div className="sidebar-scroll">
          <Sidebar />
        </div>
        <Settings />
      </nav>
      <main className="main">
        {sel && ref ? (
          <>
            <Header />
            <Suspense fallback={null}>
              {defaultLens(sel.pane, remembered) === "chat" ? (
                <ChatLens key={key} pane={ref} view={sel.pane} />
              ) : (
                <>
                  {note && <div className="lens-note">{note}</div>}
                  <TerminalLens key={key} pane={ref} terminalId={sel.pane.terminal_id} />
                </>
              )}
            </Suspense>
          </>
        ) : (
          <EmptyMain />
        )}
      </main>
      <Toasts />
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
