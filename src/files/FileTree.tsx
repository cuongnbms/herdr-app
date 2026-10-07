import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { filesListDir } from "../lib/ipc";
import type { FileEntry } from "../lib/types";
import { useFiles } from "./store";

interface Props {
  machineId: string;
  root: string;
  wsKey: string;
  onOpen: (rel: string, pin: boolean) => void;
  /** Changing it refetches the root and every expanded folder. */
  reloadKey: number;
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

export function FileTree({ machineId, root, wsKey, onOpen, reloadKey }: Props) {
  const expanded = useFiles((s) => s.byWs[wsKey]?.expanded ?? NO_DIRS);
  const toggleDir = useFiles((s) => s.toggleDir);
  const [entries, setEntries] = useState<Record<string, FileEntry[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const gen = useRef(0);
  const inflight = useRef(new Set<string>());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const treeRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    (rel: string) => {
      const g = gen.current;
      inflight.current.add(rel);
      filesListDir(machineId, root, rel).then(
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
    [machineId, root],
  );

  // A different root starts from nothing.
  useEffect(() => {
    setEntries({});
    setErrors({});
  }, [machineId, root]);

  // Initial mount, a new root, or a reload: refetch the root and open folders.
  useEffect(() => {
    gen.current++;
    inflight.current.clear();
    for (const rel of ["", ...expandedRef.current]) load(rel);
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
        if (!open) toggleDir(wsKey, rel);
        else if (all[at + 1] && Number(all[at + 1].getAttribute("aria-level")) > Number(el.getAttribute("aria-level"))) all[at + 1].focus();
        break;
      case "ArrowLeft": {
        e.preventDefault();
        if (isDir && open) {
          toggleDir(wsKey, rel);
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
        if (isDir) toggleDir(wsKey, rel);
        else onOpen(rel, true);
        break;
    }
  };

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
            tabIndex={-1}
            aria-level={depth + 1}
            aria-expanded={isDir ? open : undefined}
            data-rel={rel}
            data-kind={ent.kind}
            className={`files-tree-row ${kindClass(ent.kind)}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={(e) => {
              // The second click of a double click would collapse what the first expanded.
              if (isDir) {
                if (e.detail <= 1) toggleDir(wsKey, rel);
              } else onOpen(rel, false);
            }}
            onDoubleClick={() => {
              if (!isDir) onOpen(rel, true);
            }}
          >
            <span className="files-tree-caret">{isDir ? (open ? "▾" : "▸") : ""}</span>
            <span className="files-tree-name">{ent.name}</span>
          </div>
          {open && renderDir(rel, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="files-tree" role="tree" ref={treeRef} onKeyDown={onKeyDown}>
      {renderDir("", 0)}
    </div>
  );
}
