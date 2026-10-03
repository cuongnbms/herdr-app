import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";
import { WEBGL_CONTEXTS, WebglLru, mayUseWebgl, recordLoss } from "./webglPolicy";

interface Addon {
  onContextLoss: (listener: () => void) => unknown;
  dispose(): void;
}

interface State {
  addon?: Addon;
  /** The addon's own context, kept to free it on release: the addon removes its canvas but leaves the context to GC. */
  gl?: WebGL2RenderingContext | null;
  losses: number[];
}

const states = new Map<string, State>();
const lru = new WebglLru(WEBGL_CONTEXTS);

function release(st: State): void {
  // Dispose first: it unhooks the addon's context-lost listener, so our own loseContext
  // below is not counted as a loss.
  st.addon?.dispose();
  st.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  st.addon = undefined;
  st.gl = undefined;
}

/**
 * Gives the terminal shown under `key` a WebGL renderer unless it already has one or keeps
 * losing its context; terminals pushed out of the LRU drop back to DOM. Call on every reveal.
 */
export function showWebgl(key: string, term: Terminal, make: () => Addon = () => new WebglAddon()): void {
  for (const k of lru.touch(key)) {
    const evicted = states.get(k);
    if (evicted) release(evicted);
  }
  let st = states.get(key);
  if (!st) {
    st = { losses: [] };
    states.set(key, st);
  }
  if (st.addon || !mayUseWebgl(st.losses, Date.now())) return;
  const before = new Set(term.element?.querySelectorAll("canvas") ?? []);
  let addon: Addon | undefined;
  try {
    addon = make();
    const own = st;
    addon.onContextLoss(() => {
      console.warn("xterm WebGL context lost; DOM renderer until the pane is shown again");
      own.losses = recordLoss(own.losses, Date.now());
      if (own.addon === addon) release(own);
    });
    term.loadAddon(addon as unknown as WebglAddon);
    st.addon = addon;
    // Only the addon's new canvases: getContext on a context-less canvas would create one.
    const added = [...(term.element?.querySelectorAll("canvas") ?? [])].filter((c) => !before.has(c));
    st.gl = added.map((c) => c.getContext("webgl2")).find(Boolean);
    if (import.meta.env.DEV) console.debug(`xterm WebGL contexts: ${activeWebgl()}`);
  } catch (e) {
    try {
      addon?.dispose();
    } catch {
      /* half-activated */
    }
    console.warn("xterm WebGL unavailable; using DOM renderer", e);
  }
}

/** Frees everything held for `key`; call when its terminal is disposed. */
export function forgetWebgl(key: string): void {
  const st = states.get(key);
  if (st) release(st);
  states.delete(key);
  lru.remove(key);
}

/** Terminals currently holding a WebGL renderer. */
export function activeWebgl(): number {
  let n = 0;
  for (const st of states.values()) if (st.addon) n++;
  return n;
}

export function lossesOf(key: string): number[] {
  return [...(states.get(key)?.losses ?? [])];
}
