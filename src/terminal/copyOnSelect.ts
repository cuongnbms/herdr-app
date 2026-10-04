import type { Terminal } from "@xterm/xterm";

/** A drag changes the selection on every cell it crosses; copy once it has been still this long. */
export const COPY_SETTLE_MS = 150;

/**
 * Copies a selection as soon as it is made (Option+drag, double-click), so no Cmd+C is needed.
 * Debounced so a drag writes the clipboard once, not per cell. Returns a disposer.
 */
export function applyCopyOnSelect(term: Terminal, write: (text: string) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sub = term.onSelectionChange(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const text = term.getSelection();
      if (text) write(text);
    }, COPY_SETTLE_MS);
  });
  return () => {
    clearTimeout(timer);
    sub.dispose();
  };
}
