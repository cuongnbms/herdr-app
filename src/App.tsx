import { lazy, Suspense, useEffect, useState } from "react";
import "./styles.css";
import { machinesList, onMachine, onPaneStatus, sessionStart } from "./lib/ipc";
import { notifyPaneStatus } from "./notify";
import { Palette } from "./palette/Palette";
import { Settings } from "./settings/Settings";
import { applyChatFont, useSettings } from "./settings/store";
import { Header } from "./main/Header";
import { Sidebar } from "./sidebar/Sidebar";
import { AgentList } from "./agents/AgentList";
import { useShallow } from "zustand/react/shallow";
import { paneKey } from "./lib/types";
import { chosenLens, selectedPane, useApp } from "./store/app";
import { showToast, Toasts } from "./ui/Toast";
import { openUrl } from "@tauri-apps/plugin-opener";
import { defaultLens } from "./lens";
import { AlertIcon, LayersIcon, TerminalIcon } from "./ui/icons";

function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

function EmptyMain() {
  const local = useApp((s) => s.machines["local"]);
  if (local?.state === "error" && local.error?.code === "herdr_not_found") {
    return (
      <EmptyState icon={<AlertIcon />} title="herdr is not installed on this Mac">
        <p className="empty-hint">The app talks to the herdr multiplexer running on each machine.</p>
        <p>
          <a
            className="btn btn-primary"
            href="https://herdr.dev"
            onClick={(e) => {
              e.preventDefault();
              void openUrl("https://herdr.dev").catch((err) => console.error("openUrl failed", err));
            }}
          >
            Install herdr
          </a>
        </p>
      </EmptyState>
    );
  }
  if (local?.state === "connected" && !local.sessions.some((s) => s.running)) {
    return (
      <EmptyState icon={<LayersIcon />} title="No running sessions">
        <p className="empty-hint">Start a herdr session to see its workspaces and agents here.</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() =>
            void sessionStart("local", "default").catch((err: unknown) =>
              showToast(`Could not start the default session: ${(err as { message?: string } | null)?.message ?? String(err)}`),
            )
          }
        >
          Start default session
        </button>
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<TerminalIcon />} title="Select a pane">
      <p className="empty-hint">
        Pick an agent from the list, or press <kbd>⌘</kbd> <kbd>K</kbd> to jump to any pane.
      </p>
    </EmptyState>
  );
}

const ChatLens = lazy(() => import("./chat/ChatLens").then((m) => ({ default: m.ChatLens })));
const TerminalLens = lazy(() => import("./terminal/TerminalLens").then((m) => ({ default: m.TerminalLens })));

export default function App() {
  const upsert = useApp((s) => s.upsertMachine);
  const sel = useApp(useShallow(selectedPane));
  const remembered = useApp((s) => (s.selected ? chosenLens(s, paneKey(s.selected)) : undefined));
  const note = useApp((s) => (s.selected ? s.lensNote[paneKey(s.selected)] : undefined));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const chatFontSize = useSettings((s) => s.chatFontSize);

  useEffect(() => applyChatFont(chatFontSize), [chatFontSize]);

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
        <div className="titlebar" data-tauri-drag-region />
        <div className="sidebar-scroll">
          <Sidebar />
        </div>
        <Settings />
      </nav>
      <aside className="agents" aria-label="Agents">
        <AgentList />
      </aside>
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
          <>
            <div className="titlebar" data-tauri-drag-region />
            <div className="main-empty">
              <EmptyMain />
            </div>
          </>
        )}
      </main>
      <Toasts />
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
