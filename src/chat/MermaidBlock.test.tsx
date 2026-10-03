import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: mermaid }));
vi.mock("../lib/ipc", () => ({ chatImage: vi.fn(), setWindowTheme: vi.fn() }));
import { ChatItemView } from "./ChatItemView";

const md = (src: string) => "Here:\n\n```mermaid\n" + src + "\n```\n";

describe("mermaid blocks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mermaid.parse.mockResolvedValue({ diagramType: "flowchart" });
    mermaid.render.mockResolvedValue({ svg: '<svg data-testid="diagram"></svg>' });
  });

  it("renders a mermaid fence as a diagram", async () => {
    const { container } = render(<ChatItemView item={{ kind: "assistant_text", markdown: md("graph TD; A-->B") }} />);
    await waitFor(() => expect(container.querySelector(".chat-mermaid svg")).not.toBeNull());
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "graph TD; A-->B");
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", startOnLoad: false }));
  });

  it("keeps showing the source while the diagram does not parse", async () => {
    mermaid.parse.mockResolvedValue(false);
    render(<ChatItemView item={{ kind: "assistant_text", markdown: md("graph TD; A-->") }} />);
    await waitFor(() => expect(mermaid.parse).toHaveBeenCalled());
    expect(screen.getByText("graph TD; A-->")).toBeTruthy();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("falls back to the source when rendering throws", async () => {
    mermaid.render.mockRejectedValue(new Error("boom"));
    const { container } = render(<ChatItemView item={{ kind: "assistant_text", markdown: md("graph TD; A-->B") }} />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
    expect(container.querySelector(".chat-mermaid svg")).toBeNull();
    expect(screen.getByText("graph TD; A-->B")).toBeTruthy();
  });

  it("toggles between the diagram and its source", async () => {
    const { container } = render(<ChatItemView item={{ kind: "assistant_text", markdown: md("graph TD; A-->B") }} />);
    await waitFor(() => expect(container.querySelector(".chat-mermaid svg")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText("graph TD; A-->B")).toBeTruthy();
    expect(container.querySelector(".chat-mermaid svg")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Diagram" }));
    expect(container.querySelector(".chat-mermaid svg")).not.toBeNull();
  });

  it("leaves other languages as plain code blocks", () => {
    const { container } = render(<ChatItemView item={{ kind: "assistant_text", markdown: "```ts\nconst a = 1;\n```" }} />);
    expect(container.querySelector(".chat-mermaid")).toBeNull();
    expect(container.querySelector(".chat-code-head")?.textContent).toBe("ts");
    expect(mermaid.parse).not.toHaveBeenCalled();
  });

  it("forbids <img> and keeps mermaid's <style> ban in diagram labels", async () => {
    render(<ChatItemView item={{ kind: "assistant_text", markdown: md("graph TD; A-->B") }} />);
    await waitFor(() => expect(mermaid.initialize).toHaveBeenCalled());
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ dompurifyConfig: expect.objectContaining({ FORBID_TAGS: expect.arrayContaining(["img", "style"]) }) }),
    );
  });

  it("removes SVG <image> elements from the rendered diagram", async () => {
    mermaid.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/><g data-testid="kept"><rect/></g></svg>',
    });
    const { container } = render(<ChatItemView item={{ kind: "assistant_text", markdown: md("graph TD; A-->B") }} />);
    await waitFor(() => expect(container.querySelector(".chat-mermaid-svg svg")).not.toBeNull());
    const host = container.querySelector(".chat-mermaid-svg")!;
    expect(host.querySelector("image")).toBeNull();
    expect(host.querySelector("g[data-testid='kept'] rect")).not.toBeNull();
  });

  it("removes <image> when the svg is not well-formed XML (HTML labels)", async () => {
    mermaid.render.mockResolvedValue({
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/>' +
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" data-testid="label">a<br>b</div></foreignObject></svg>',
    });
    const { container } = render(<ChatItemView item={{ kind: "assistant_text", markdown: md("graph TD; A-->B") }} />);
    await waitFor(() => expect(container.querySelector(".chat-mermaid-svg svg")).not.toBeNull());
    const host = container.querySelector(".chat-mermaid-svg")!;
    expect(host.querySelector("image")).toBeNull();
    const label = host.querySelector("[data-testid='label']")!;
    expect(label.querySelector("br")).not.toBeNull();
    expect(label.textContent).toBe("ab");
  });
});
