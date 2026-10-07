import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { filesListDir } from "../lib/ipc";
import type { FileEntry } from "../lib/types";
import { ContextMenu, type MenuItem } from "../sidebar/ContextMenu";
import { ArrowDownIcon, ArrowUpIcon, ChevronIcon, FileIcon, FolderIcon, FolderInputIcon, FolderOpenIcon } from "../ui/icons";
import { startDownload, startUpload } from "./transfer";
import { useFiles } from "./store";
import { copyItems } from "./treeMenu";

interface Props {
  machineId: string;
  root: string;
  filesKey: string;
  onOpen: (rel: string, pin: boolean) => void;
  /** Changing it refetches the root and every expanded folder. */
  reloadKey: number;
  /** Lists heavy folders (`.git`, `node_modules`…) too; changing it refetches like `reloadKey`. */
  showHeavy?: boolean;
}

const NO_DIRS: string[] = [];

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const isFolder = (kind: string | undefined) => kind === "dir" || kind === "dirlink";
/** A linked folder looks like a folder, named like a symlink. */
const kindClass = (kind: FileEntry["kind"]) => (kind === "dirlink" ? "files-tree-dir files-tree-symlink" : `files-tree-${kind}`);

export function FileTree({ machineId, root, filesKey, onOpen, reloadKey, showHeavy = false }: Props) {
  const expanded = useFiles((s) => s.byWs[filesKey]?.expanded ?? NO_DIRS);
  const toggleDir = useFiles((s) => s.toggleDir);
  const [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** The item Tab lands on: the last focused one, else the first. */
  const [focusRel, setFocusRel] = useState<string | null>(null);
  // A different root starts from nothing, reset while rendering so the old root's entries
  // are never committed under the new one.
  const scope = `${machineId}\0${root}`;
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setEntries({});
    setErrors({});
    setFocusRel(null);
  }
  /** The open context menu: the row it belongs to (null for the tree's empty space) and the folder an Upload goes into. */
  const [menu, setMenu] = useState<{ x: number; y: number; rel: string | null; dir: string } | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const gen = useRef(0);
  const inflight = useRef(new Set<string>());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const treeRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    (rel: string) => {
      const g = gen.current;
      inflight.current.add(rel);
      filesListDir(machineId, root, rel, showHeavy).then(
        (list) => {
          if (g !== gen.current) return;
          inflight.current.delete(rel);
          setEntries((m) => ({ ...m, [rel]: list }));
          setErrors(({ [rel]: _drop, ...rest }) => rest);
        },
        (e) => {
          if (g !== gen.current) return;
          inflight.current.delete(rel);
          setErrors((m) => ({ ...m, [rel]: errMessage(e) }));
        },
      );
    },
    [machineId, root, showHeavy],
  );

  // Initial mount, a new root, or a reload: refetch the root and open folders. Children of
  // collapsed folders are dropped, so expanding one later lists it afresh.
  useEffect(() => {
    gen.current++;
    inflight.current.clear();
    const keep = new Set(["", ...expandedRef.current]);
    const open = <T,>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => keep.has(k)));
    setEntries(open);
    setErrors(open);
    for (const rel of keep) load(rel);
  }, [load, reloadKey]);

  // First expand of a folder loads it.
  useEffect(() => {
    for (const rel of expanded) {
      if (!(rel in entries) && !(rel in errors) && !inflight.current.has(rel)) load(rel);
    }
  }, [expanded, entries, errors, load]);

  const retry = (rel: string) => {
    setErrors(({ [rel]: _drop, ...rest }) => rest);
    load(rel);
  };

  const upload = async (dir: string, directory: boolean) => {
    const startedIn = scopeRef.current;
    const picked = await openDialog({ multiple: true, directory });
    if (picked === null) return;
    const paths = typeof picked === "string" ? [picked] : picked;
    // The root may have changed during the dialog or the transfer; its listing is not ours to refresh.
    if ((await startUpload(machineId, root, dir, paths)) && scopeRef.current === startedIn) load(dir);
  };

  const menuItems = (m: { rel: string | null; dir: string }): MenuItem[] => {
    const list: MenuItem[] = [
      ...(m.rel !== null ? copyItems(root, m.rel) : []),
      { label: "Upload Files…", icon: ArrowUpIcon, onSelect: () => void upload(m.dir, false) },
      { label: "Upload Folder…", icon: FolderInputIcon, onSelect: () => void upload(m.dir, true) },
    ];
    const rel = m.rel;
    if (rel !== null) list.push({ label: "Download", icon: ArrowDownIcon, onSelect: () => void startDownload(machineId, root, rel) });
    return list;
  };

  const items = () => Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!el) return;
    const all = items();
    const at = all.indexOf(el);
    const rel = el.dataset.rel ?? "";
    const isDir = isFolder(el.dataset.kind);
    const open = el.getAttribute("aria-expanded") === "true";
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        all[Math.min(at + 1, all.length - 1)]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        all[Math.max(at - 1, 0)]?.focus();
        break;
      case "ArrowRight":
        e.preventDefault();
        if (!isDir) break;
        if (!open) toggleDir(filesKey, rel);
        else if (all[at + 1] && Number(all[at + 1].getAttribute("aria-level")) > Number(el.getAttribute("aria-level"))) all[at + 1].focus();
        break;
      case "ArrowLeft": {
        e.preventDefault();
        if (isDir && open) {
          toggleDir(filesKey, rel);
          break;
        }
        const level = Number(el.getAttribute("aria-level"));
        for (let i = at - 1; i >= 0; i--) {
          if (Number(all[i].getAttribute("aria-level")) < level) {
            all[i].focus();
            break;
          }
        }
        break;
      }
      case "Enter":
        e.preventDefault();
        if (isDir) toggleDir(filesKey, rel);
        else onOpen(rel, true);
        break;
    }
  };

  // Visible items in order, for the roving tab stop.
  const visible: string[] = [];
  const walkVisible = (dir: string) => {
    if (errors[dir] !== undefined) return;
    for (const ent of entries[dir] ?? []) {
      const rel = join(dir, ent.name);
      visible.push(rel);
      if (isFolder(ent.kind) && expanded.includes(rel)) walkVisible(rel);
    }
  };
  walkVisible("");
  const tabStop = focusRel !== null && visible.includes(focusRel) ? focusRel : (visible[0] ?? null);

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    if (errors[dir] !== undefined) {
      return (
        <div className="files-tree-error" style={{ paddingLeft: 8 + depth * 14 }}>
          <span>Could not list: {errors[dir]}</span>
          <button type="button" onClick={() => retry(dir)}>
            Retry
          </button>
        </div>
      );
    }
    return (entries[dir] ?? []).map((ent) => {
      const rel = join(dir, ent.name);
      const isDir = isFolder(ent.kind);
      const open = isDir && expanded.includes(rel);
      return (
        <div key={rel} role="none">
          <div
            role="treeitem"
            tabIndex={rel === tabStop ? 0 : -1}
            onFocus={() => setFocusRel(rel)}
            aria-level={depth + 1}
            aria-expanded={isDir ? open : undefined}
            data-rel={rel}
            data-kind={ent.kind}
            className={`files-tree-row ${kindClass(ent.kind)}${open ? " open" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={(e) => {
              // The second click of a double click would collapse what the first expanded.
              if (isDir) {
                if (e.detail <= 1) toggleDir(filesKey, rel);
              } else onOpen(rel, false);
            }}
            onDoubleClick={() => {
              if (!isDir) onOpen(rel, true);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, rel, dir: isDir ? rel : dir });
            }}
          >
            {/* Files keep the chevron's width, so names line up across a level. */}
            <span className="files-tree-caret">{isDir && <ChevronIcon data-icon="chevron" />}</span>
            {isDir ? (
              open ? (
                <FolderOpenIcon className="icon files-tree-icon" data-icon="folder-open" />
              ) : (
                <FolderIcon className="icon files-tree-icon" data-icon="folder" />
              )
            ) : (
              <FileIcon className="icon files-tree-icon" data-icon="file" />
            )}
            <span className="files-tree-name">{ent.name}</span>
          </div>
          {open && renderDir(rel, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      className="files-tree"
      role="tree"
      ref={treeRef}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        // React bubbles events from the portalled menu here too; only the tree's own space counts.
        if (!treeRef.current?.contains(e.target as Node)) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, rel: null, dir: "" });
      }}
    >
      {renderDir("", 0)}
      {/* Fixed to the window rather than to an animating ancestor. */}
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />, document.body)}
    </div>
  );
}
