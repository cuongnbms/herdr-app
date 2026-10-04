import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]), Channel: class {} }));
vi.mock("../lib/ipc", () => ({
  herdrCall: vi.fn(),
  chatPage: vi.fn().mockResolvedValue([]),
  chatLocate: vi.fn(() => opened),
  imageSaveTemp: vi.fn(),
  completeCommands: vi.fn().mockResolvedValue([]),
  completeFiles: vi.fn().mockResolvedValue([]),
}));
let opened: Promise<unknown> = new Promise(() => {});
const channels = vi.hoisted(() => [] as { onmessage: (ev: unknown) => void }[]);
vi.mock("./chatSession", () => ({
  openChat: (_p: unknown, _path: unknown, ch: { onmessage: (ev: unknown) => void }) => {
    channels.push(ch);
    return { opened, close: () => {} };
  },
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
  opened = new Promise(() => {});
  channels.length = 0;
  shown = "";
  vi.mocked(herdrCall)
    .mockReset()
    .mockImplementation(async (_m, _s, method) => {
      if (method === "agent.prompt") shown = picker;
      return method === "pane.read" ? { text: shown } : {};
    });
});

describe("ChatLens", () => {
  it("lets a new Claude be chatted with before its transcript exists", async () => {
    opened = Promise.resolve({ agent: "claude", path: "/h/sid.jsonl", ambiguous: false, candidates: ["/h/sid.jsonl"], pending: true });
    render(<ChatLens pane={pane} view={{ status: "idle", agent: "claude", title: "claude" } as PaneView} />);
    expect(await screen.findByText(/first message/)).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

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

  it("says the transcript is loading until the first reset or error", () => {
    const { unmount } = render(<ChatLens pane={pane} view={idlePi} />);
    expect(screen.getByText("Loading transcript…")).toBeTruthy();
    act(() => channels[channels.length - 1].onmessage({ type: "reset", items: [], total: 0 }));
    expect(screen.queryByText("Loading transcript…")).toBeNull();
    unmount();
    render(<ChatLens pane={pane} view={idlePi} />);
    act(() => channels[channels.length - 1].onmessage({ type: "error", error: { code: "io", message: "gone" } }));
    expect(screen.queryByText("Loading transcript…")).toBeNull();
  });

  it("outlines the user turns beside the transcript", () => {
    render(<ChatLens pane={pane} view={idlePi} />);
    const items = [
      { kind: "user", text: "fix the header" },
      { kind: "assistant_text", markdown: "done" },
      { kind: "user", text: "now the footer" },
    ];
    act(() => channels[channels.length - 1].onmessage({ type: "reset", items, total: items.length }));
    const nav = screen.getByRole("navigation", { name: "Conversation outline" });
    expect([...nav.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["fix the header", "now the footer"]);
  });

  it("keeps the turn picked in the outline lit until the transcript is scrolled", () => {
    const { container } = render(<ChatLens pane={pane} view={idlePi} />);
    const items = [
      { kind: "user", text: "fix the header" },
      { kind: "assistant_text", markdown: "done" },
      { kind: "user", text: "now the footer" },
    ];
    act(() => channels[channels.length - 1].onmessage({ type: "reset", items, total: items.length }));
    const lit = () => screen.getByRole("navigation", { name: "Conversation outline" }).querySelector("[aria-current]")?.textContent;
    expect(lit()).toBe("fix the header");
    fireEvent.click(screen.getByRole("button", { name: "now the footer" }));
    expect(lit()).toBe("now the footer");
    fireEvent.wheel(container.querySelector(".chat-scroll")!);
    expect(lit()).toBe("fix the header");
  });
});
