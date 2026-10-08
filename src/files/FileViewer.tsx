import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filesRead } from "../lib/ipc";
import type { FileChange, FileContent } from "../lib/types";
import { useApp } from "../store/app";
import { itemKey, type OpenItem } from "../store/openItems";
import { CopyIcon, FileCopyIcon, OutlineIcon } from "../ui/icons";
import { showToast } from "../ui/Toast";
import { useFilesBus } from "./bus";
import type { FindStatus } from "./find";
import { FindBar } from "./FindBar";
import { FileView, type FileMode } from "./FileView";
import { latestOnly, STALE } from "./latest";
import { HIGHLIGHT_LIMIT } from "./limits";
import { lineOfHash } from "./links";
import { useOutline } from "./outlineStore";
import { absPath } from "./root";
import { filesKey, useFiles } from "./store";

const isMarkdown = (rel: string) => /\.(md|markdown)$/i.test(rel);
const errMessage = (e: unknown) => String((e as { message?: string } | null)?.message ?? e);

interface Props {
  item: Extract<OpenItem, { kind: "file" }>;
  online: boolean;
}

/** Shows one open file: breadcrumbs, render/source, find, and a re-read when the change bus says so. */
export function FileViewer({ item }: Props) {
  const { ws, root, rel } = item;
  const machineId = ws.machine_id;
  const key = filesKey(ws, root);
  const [doc, setDoc] = useState<{ rel: string; content: FileContent } | null>(null);
  const [error, setError] = useState<{ rel: string; message: string } | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  const [modes, setModes] = useState<Record<string, FileMode>>({});
  const [findOpen, setFindOpen] = useState(false);
  /** Bumped by ⌘F, so an open find bar takes the focus again. */
  const [findFocus, setFindFocus] = useState(0);
  /** The `#fragment` of the link that opened this file, taken from the bus when it is shown. */
  const [jump, setJump] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const outline = useOutline((s) => s.shown);
  const toggleOutline = useOutline((s) => s.toggle);
  const [hasOutline, setHasOutline] = useState(false);
  const [index, setIndex] = useState(0);
  const read = useMemo(() => latestOnly(filesRead), []);
  const reloads = useFilesBus((s) => s.reloads[key] ?? 0);
  const batch = useFilesBus((s) => s.batches[key]);

  const load = useCallback(
    (r: string) => {
      read(machineId, root, r).then(
        (content) => {
          if (content === STALE) return;
          setDoc({ rel: r, content });
          setError(null);
          setRemoved(null);
        },
        (e) => {
          if ((e as { code?: string } | null)?.code === "not_found") setRemoved(r);
          else setError({ rel: r, message: errMessage(e) });
        },
      );
    },
    [read, machineId, root],
  );

  useEffect(() => {
    load(rel);
  }, [rel, load, reloads]);

  // Batches published before this viewer mounted are not its to handle.
  const seen = useRef(batch?.seq ?? 0);
  useEffect(() => {
    if (!batch || batch.seq === seen.current) return;
    seen.current = batch.seq;
    const own = batch.changes.find((c) => c.path === rel);
    // A folder above it changed (e.g. removed or renamed): reading it again finds out.
    const above = (c: FileChange) => c.isDir && (c.path === "" || rel.startsWith(c.path + "/"));
    if (own) {
      if (own.removed) setRemoved(rel);
      else load(rel);
    } else if (batch.changes.some(above)) load(rel);
  }, [batch, rel, load]);

  // A different file starts with a fresh find and without the last file's link fragment.
  useEffect(() => {
    setFindOpen(false);
    setIndex(0);
    setJump(null);
  }, [rel]);

  // A link's fragment waits on the bus under the key of the file it targets; this viewer takes its own.
  const itemId = itemKey(item);
  const pending = useFilesBus((s) => (s.jump?.key === itemId ? s.jump.hash : null));
  useEffect(() => {
    if (pending === null) return;
    setJump(pending);
    useFilesBus.getState().setJump(null);
  }, [pending]);

  const onLink = useCallback(
    (to: string, hash: string | null) => {
      useFilesBus.getState().setJump(hash ? { key: itemKey({ kind: "file", ws, root, rel: to }), hash } : null);
      useApp.getState().openFile(ws, root, to, { pin: false });
    },
    [ws, root],
  );

  const shown = doc && doc.rel === rel ? doc.content : null;
  // Rendering parses on the main thread, so text past the highlight limit opens as source.
  const large = shown?.text != null && shown.text.length > HIGHLIGHT_LIMIT;
  // A `#L12` link has a line to show, which only the source view has.
  const toLine = jump !== null && lineOfHash(jump) !== null;
  const mode: FileMode = modes[rel] ?? (large || toLine ? "source" : "render");
  const setMode = (r: string, m: FileMode) => setModes((s) => ({ ...s, [r]: m }));
  // The other view searches afresh from what it shows on screen.
  useEffect(() => setIndex(0), [mode]);
  const md = isMarkdown(rel);
  // Rendered markdown is searched in its rendered text, everything else in its source.
  const searchable = shown !== null && shown.kind === "text" && shown.text !== null;
  /** Reported by the view, which owns the matches and where the search starts. */
  const [status, setStatus] = useState<FindStatus>({ count: 0, index: 0 });
  const count = findOpen && searchable && query ? status.count : 0;

  const keys = (e: KeyboardEvent) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return;
    // A dialog over the file (Change folder…) keeps its keys.
    if (document.querySelector(".overlay")) return;
    const k = e.key.toLowerCase();
    if (!e.shiftKey && k === "f") {
      e.preventDefault();
      if (!searchable) return;
      setFindOpen(true);
      setFindFocus((n) => n + 1);
    } else if (k === "g") {
      e.preventDefault();
      // Not wrapped here: the view wraps it, and each step re-scrolls even onto the same match.
      if (findOpen && searchable && count > 0) setIndex((i) => i + (e.shiftKey ? -1 : 1));
    } else if (!e.shiftKey && k === "r") {
      e.preventDefault();
      useFilesBus.getState().reload(key);
    }
  };
  const keysRef = useRef(keys);
  keysRef.current = keys;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener("keydown", h, false);
    return () => window.removeEventListener("keydown", h, false);
  }, []);

  const fullPath = absPath(root, rel);
  const copyPath = () => {
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
    <>
      <div className="files-crumbs">
        <span className="files-crumb-path" title={fullPath}>
          {rel.split("/").join(" / ")}
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
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(rel, m)}>
                {m === "render" ? "Render" : "Source"}
              </button>
            ))}
          </div>
        )}
      </div>
      {removed === rel && <div className="files-banner files-banner-removed">File removed</div>}
      {shown && error && error.rel === rel && (
        <div className="files-banner files-banner-error" role="alert">
          Could not reload: {error.message}
        </div>
      )}
      {findOpen && searchable && (
        <FindBar
          count={count}
          index={status.index}
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
          // Not wrapped here: the view wraps it, and each step re-scrolls even onto the same match.
          onStep={(d) => count > 0 && setIndex((i) => i + d)}
          onClose={() => setFindOpen(false)}
        />
      )}
      <div className="files-view">
        {shown ? (
          <FileView
            machineId={machineId}
            root={root}
            rel={rel}
            content={shown}
            mode={mode}
            onMode={(m) => setMode(rel, m)}
            onOpen={onLink}
            find={findOpen && searchable && query ? { query, index, matchCase } : null}
            onFindStatus={setStatus}
            initialScroll={useFiles.getState().ws(key).scroll[rel] ?? 0}
            hash={jump}
            saveScroll={(r, top) => useFiles.getState().setScroll(key, r, top)}
            outline={outline}
            onOutline={setHasOutline}
          />
        ) : error && error.rel === rel ? (
          <div className="files-notice" role="alert">{error.message}</div>
        ) : null}
      </div>
    </>
  );
}
