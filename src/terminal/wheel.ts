import type { Terminal } from "@xterm/xterm";

/** Wheel reports per cell height of travel in herdr's mouse mode; raise to scroll faster. */
export const SCROLL_SENSITIVITY = 1;

/** Extra multiplier with Option held, matching xterm's own fastScrollSensitivity default. */
export const FAST_SCROLL_SENSITIVITY = 5;

/** A pause long enough that the next wheel event starts a new gesture. */
const GESTURE_GAP_MS = 200;

/**
 * Turns wheel events into whole lines, carrying the fraction to the next event, so a trackpad
 * moves one line per cell height of travel. The first event of a gesture scrolls at least one
 * line, so a mouse notch smaller than a cell still moves.
 */
export function createWheelLines(now: () => number = () => performance.now()) {
  let carry = 0;
  let dir = 0;
  let last = -Infinity;
  return (ev: WheelEvent, cellHeight: number, rows: number): number => {
    const scale = SCROLL_SENSITIVITY * (ev.altKey ? FAST_SCROLL_SENSITIVITY : 1);
    let amount: number;
    if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) amount = ev.deltaY * scale;
    else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) amount = ev.deltaY * rows * scale;
    else amount = (ev.deltaY / cellHeight) * scale;
    const t = now();
    const fresh = t - last > GESTURE_GAP_MS || Math.sign(amount) !== dir;
    last = t;
    dir = Math.sign(amount);
    if (fresh) carry = 0;
    carry += amount;
    let lines = Math.trunc(carry) || 0;
    // Rounding up leaves a negative carry that the rest of the gesture pays back.
    if (lines === 0 && fresh) lines = dir;
    carry -= lines;
    return Math.max(-rows, Math.min(rows, lines));
  };
}

/** SGR (mode 1006) wheel reports for `lines` (negative is up) at 1-based `col`, `row`. */
export function sgrWheelReports(lines: number, col: number, row: number): string {
  const button = lines < 0 ? 64 : 65;
  return `\x1b[<${button};${col};${row}M`.repeat(Math.abs(lines));
}

/**
 * Scrolls herdr by one wheel report per line travelled. In mouse mode xterm sends one report per
 * wheel event however far it moved and damps trackpads to 0.3x, so a swipe crawls. Reports are
 * only written for SGR encoding (herdr's); other encodings, Shift (horizontal) and Ctrl (pinch
 * zoom) keep xterm's handling.
 */
export function applyWheelScroll(term: Terminal, lines = createWheelLines()): void {
  let sgr = false;
  const watch = (on: boolean) => (params: (number | number[])[]) => {
    if (params.includes(1006)) sgr = on;
    return false;
  };
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, watch(true));
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, watch(false));
  term.attachCustomWheelEventHandler((ev) => {
    if (term.modes.mouseTrackingMode === "none" || !sgr) return true;
    if (ev.deltaY === 0 || ev.shiftKey || ev.ctrlKey) return true;
    const rect = term.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return true;
    const cellHeight = rect.height / term.rows;
    const n = lines(ev, cellHeight, term.rows);
    if (n !== 0) {
      const col = Math.min(term.cols, Math.max(1, Math.floor((ev.clientX - rect.left) / (rect.width / term.cols)) + 1));
      const row = Math.min(term.rows, Math.max(1, Math.floor((ev.clientY - rect.top) / cellHeight) + 1));
      term.input(sgrWheelReports(n, col, row), false);
    }
    return false;
  });
}
