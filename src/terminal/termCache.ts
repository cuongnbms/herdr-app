import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

export interface Entry {
  term: Terminal;
  fit: FitAddon;
}

const cache = new Map<string, Entry>();

export function getOrCreate(key: string, factory: () => Entry): Entry {
  let e = cache.get(key);
  if (!e) {
    e = factory();
    cache.set(key, e);
  }
  return e;
}

export function dispose(key: string): void {
  const e = cache.get(key);
  if (!e) return;
  cache.delete(key);
  e.term.dispose();
}

export function size(): number {
  return cache.size;
}
