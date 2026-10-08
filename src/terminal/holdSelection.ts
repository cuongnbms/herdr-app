import type { Terminal } from "@xterm/xterm";

/**
 * Keeps an Option+drag selection while the mouse moves on. herdr asks for every mouse move, and
 * xterm counts each report as user input, which clears the selection (and can beat copy-on-select).
 * While there is a selection, a move with no button held never reaches xterm; a click, a key or
 * the wheel still goes to herdr and clears it as before. Returns a disposer.
 */
export function applyHoldSelection(term: Terminal): () => void {
  const onMove = (ev: MouseEvent) => {
    if (ev.buttons !== 0 || !term.hasSelection()) return;
    if (ev.target instanceof Node && term.element?.contains(ev.target)) ev.stopPropagation();
  };
  // Capture on window runs before xterm's own listener on its element.
  window.addEventListener("mousemove", onMove, true);
  return () => window.removeEventListener("mousemove", onMove, true);
}
