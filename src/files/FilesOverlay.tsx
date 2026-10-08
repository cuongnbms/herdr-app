import { useCallback, useEffect, useRef, useState } from "react";
import { filesListAll } from "../lib/ipc";
import type { FileList } from "../lib/types";
import { useApp } from "../store/app";
import { ActionsProvider, useActions } from "../sidebar/actions";
import { CloseIcon, EyeIcon, EyeOffIcon, RefreshIcon } from "../ui/icons";
import { setFolder, suggestFolder, useFolder } from "../workspaces/folder";
import type { WorkspaceRef } from "../workspaces/folder";
import { useFilesBus } from "./bus";
import { FileTabs } from "./FileTabs";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";
import { GoToFile } from "./GoToFile";
import { overlayRoot, type Root } from "./root";
import { filesKey, useFiles, wsKey } from "./store";
import { useWatch } from "./useWatch";

const SIDE_MIN = 200;
const SIDE_MAX = 600;
const SIDE_DEFAULT = 280;

export function FilesOverlay() {
  const ref = useApp((s) => s.filesOverlay);
  if (!ref) return null;
  return (
    <ActionsProvider>
      <FilesShell key={wsKey(ref)} wsRef={ref} />
    </ActionsProvider>
  );
}

function FilesShell({ wsRef: ref }: { wsRef: WorkspaceRef }) {
  const [reloadKey, setReloadKey] = useState(0);
  const machines = useApp((s) => s.machines);
  const setOverlay = useApp((s) => s.setFilesOverlay);
  const actions = useActions();
  const folder = useFolder(ref);
  const machine = machines[ref.machine_id];
  const ws = machine?.sessions.find((s) => s.name === ref.session)?.workspaces.find((w) => w.workspace_id === ref.workspace_id);

  // Resolved when the overlay opens, and again only when the Workspace folder is set: a cd in
  // the pane must not move the root under the open tabs.
  const resolve = () => overlayRoot(ref, useApp.getState());
  const [root, setRoot] = useState<Root | null>(resolve);
  const folderSeen = useRef(folder);
  useEffect(() => {
    if (folderSeen.current === folder) return;
    folderSeen.current = folder;
    setRoot(resolve());
  }, [folder]);

  const reload = () => {
    setReloadKey((k) => k + 1);
    if (root) useFilesBus.getState().reload(filesKey(ref, root.path));
  };
  const close = () => setOverlay(null);
  const [missing, setMissing] = useState<string | null>(null);
  const rootMissing = root !== null && missing === root.path;
  const onlineRef = useRef(false);
  const section = useRef<HTMLElement>(null);
  // Take focus from whatever pane had it, so Esc and typing reach this overlay.
  useEffect(() => section.current?.focus(), []);
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      const typing = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.closest(".files-overlay") !== null;
      if (typing || document.querySelector(".overlay")) return;
      useApp.getState().setFilesOverlay(null);
    };
    window.addEventListener("keydown", onEsc, false);
    return () => window.removeEventListener("keydown", onEsc, false);
  }, []);
  const label = ws?.label ?? ref.workspace_id;
  const online = machine?.state === "connected";
  onlineRef.current = online;
  // Reload and a change of connection re-check the root: FilesBrowser remounts and lists it again.
  useEffect(() => setMissing(null), [reloadKey, online]);

  return (
    <section ref={section} tabIndex={-1} className="files-overlay" role="dialog" aria-label="Files">
      <header className="files-head" data-tauri-drag-region>
        <span className="files-title">Files · {label}</span>
        {root && !rootMissing && <span className="files-root" title={root.path}>{root.path}</span>}
        {machine?.kind === "ssh" && <span className="files-machine">{machine.label}</span>}
        {root?.source === "pane" && !rootMissing && (
          <button type="button" className="btn btn-xs files-set-folder" onClick={() => setFolder(ref, root.path)}>
            Set as workspace folder
          </button>
        )}
        <span className="files-head-spacer" />
        {root && (
          <button type="button" className="icon-btn" aria-label="Reload" title="Reload  ⌘R" onClick={reload}>
            <RefreshIcon />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Close Files" onClick={close}>
          <CloseIcon />
        </button>
      </header>
      {!online && <div className="files-banner files-banner-offline">Machine offline</div>}
      {root && !rootMissing ? (
        <FilesBrowser key={filesKey(ref, root.path)} wsRef={ref} root={root.path} online={online} onMissing={() => onlineRef.current && setMissing(root.path)} />
      ) : (
        <div className="files-empty">
          <p>{root ? "This folder no longer exists." : "This workspace has no folder."}</p>
          <button type="button" className="btn" onClick={() => actions?.changeFolder(ref, folder ?? (ws ? suggestFolder(ws) : ""))}>
            Change folder…
          </button>
        </div>
      )}
    </section>
  );
}

function FilesBrowser({ wsRef, root, online, onMissing }: { onMissing(): void; wsRef: WorkspaceRef; root: string; online: boolean }) {
  const machineId = wsRef.machine_id;
  const key = filesKey(wsRef, root);
  // One field each: a write to another field (folds, scroll) re-renders nothing here.
  const tabs = useFiles((s) => s.ws(key).tabs);
  const preview = useFiles((s) => s.ws(key).preview);
  const active = useFiles((s) => s.ws(key).active);
  const recent = useFiles((s) => s.ws(key).recent);
  const { open, pin, close, closeTabs, cycle } = useFiles.getState();

  const [side, setSide] = useState(SIDE_DEFAULT);
  const [showHeavy, setShowHeavy] = useState(false);
  const [list, setList] = useState<FileList | null>(null);
  const batch = useFilesBus((s) => s.batches[key] ?? null);
  const reloadKey = useFilesBus((s) => s.reloads[key] ?? 0);
  const [watchError, setWatchError] = useState<string | null>(null);
  const goto = useRef<HTMLInputElement>(null);
  const reload = useCallback(() => useFilesBus.getState().reload(key), [key]);

  useEffect(() => {
    let gone = false;
    filesListAll(machineId, root).then(
      (l) => !gone && setList(l),
      (e) => {
        if (gone) return;
        setList(null);
        if ((e as { code?: string } | null)?.code === "not_found") onMissing();
      },
    );
    return () => {
      gone = true;
    };
  }, [machineId, root, reloadKey]);

  // The mount just listed everything, so the first Resync of a watch that started with it is
  // skipped; a watch started later (back online) or restarted after an error reloads.
  const skipResync = useRef(online);
  useEffect(() => {
    if (!online) skipResync.current = false;
  }, [online]);
  useWatch({
    enabled: online,
    machineId,
    root,
    onResync: () => {
      setWatchError(null);
      if (skipResync.current) skipResync.current = false;
      else reload();
    },
    onChanges: (changes) => {
      setWatchError(null);
      if (changes.some((c) => c.path === "" && c.removed)) {
        onMissing();
        return;
      }
      useFilesBus.getState().publish(key, changes);
    },
    onError: (message) => {
      // Changes made while the watch was down are only caught by reloading on its next Resync.
      skipResync.current = false;
      setWatchError(message);
    },
  });

  const onOpen = useCallback((rel: string, pinned: boolean) => open(key, rel, { pin: pinned }), [key, open]);
  const keys = (e: KeyboardEvent) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return;
    // A dialog over the overlay (Change folder…) keeps its keys.
    if (document.querySelector(".overlay")) return;
    const k = e.key.toLowerCase();
    if (!e.shiftKey && k === "p") {
      e.preventDefault();
      goto.current?.focus();
      goto.current?.select();
    } else if (!e.shiftKey && k === "w") {
      e.preventDefault();
      if (active) close(key, active);
    } else if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
      e.preventDefault();
      cycle(key, e.code === "BracketRight" ? 1 : -1);
    } else if (!e.shiftKey && k === "r" && !active) {
      // With a file open its viewer takes ⌘R.
      e.preventDefault();
      reload();
    }
  };
  const keysRef = useRef(keys);
  keysRef.current = keys;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener("keydown", h, false);
    return () => window.removeEventListener("keydown", h, false);
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = side;
    const move = (ev: MouseEvent) => setSide(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w0 + ev.clientX - x0)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="files-body" style={{ ["--files-side" as string]: `${side}px` }}>
      <aside className="files-side">
        <GoToFile list={list} recent={recent} onOpen={onOpen} inputRef={goto} />
        <div className="files-side-scroll">
          <div className="files-tree-head">
            <span>FILES</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Show heavy folders"
              aria-pressed={showHeavy}
              title={showHeavy ? "Hide .git, node_modules and other heavy folders" : "Show .git, node_modules and other heavy folders"}
              onClick={() => setShowHeavy((on) => !on)}
            >
              {showHeavy ? <EyeIcon /> : <EyeOffIcon />}
            </button>
          </div>
          <FileTree machineId={machineId} root={root} filesKey={key} onOpen={onOpen} reloadKey={reloadKey} showHeavy={showHeavy} changes={batch} />
        </div>
      </aside>
      <div className="files-resize" role="separator" aria-orientation="vertical" onMouseDown={startDrag} />
      <div className="files-main">
        {online && watchError && (
          <div className="files-banner files-banner-error" role="status">
            Auto-refresh stopped: {watchError}
          </div>
        )}
        <FileTabs
          tabs={tabs}
          preview={preview}
          active={active}
          onSelect={(rel) => open(key, rel, { pin: false })}
          onPin={(rel) => pin(key, rel)}
          onClose={(rel) => close(key, rel)}
          onCloseTabs={(scope, rel) => closeTabs(key, scope, rel)}
        />
        {active ? (
          <FileViewer item={{ kind: "file", ws: wsRef, root, rel: active }} online={online} />
        ) : (
          <div className="files-empty">Open a file from the tree, or press ⌘P</div>
        )}
      </div>
    </div>
  );
}
