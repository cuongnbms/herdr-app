import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../fonts/fonts.css", () => ({}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    open() {}
    loadAddon() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    write(_d: unknown, cb?: () => void) {
      cb?.();
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("../terminal/unicode", () => ({ applyUnicode11: vi.fn() }));
vi.mock("../settings/theme", () => ({ watchTermTheme: () => () => {} }));
vi.mock("../settings/store", () => ({ watchTermFont: () => () => {} }));

let data: { onmessage: (b: ArrayBuffer) => void } | undefined;
vi.mock("../lib/ipc", () => ({
  connectOpen: vi.fn((_id, _c, _r, d) => {
    data = d;
    return Promise.resolve();
  }),
  connectAck: vi.fn(() => Promise.resolve()),
  connectWrite: vi.fn(() => Promise.resolve()),
  connectResize: vi.fn(() => Promise.resolve()),
  connectClose: vi.fn(() => Promise.resolve()),
  machineConnect: vi.fn(() => Promise.resolve()),
  machineMasterAlive: vi.fn(() => Promise.resolve(false)),
}));

const { ConnectDialog } = await import("./ConnectDialog");
const ipc = await import("../lib/ipc");

describe("ConnectDialog", () => {
  it("acks the ssh master's output so flow control never pauses it", async () => {
    render(<ConnectDialog machine={{ id: "m1", label: "box" } as never} onClose={() => {}} />);
    act(() => {
      data!.onmessage(new Uint8Array(3000).buffer);
      data!.onmessage(new Uint8Array(2000).buffer);
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(vi.mocked(ipc).connectAck).toHaveBeenCalledWith("m1", 5000);
  });
});
