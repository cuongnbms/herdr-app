import { lazy, Suspense, useEffect, useState } from "react";
import "./styles.css";
import { machinesList, onMachine, onPaneStatus } from "./lib/ipc";
import { notifyPaneStatus } from "./notify";
import { Palette } from "./palette/Palette";
import { Settings } from "./settings/Settings";
import { Header } from "./main/Header";
import { Sidebar } from "./sidebar/Sidebar";
import { useShallow } from "zustand/react/shallow";
import { paneKey } from "./lib/types";
import { selectedPane, useApp } from "./store/app";

const TerminalLens = lazy(() => import("./terminal/TerminalLens").then((m) => ({ default: m.TerminalLens })));

export default function App() {
  const upsert = useApp((s) => s.upsertMachine);
  const sel = useApp(useShallow(selectedPane));
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

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Machines">
        <div className="sidebar-scroll">
          <Sidebar />
        </div>
        <Settings />
      </nav>
      <main className="main">
        {sel ? (
          <>
            <Header />
            <Suspense fallback={null}>
            <TerminalLens
              key={paneKey({ machine_id: sel.machine.id, session: sel.session.name, pane_id: sel.pane.pane_id })}
              pane={{ machine_id: sel.machine.id, session: sel.session.name, pane_id: sel.pane.pane_id }}
              terminalId={sel.pane.terminal_id}
            />
            </Suspense>
          </>
        ) : (
          <p className="empty">Select a pane</p>
        )}
      </main>
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
