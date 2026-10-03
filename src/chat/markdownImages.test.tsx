import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("../lib/ipc", () => ({ chatImage: vi.fn() }));
import { ChatItemView } from "./ChatItemView";

const view = (markdown: string) => render(<ChatItemView item={{ kind: "assistant_text", markdown }} />);

describe("markdown images", () => {
  it("renders a remote image as a link and never creates an <img>", () => {
    const { container } = view("See ![the chart](https://evil.example/leak.png?token=abc)");
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "the chart" });
    expect(link.getAttribute("href")).toBe("https://evil.example/leak.png?token=abc");
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledWith("https://evil.example/leak.png?token=abc");
  });

  it("uses the URL as the link text when there is no alt text", () => {
    view("![](https://example.com/a.png)");
    expect(screen.getByRole("link", { name: "https://example.com/a.png" })).toBeTruthy();
  });

  it("renders a relative image as its alt text only", () => {
    const { container } = view("![diagram](./out/diagram.png)");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("diagram")).toBeTruthy();
  });

  it("renders an image inside a link as text so there is a single link", () => {
    const { container } = view("[![build](https://shields.io/b.svg)](https://ci.example)");
    expect(container.querySelector("img")).toBeNull();
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://ci.example");
    fireEvent.click(links[0]);
    expect(openUrl).toHaveBeenLastCalledWith("https://ci.example");
  });
});
