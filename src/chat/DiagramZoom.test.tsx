import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), parse: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { ChatItemView } from "./ChatItemView";
import { clearMermaidCache } from "./MermaidBlock";
import { MarkdownView } from "../files/MarkdownView";

const md = "Here:\n\n```mermaid\ngraph TD; A-->B\n```\n";

describe("mermaid diagram zoom", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMermaidCache();
    mermaid.parse.mockResolvedValue({ diagramType: "flowchart" });
    mermaid.render.mockResolvedValue({ svg: '<svg viewBox="0 0 400 200"><text>A</text></svg>' });
  });

  const filesView = () =>
    render(<MarkdownView machineId="m" root="/r" rel="a.md" text={md} onOpen={() => {}} initialScroll={0} saveScroll={() => {}} />);

  it("clicking a diagram in the Files view opens it full-window; Esc closes it", async () => {
    filesView();
    fireEvent.click(await screen.findByRole("button", { name: "Zoom diagram" }));
    const dialog = screen.getByRole("dialog", { name: "Diagram" });
    // A copy at the diagram's natural size, so the one in the document stays put.
    const copy = dialog.querySelector(".diagram-zoom-content svg")!;
    expect(copy.getAttribute("width")).toBe("400");
    expect(copy.getAttribute("height")).toBe("200");
    expect(dialog.classList.contains("overlay")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Diagram" })).toBeNull();
  });

  it("Enter on a focused diagram opens it too", async () => {
    filesView();
    fireEvent.keyDown(await screen.findByRole("button", { name: "Zoom diagram" }), { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Diagram" })).toBeTruthy();
  });

  it("chat diagrams zoom too", async () => {
    render(<ChatItemView item={{ kind: "assistant_text", markdown: md }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Zoom diagram" }));
    expect(screen.getByRole("dialog", { name: "Diagram" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Diagram" })).toBeNull();
  });
});
