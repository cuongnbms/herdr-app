import type { PaneRef } from "../lib/types";
import { selectedPane, useApp } from "../store/app";
import { overlayRoot } from "../files/root";
import { filesKey, useFiles } from "../files/store";
import { showToast } from "../ui/Toast";

/** Extensions a bare file name (no folder) must end in to read as a file: `console.log` is code. */
const COMMON_EXT = new Set(
  ("md markdown mdx txt rst adoc json jsonc json5 yaml yml toml ini cfg conf env lock xml csv tsv sql graphql proto " +
    "ts tsx js jsx mjs cjs vue svelte astro css scss sass less html htm svg png jpg jpeg gif webp ico pdf " +
    "rs go py rb php java kt kts swift c h cc cpp hpp cs m mm dart lua zig ex exs erl hs ml scala clj " +
    "sh bash zsh fish ps1 bat nix tf hcl gradle dockerfile makefile mk cmake diff patch")
    .split(" "),
);

/** True when inline code reads as a file path: no spaces or code punctuation, a file extension,
 * and either a folder or a common extension. `/point`, `1.0.0` and `foo.bar()` stay code. */
export function looksLikePath(text: string): boolean {
  if (!/^[\w.\-/@+]+$/.test(text)) return false;
  const last = text.slice(text.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = last.slice(dot + 1);
  if (ext.length === 0 || ext.length > 12 || !/[A-Za-z]/.test(ext)) return false;
  if (text.includes("/")) return true;
  return dot > 0 && COMMON_EXT.has(ext.toLowerCase());
}

type Abs = { home: boolean; parts: string[] };

/** `p` (starting with `/` or `~`) as segments with `.` and `..` folded; null above the top. */
function normalize(p: string): Abs | null {
  const home = p.startsWith("~");
  const parts: string[] = [];
  for (const seg of p.slice(home ? 1 : 0).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return { home, parts };
}

/** An absolute path seen from a `~` root: its home folder, guessed from the usual places, becomes `~`. */
function fromHome(parts: string[]): string[] | null {
  if (parts[0] === "root") return parts.slice(1);
  if ((parts[0] === "home" || parts[0] === "Users") && parts.length >= 2) return parts.slice(2);
  return null;
}

/**
 * `path` as the Files overlay's `rel` under `root`; null when it is not below it. A relative
 * `path` is read from `cwd` (the agent's folder), or from the root when the pane has none.
 */
export function relUnderRoot(path: string, cwd: string | null, root: string): string | null {
  const base = cwd ?? root;
  const target = normalize(path.startsWith("/") ? path : `${base}/${path}`);
  const top = normalize(root);
  if (!target || !top) return null;
  let parts: string[] | null = target.parts;
  if (top.home && !target.home) parts = fromHome(parts);
  else if (!top.home && target.home) parts = null;
  if (!parts || parts.length <= top.parts.length) return null;
  if (top.parts.some((seg, i) => parts![i] !== seg)) return null;
  return parts.slice(top.parts.length).join("/");
}

/** Opens `path`, as the agent in `pane` wrote it, in its Workspace's Files overlay. */
export function openInFiles(pane: PaneRef, path: string): void {
  const state = useApp.getState();
  const found = selectedPane({ machines: state.machines, selected: pane });
  if (!found) return;
  const ref = { machine_id: pane.machine_id, session: pane.session, workspace_id: found.workspace.workspace_id };
  const root = overlayRoot(ref, state);
  const rel = root && relUnderRoot(path, found.pane.cwd, root.path);
  if (!root || !rel) {
    showToast(root ? `${path} is outside the workspace folder` : "This workspace has no folder");
    return;
  }
  useFiles.getState().open(filesKey(ref, root.path), rel, { pin: false });
  state.setFilesOverlay(ref);
}
