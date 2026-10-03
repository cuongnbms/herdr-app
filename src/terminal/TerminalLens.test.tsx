import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachEvent, MachineState } from "../lib/types";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../fonts/fonts.css", () => ({}));

const terms: FakeTerminal[] = [];
class FakeTerminal {
  element: HTMLElement | undefined;
  cols = 80;
  rows = 24;
  disposed = false;
  constructor() {
    terms.push(this);
  }
  open(container: HTMLElement) {
    this.element = document.createElement("div");
    container.appendChild(this.element);
  }
  loadAddon() {}
  attachCustomKeyEventHandler() {}
  onData() {
    return { dispose() {} };
  }
  onResize() {
    return { dispose() {} };
  }
  written = 0;
  write(d: Uint8Array, cb?: () => void) {
    this.written += d.byteLength;
    cb?.();
  }
  clearTextureAtlas() {}
  refresh() {}
  dispose() {
    this.disposed = true;
  }
}
vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("./unicode", () => ({ applyUnicode11: vi.fn() }));
vi.mock("./osc52", () => ({ applyOsc52: vi.fn() }));
vi.mock("./wheel", () => ({ applyWheelScroll: vi.fn() }));
vi.mock("./webgl", () => ({ showWebgl: vi.fn(), forgetWebgl: vi.fn() }));
vi.mock("../settings/theme", () => ({ watchTermTheme: () => () => {} }));
vi.mock("../settings/store", () => ({
  ensureTermFont: () => Promise.resolve(),
  watchTermFont: () => () => {},
  useSettings: { getState: () => ({ terminalFontFamily: "mono" }) },
}));

let machine: MachineState = "connected";
vi.mock("../store/app", () => ({
  useApp: (sel: (s: unknown) => unknown) => sel({ machines: { m1: { state: machine } } }),
}));

interface Opened {
  takeover: boolean;
  data: { onmessage: (b: ArrayBuffer) => void };
  events: { onmessage: (e: AttachEvent) => void };
}
const opens: Opened[] = [];
vi.mock("../lib/ipc", async (orig) => ({
  ...(await orig<typeof import("../lib/ipc")>()),
  termOpen: vi.fn((_k, _c, _r, takeover: boolean, data, events) => {
    opens.push({ takeover, data, events });
    return Promise.resolve();
  }),
  termWrite: vi.fn(() => Promise.resolve()),
  termAck: vi.fn(() => Promise.resolve()),
  termResize: vi.fn(() => Promise.resolve()),
  termRelease: vi.fn(() => Promise.resolve()),
}));

const { TerminalLens } = await import("./TerminalLens");
const { size } = await import("./termCache");

const pane = { machine_id: "m1", session: "s", pane_id: "p1" } as never;
let n = 0;
let baseline = 0;

const send = (ev: AttachEvent) => act(() => opens[opens.length - 1].events.onmessage(ev));
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  machine = "connected";
  terms.length = 0;
  opens.length = 0;
  baseline = size();
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as never;
});

afterEach(async () => {
  // Unmount here and let deferred disposes run, so they cannot shift the next test's baseline.
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
  vi.clearAllMocks();
});

// Each test uses its own terminal id so entries left cached by one cannot leak into another.
const mount = () => render(<TerminalLens pane={pane} terminalId={`t${n++}`} />);

describe("TerminalLens xterm lifetime", () => {
  it("keeps the xterm of a visible pane whose process exited", async () => {
    mount();
    send({ type: "exited", code: 1 });
    await settle();
    expect(size()).toBe(baseline + 1);
    expect(terms[0].disposed).toBe(false);
  });

  it("frees the xterm when the process exits while the pane is hidden", async () => {
    const { unmount } = mount();
    unmount();
    await settle();
    expect(size()).toBe(baseline + 1);
    send({ type: "exited", code: 1 });
    expect(size()).toBe(baseline);
    expect(terms[0].disposed).toBe(true);
  });

  it("frees the xterm when the attach is held while the pane is hidden", async () => {
    const { unmount } = mount();
    unmount();
    send({ type: "held" });
    expect(size()).toBe(baseline);
  });

  it("frees an exited xterm once its pane is hidden", async () => {
    const { unmount } = mount();
    send({ type: "exited", code: 1 });
    unmount();
    await settle();
    expect(size()).toBe(baseline);
  });

  it("reattach after an exit reuses the xterm and its scrollback", async () => {
    machine = "error";
    mount();
    send({ type: "exited", code: 255 });
    fireEvent.click(screen.getByText("Reattach"));
    await settle();
    expect(opens).toHaveLength(2);
    expect(terms).toHaveLength(1);
    expect(terms[0].disposed).toBe(false);
    expect(size()).toBe(baseline + 1);
  });

  it("still shows the output that follows a held attach", async () => {
    mount();
    send({ type: "held" });
    act(() => opens[0].data.onmessage(new Uint8Array(5).buffer));
    expect(terms[0].written).toBe(5);
  });

  it("take over reuses the xterm and starts a fresh open", async () => {
    const { unmount } = mount();
    send({ type: "held" });
    fireEvent.click(screen.getByText("Take over"));
    expect(opens.map((o) => o.takeover)).toEqual([false, true]);
    // The take-over open is live, so hiding the pane keeps the xterm cached and streaming.
    unmount();
    await settle();
    expect(terms).toHaveLength(1);
    expect(size()).toBe(baseline + 1);
  });
});
