import { useEffect } from "react";
import "./styles.css";
import { machinesList, onMachine } from "./lib/ipc";
import { Header } from "./main/Header";
import { Sidebar } from "./sidebar/Sidebar";
import { selectedPane, useApp } from "./store/app";

export default function App() {
  const upsert = useApp((s) => s.upsertMachine);
  const hasSelection = useApp((s) => selectedPane(s) !== null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void machinesList().then((ms) => {
      if (!cancelled) ms.forEach(upsert);
    }).catch(() => {});
    void onMachine(upsert).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [upsert]);

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Machines">
        <Sidebar />
      </nav>
      <main className="main">
        {hasSelection ? <Header /> : <p className="empty">Select a pane</p>}
      </main>
    </div>
  );
}
