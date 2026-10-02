import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

export interface Entry {
  term: Terminal;
  fit: FitAddon;
}

const cache = new Map<string, Entry>();
/** The token of the latest open of each entry: only that open's detach may dispose it. */
const owners = new Map<string, number>();
let nextToken = 1;

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
  owners.delete(key);
  e.term.dispose();
}

/** Mark a new open of `key`; returns its token. */
export function claim(key: string): number {
  const token = nextToken++;
  owners.set(key, token);
  return token;
}

/** Dispose `key` only if `token` is its latest open (a stale detach must not dispose it). */
export function disposeIf(key: string, token: number): boolean {
  if (owners.get(key) !== token) return false;
  dispose(key);
  return true;
}

export function size(): number {
  return cache.size;
}
