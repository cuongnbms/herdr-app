import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({ herdrCall: vi.fn() }));
import { herdrCall } from "../lib/ipc";
import type { PaneView } from "../lib/types";
import { PromptPanel } from "./PromptPanel";

const pane = { machine_id: "devtuf", session: "default", pane_id: "w1:p1" };
const view = { status: "blocked", agent: "claude", title: "claude" } as PaneView;

const question = `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O (Recommended)
     Occlusion benchmark.
  2. YCB-V
     Household objects.
  3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const multi = `
←  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
  2. [ ] YCB-V
  3. [ ] T-LESS
  4. [ ] Type something
     Submit
────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

let shown = question;
const sent = () =>
  vi
    .mocked(herdrCall)
    .mock.calls.filter(([, , method]) => method !== "pane.read")
    .map(([, , method, params]) => [method, params]);

beforeEach(() => {
  shown = question;
  vi.mocked(herdrCall)
    .mockReset()
    .mockImplementation(async (_m, _s, method) => (method === "pane.read" ? { text: shown } : {}));
});

describe("PromptPanel", () => {
  it("shows Claude's question as a card and answers an option with the keys from the cursor", async () => {
    render(<PromptPanel pane={pane} view={view} />);
    expect(await screen.findByText("Which evaluation dataset should we use?")).toBeTruthy();
    expect(screen.getByText("Dataset")).toBeTruthy();
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.getByText("Household objects.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /YCB-V/ }));
    await waitFor(() =>
      expect(sent()).toEqual([
        ["agent.send_keys", { target: "w1:p1", keys: ["down"] }],
        ["agent.send_keys", { target: "w1:p1", keys: ["enter"] }],
      ]),
    );
  });

  it("reads the screen as plain text for the card", async () => {
    render(<PromptPanel pane={pane} view={view} />);
    await screen.findByText("Which evaluation dataset should we use?");
    expect(herdrCall).toHaveBeenCalledWith("devtuf", "default", "pane.read", {
      pane_id: "w1:p1",
      source: "visible",
      format: "text",
      strip_ansi: true,
    });
    expect(vi.mocked(herdrCall).mock.calls.some(([, , , p]) => (p as { format?: string }).format === "ansi")).toBe(false);
  });

  it("types an answer of one's own into the custom row", async () => {
    render(<PromptPanel pane={pane} view={view} />);
    const box = await screen.findByRole("textbox", { name: "Your own answer" });
    fireEvent.change(box, { target: { value: "BOP mix" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(sent()).toEqual([
        ["agent.send_keys", { target: "w1:p1", keys: ["down"] }],
        ["agent.send_keys", { target: "w1:p1", keys: ["down"] }],
        ["pane.send_text", { pane_id: "w1:p1", text: "BOP mix" }],
        ["agent.send_keys", { target: "w1:p1", keys: ["enter"] }],
      ]),
    );
  });

  it("ticks several options and submits them with →", async () => {
    shown = multi;
    render(<PromptPanel pane={pane} view={view} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /LM-O/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /T-LESS/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit (2)" }));
    await waitFor(() =>
      expect(sent().map(([, p]) => (p as { keys: string[] }).keys[0])).toEqual(["enter", "down", "down", "enter", "right"]),
    );
  });

  it("sends nothing when the screen changed under the card", async () => {
    render(<PromptPanel pane={pane} view={view} />);
    await screen.findByText("Which evaluation dataset should we use?");
    shown = question.replace("YCB-V", "T-LESS");
    fireEvent.click(screen.getByRole("button", { name: /YCB-V/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(sent()).toEqual([]);
    expect(screen.getByRole("button", { name: /T-LESS/ })).toBeTruthy();
  });
});

describe("PromptPanel without the fallback card", () => {
  const idlePi = { status: "idle", agent: "pi", title: "pi" } as PaneView;
  const picker = (cursor: 0 | 1) => `
>

${cursor === 0 ? "→" : " "} ✓ a-model [p] · default
${cursor === 1 ? "→" : " "}   b-model [p]

 Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel
────────────────────────
/tmp/app
`;

  it("shows pi's model picker as a card and moves the cursor before pressing Enter", async () => {
    shown = picker(0);
    vi.mocked(herdrCall).mockImplementation(async (_m, _s, method, params) => {
      if (method === "pane.read") return { text: shown };
      if ((params as { keys?: string[] }).keys?.[0] === "down") shown = picker(1);
      return {};
    });
    render(<PromptPanel pane={pane} view={idlePi} fallback={false} />);
    expect(await screen.findByText("Select model (currently a-model [p])")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /b-model/ }));
    await waitFor(() =>
      expect(sent()).toEqual([
        ["agent.send_keys", { target: "w1:p1", keys: ["down"] }],
        ["agent.send_keys", { target: "w1:p1", keys: ["enter"] }],
      ]),
    );
  });

  it("shows no fallback card for a screen no reader knows", async () => {
    // the fallback card opens the screen mirror, whose terminal asks for matchMedia
    window.matchMedia ??= ((query: string) =>
      ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList);
    shown = "Pick one\n\n❯ 1. One\n  2. Two\n\n Enter to select\n";
    render(<PromptPanel pane={pane} view={idlePi} fallback={false} />);
    await waitFor(() => expect(vi.mocked(herdrCall).mock.calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Waiting for/)).toBeNull();
    expect(screen.queryByRole("button", { name: /One/ })).toBeNull();
  });
});
