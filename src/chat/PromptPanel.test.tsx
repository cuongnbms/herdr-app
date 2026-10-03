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
