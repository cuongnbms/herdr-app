import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

export interface Entry {
  term: Terminal;
  fit: FitAddon;
  /** Runs before the terminal is disposed. */
  cleanup?: () => void;
}

const cache = new Map<string, Entry>();
/** The token of the latest open of each entry: only that open's detach may dispose it. */
const owners = new Map<string, number>();
let nextToken = 1;

/** Every entry under `key` must come from the same factory, which fixes its type. */
export function getOrCreate<E extends Entry>(key: string, factory: () => E): E {
  let e = cache.get(key) as E | undefined;
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
  e.cleanup?.();
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
