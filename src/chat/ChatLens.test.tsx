import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]), Channel: class {} }));
vi.mock("../lib/ipc", () => ({
  herdrCall: vi.fn(),
  chatPage: vi.fn().mockResolvedValue([]),
  imageSaveTemp: vi.fn(),
  completeCommands: vi.fn().mockResolvedValue([]),
  completeFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock("./chatSession", () => ({
  openChat: () => ({ opened: new Promise(() => {}), close: () => {} }),
  onOpenFailure: () => "error",
  watchMachine: () => ({ sawDown: false, reopen: false }),
}));
import { herdrCall } from "../lib/ipc";
import type { PaneView } from "../lib/types";
import { ChatLens } from "./ChatLens";

const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const idlePi = { status: "idle", agent: "pi", title: "pi" } as PaneView;
const picker = `
>

→ ✓ a-model [p] · default
    b-model [p]

 Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel
────────────────────────
/tmp/app
`;

let shown = "";

beforeEach(() => {
  localStorage.clear();
  shown = "";
  vi.mocked(herdrCall)
    .mockReset()
    .mockImplementation(async (_m, _s, method) => {
      if (method === "agent.prompt") shown = picker;
      return method === "pane.read" ? { text: shown } : {};
    });
});

describe("ChatLens", () => {
  it("shows pi's model picker as a card once /model is sent, though pi stays idle", async () => {
    render(<ChatLens pane={pane} view={idlePi} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/model" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Select model (currently a-model [p])")).toBeTruthy();
    expect(screen.getByRole("button", { name: /b-model/ })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/Waiting for/)).toBeNull();
  });

  it("does not read the screen of an idle pi Pane that was sent no /model", async () => {
    shown = picker;
    render(<ChatLens pane={pane} view={idlePi} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(herdrCall).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("goes back to the Composer once the picker closes", async () => {
    render(<ChatLens pane={pane} view={idlePi} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/model" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText("Select model (currently a-model [p])");
    shown = "";
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy(), { timeout: 3000 });
  });

  it("forgets the /model it was sent once the Pane changes", async () => {
    // the picker never shows, so the Pane stays armed until the change
    vi.mocked(herdrCall).mockImplementation(async (_m, _s, method) => (method === "pane.read" ? { text: "" } : {}));
    const other = { ...pane, pane_id: "w1:p2" };
    const { rerender } = render(<ChatLens pane={pane} view={idlePi} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "/model" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(vi.mocked(herdrCall).mock.calls.some(([, , m]) => m === "pane.read")).toBe(true));
    vi.mocked(herdrCall).mockClear();
    rerender(<ChatLens pane={other} view={idlePi} />);
    rerender(<ChatLens pane={pane} view={idlePi} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(herdrCall).mock.calls.filter(([, , m]) => m === "pane.read")).toEqual([]);
  });
});
