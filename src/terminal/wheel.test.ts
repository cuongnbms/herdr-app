import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { applyWheelScroll, createWheelLines, FAST_SCROLL_SENSITIVITY, SCROLL_SENSITIVITY, sgrWheelReports } from "./wheel";

const wheel = (deltaY: number, init: WheelEventInit = {}) =>
  new WheelEvent("wheel", { deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL, ...init });

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createWheelLines", () => {
  it("scrolls one line per cell height of pixel travel, carrying the fraction", () => {
    const c = clock();
    const lines = createWheelLines(c.now);
    expect(lines(wheel(50), 20, 24)).toBe(2);
    c.advance(16);
    expect(lines(wheel(10), 20, 24)).toBe(1);
  });

  it("moves at least one line on the first event of a gesture, then pays it back", () => {
    const c = clock();
    const lines = createWheelLines(c.now);
    expect(lines(wheel(4), 20, 24)).toBe(1);
    c.advance(16);
    expect(lines(wheel(4), 20, 24)).toBe(0);
    c.advance(500);
    expect(lines(wheel(-4), 20, 24)).toBe(-1);
  });

  it("drops the carry when the direction flips", () => {
    const c = clock();
    const lines = createWheelLines(c.now);
    lines(wheel(30), 20, 24);
    c.advance(16);
    expect(lines(wheel(-10), 20, 24)).toBe(-1);
  });

  it("multiplies with Option held", () => {
    const lines = createWheelLines(clock().now);
    expect(lines(wheel(40, { altKey: true }), 20, 24)).toBe(2 * SCROLL_SENSITIVITY * FAST_SCROLL_SENSITIVITY);
  });

  it("handles line and page deltas and caps at one screen", () => {
    const lines = createWheelLines(clock().now);
    expect(lines(wheel(3, { deltaMode: WheelEvent.DOM_DELTA_LINE }), 20, 24)).toBe(3);
    expect(lines(wheel(1, { deltaMode: WheelEvent.DOM_DELTA_PAGE }), 20, 24)).toBe(24);
    expect(lines(wheel(5000), 20, 24)).toBe(24);
  });
});

describe("sgrWheelReports", () => {
  it("repeats the wheel up or down report once per line", () => {
    expect(sgrWheelReports(-2, 3, 4)).toBe("\x1b[<64;3;4M\x1b[<64;3;4M");
    expect(sgrWheelReports(1, 1, 1)).toBe("\x1b[<65;1;1M");
  });
});

describe("applyWheelScroll", () => {
  async function setup() {
    const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
    let handler: (ev: WheelEvent) => boolean = () => true;
    vi.spyOn(term, "attachCustomWheelEventHandler").mockImplementation((h) => (handler = h));
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 480 }) as DOMRect;
    const element = document.createElement("div");
    element.appendChild(screen);
    Object.defineProperty(term, "element", { get: () => element });
    const input = vi.fn();
    term.onData(input);
    applyWheelScroll(term, () => 2);
    const write = (s: string) => new Promise<void>((r) => term.write(s, r));
    return { term, input, write, wheel: (ev: WheelEvent) => handler(ev) };
  }

  it("sends a report per line at the pointer cell once herdr turns on SGR mouse mode", async () => {
    const { input, write, wheel: send } = await setup();
    await write("\x1b[?1000h\x1b[?1006h");
    expect(send(wheel(40, { clientX: 25, clientY: 45 }))).toBe(false);
    expect(input).toHaveBeenCalledWith("\x1b[<65;3;3M\x1b[<65;3;3M");
  });

  it("leaves the wheel to xterm without mouse mode, without SGR, or with Shift or Ctrl", async () => {
    const { input, write, wheel: send } = await setup();
    expect(send(wheel(40))).toBe(true);
    await write("\x1b[?1000h");
    expect(send(wheel(40))).toBe(true);
    await write("\x1b[?1006h");
    expect(send(wheel(40, { shiftKey: true }))).toBe(true);
    expect(send(wheel(40, { ctrlKey: true }))).toBe(true);
    await write("\x1b[?1006l");
    expect(send(wheel(40))).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });
});
