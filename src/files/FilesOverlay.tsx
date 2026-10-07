import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filesChanged, filesListAll, filesRead } from "../lib/ipc";
import type { Changed, FileContent, FileList } from "../lib/types";
import { useApp } from "../store/app";
import { ActionsProvider, useActions } from "../sidebar/actions";
import { CloseIcon, CopyIcon, EyeIcon, EyeOffIcon, FileCopyIcon, OutlineIcon, RefreshIcon } from "../ui/icons";
import { showToast } from "../ui/Toast";
import { setFolder, suggestFolder, useFolder } from "../workspaces/folder";
import type { WorkspaceRef } from "../workspaces/folder";
import { ChangedList } from "./ChangedList";
import { findMatches } from "./find";
import { FindBar } from "./FindBar";
import { FileTabs } from "./FileTabs";
import { FileTree } from "./FileTree";
import { FileView, type FileMode } from "./FileView";
import { GoToFile } from "./GoToFile";
import { latestOnly, STALE } from "./latest";
import { splitLines } from "./highlightLines";
import { HIGHLIGHT_LIMIT } from "./limits";
import { lineOfHash } from "./links";
import { useOutline } from "./outlineStore";
import { absPath, resolveRoot, type Root } from "./root";
import { filesKey, useFiles, wsKey } from "./store";
import { usePolling } from "./usePolling";

const SIDE_MIN = 200;
const SIDE_MAX = 600;
const SIDE_DEFAULT = 280;

const isMarkdown = (rel: string) => /\.(md|markdown)$/i.test(rel);
const errMessage = (e: unknown) => String((e as { message?: string } | null)?.message ?? e);

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
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const machines = useApp((s) => s.machines);
  const setOverlay = useApp((s) => s.setFilesOverlay);
  const actions = useActions();
  const folder = useFolder(ref);
  const machine = machines[ref.machine_id];
  const ws = machine?.sessions.find((s) => s.name === ref.session)?.workspaces.find((w) => w.workspace_id === ref.workspace_id);

  // Resolved when the overlay opens, and again only when the Workspace folder is set: a cd in
  // the pane must not move the root under the open tabs.
  const resolve = () => {
    // The selected pane's cwd counts only when that pane belongs to this workspace.
    const { selected } = useApp.getState();
    let cwd: string | null = null;
    if (selected && selected.machine_id === ref.machine_id && selected.session === ref.session && ws) {
      cwd = ws.tabs.flatMap((t) => t.panes).find((p) => p.pane_id === selected.pane_id)?.cwd ?? null;
    }
    return resolveRoot(ref, ws, cwd);
  };
  const [root, setRoot] = useState<Root | null>(resolve);
  const folderSeen = useRef(folder);
  useEffect(() => {
    if (folderSeen.current === folder) return;
    folderSeen.current = folder;
    setRoot(resolve());
  }, [folder]);

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
        <FilesBrowser key={filesKey(ref, root.path)} wsRef={ref} root={root.path} online={online} reloadKey={reloadKey} reload={reload} onMissing={() => onlineRef.current && setMissing(root.path)} />
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

function FilesBrowser({ wsRef, root, online, reloadKey, reload, onMissing }: { onMissing(): void; wsRef: WorkspaceRef; root: string; online: boolean; reloadKey: number; reload(): void }) {
  const machineId = wsRef.machine_id;
  const key = filesKey(wsRef, root);
  // One field each: a write to another field (folds, scroll) re-renders nothing here.
  const tabs = useFiles((s) => s.ws(key).tabs);
  const preview = useFiles((s) => s.ws(key).preview);
  const active = useFiles((s) => s.ws(key).active);
  const recent = useFiles((s) => s.ws(key).recent);
  const { open, pin, close, closeTabs, cycle, setScroll } = useFiles.getState();

  const [side, setSide] = useState(SIDE_DEFAULT);
  const [showHeavy, setShowHeavy] = useState(false);
  const [list, setList] = useState<FileList | null>(null);
  const [changed, setChanged] = useState<Changed | null>(null);
  const [doc, setDoc] = useState<{ rel: string; content: FileContent } | null>(null);
  const [error, setError] = useState<{ rel: string; message: string } | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [modes, setModes] = useState<Record<string, FileMode>>({});
  const [findOpen, setFindOpen] = useState(false);
  /** Bumped by ⌘F, so an open find bar takes the focus again. */
  const [findFocus, setFindFocus] = useState(0);
  /** The `#fragment` of the link that opened `rel`, used once when it is shown. */
  const [jump, setJump] = useState<{ rel: string; hash: string } | null>(null);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const outline = useOutline((s) => s.shown);
  const toggleOutline = useOutline((s) => s.toggle);
  const [hasOutline, setHasOutline] = useState(false);
  const [index, setIndex] = useState(0);
  const goto = useRef<HTMLInputElement>(null);
  const read = useMemo(() => latestOnly(filesRead), []);

  const load = useCallback(
    (rel: string) => {
      read(machineId, root, rel).then(
        (content) => {
          if (content === STALE) return;
          setDoc({ rel, content });
          setError(null);
          setRemoved(null);
        },
        (e) => setError({ rel, message: errMessage(e) }),
      );
    },
    [read, machineId, root],
  );

  useEffect(() => {
    if (active) load(active);
  }, [active, load, reloadKey]);

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
    filesChanged(machineId, root).then((c) => !gone && setChanged(c), () => {});
    return () => {
      gone = true;
    };
  }, [machineId, root, reloadKey]);

  const shown = doc && doc.rel === active ? doc.content : null;
  usePolling({
    enabled: online,
    machineId,
    root,
    rel: shown && active ? active : null,
    mtime: shown?.mtime ?? null,
    size: shown?.size ?? null,
    onChanged: (reason) => {
      if (reason === "removed") setRemoved(active);
      else if (active) load(active);
    },
    onChanges: setChanged,
  });

  // A different file starts with a fresh find, and a link's fragment applies to its own file only.
  useEffect(() => {
    setFindOpen(false);
    setIndex(0);
    setJump((j) => (j && j.rel === active ? j : null));
  }, [active]);

  const onOpen = useCallback((rel: string, pinned: boolean) => open(key, rel, { pin: pinned }), [key, open]);
  const onLink = useCallback(
    (rel: string, hash: string | null) => {
      setJump(hash ? { rel, hash } : null);
      open(key, rel, { pin: false });
    },
    [key, open],
  );

  // Rendering parses on the main thread, so text past the highlight limit opens as source.
  const large = shown?.text != null && shown.text.length > HIGHLIGHT_LIMIT;
  // A `#L12` link has a line to show, which only the source view has.
  const toLine = jump !== null && jump.rel === active && lineOfHash(jump.hash) !== null;
  const mode: FileMode = active ? (modes[active] ?? (large || toLine ? "source" : "render")) : "render";
  const setMode = (rel: string, m: FileMode) => setModes((s) => ({ ...s, [rel]: m }));
  const md = active !== null && isMarkdown(active);
  const searchable =
    shown !== null && shown.kind === "text" && shown.text !== null && !(md && mode === "render");
  const count = useMemo(
    () => (searchable && shown?.text != null && query ? findMatches(splitLines(shown.text), query, matchCase).length : 0),
    [searchable, shown, query, matchCase],
  );

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
    } else if (!e.shiftKey && k === "f") {
      e.preventDefault();
      if (!active || !shown || shown.kind !== "text" || shown.text === null) return;
      if (md && mode === "render") setMode(active, "source");
      setFindOpen(true);
      setFindFocus((n) => n + 1);
    } else if (k === "g") {
      e.preventDefault();
      // Not wrapped here: TextView wraps it, and each step re-scrolls even onto the same match.
      if (findOpen && searchable && count > 0) setIndex((i) => i + (e.shiftKey ? -1 : 1));
    } else if (!e.shiftKey && k === "r") {
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

  const fullPath = active ? absPath(root, active) : "";
  const copyPath = () => {
    if (!active) return;
    writeText(fullPath).then(
      () => showToast("Path copied"),
      (e) => console.error("copy failed", e),
    );
  };
  const cut = shown?.truncated ? " (first 2 MB only)" : "";
  const copyContents = () => {
    if (shown?.text == null) return;
    writeText(shown.text).then(
      () => showToast(`Contents copied${cut}`),
      (e) => console.error("copy failed", e),
    );
  };

  return (
    <div className="files-body" style={{ ["--files-side" as string]: `${side}px` }}>
      <aside className="files-side">
        <GoToFile list={list} recent={recent} onOpen={onOpen} inputRef={goto} />
        <div className="files-side-scroll">
          <ChangedList changed={changed} onOpen={onOpen} />
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
          <FileTree machineId={machineId} root={root} filesKey={key} onOpen={onOpen} reloadKey={reloadKey} showHeavy={showHeavy} />
        </div>
      </aside>
      <div className="files-resize" role="separator" aria-orientation="vertical" onMouseDown={startDrag} />
      <div className="files-main">
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
          <>
            <div className="files-crumbs">
              <span className="files-crumb-path" title={fullPath}>
                {active.split("/").join(" / ")}
              </span>
              <button type="button" className="icon-btn" aria-label="Copy path" title="Copy path" onClick={copyPath}>
                <CopyIcon />
              </button>
              {shown?.kind === "text" && shown.text !== null && (
                <button type="button" className="icon-btn" aria-label="Copy contents" title={`Copy contents${cut}`} onClick={copyContents}>
                  <FileCopyIcon />
                </button>
              )}
              {md && mode === "render" && hasOutline && (
                <button
                  type="button"
                  className="icon-btn files-outline-btn"
                  aria-label="Outline"
                  title={outline ? "Hide outline" : "Show outline"}
                  aria-pressed={outline}
                  onClick={toggleOutline}
                >
                  <OutlineIcon />
                </button>
              )}
              {md && shown?.kind === "text" && (
                <div className="files-mode" role="group" aria-label="Markdown view">
                  {(["render", "source"] as const).map((m) => (
                    <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(active, m)}>
                      {m === "render" ? "Render" : "Source"}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {removed === active && <div className="files-banner files-banner-removed">File removed</div>}
            {shown && error && error.rel === active && (
              <div className="files-banner files-banner-error" role="alert">
                Could not reload: {error.message}
              </div>
            )}
            {findOpen && searchable && (
              <FindBar
                count={count}
                index={count > 0 ? ((index % count) + count) % count : 0}
                focusKey={findFocus}
                query={query}
                matchCase={matchCase}
                onQuery={(q) => {
                  setQuery(q);
                  setIndex(0);
                }}
                onMatchCase={(on) => {
                  setMatchCase(on);
                  setIndex(0);
                }}
                // Not wrapped here: TextView wraps it, and each step re-scrolls even onto the same match.
                onStep={(d) => count > 0 && setIndex((i) => i + d)}
                onClose={() => setFindOpen(false)}
              />
            )}
            <div className="files-view">
              {shown ? (
                <FileView
                  machineId={machineId}
                  root={root}
                  rel={active}
                  content={shown}
                  mode={mode}
                  onMode={(m) => setMode(active, m)}
                  onOpen={onLink}
                  find={findOpen && searchable && query ? { query, index, matchCase } : null}
                  initialScroll={useFiles.getState().ws(key).scroll[active] ?? 0}
                  hash={jump && jump.rel === active ? jump.hash : null}
                  saveScroll={(rel, top) => setScroll(key, rel, top)}
                  outline={outline}
                  onOutline={setHasOutline}
                />
              ) : error && error.rel === active ? (
                <div className="files-notice" role="alert">{error.message}</div>
              ) : null}
            </div>
          </>
        ) : (
          <div className="files-empty">Open a file from the tree, or press ⌘P</div>
        )}
      </div>
    </div>
  );
}
