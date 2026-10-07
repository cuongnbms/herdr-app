import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { FileView } from "./FileView";

const base = { machineId: "local", root: "/r", onMode: () => {}, onOpen: () => {}, find: null, initialScroll: 0, onScroll: () => {} };

describe("FileView", () => {
  it("shows the binary notice", () => {
    render(<FileView {...base} rel="a.bin" mode="render" content={{ kind: "binary", text: null, truncated: false, size: 2048, mtime: 1 }} />);
    expect(screen.getByText("Binary file, not shown")).toBeTruthy();
  });
  it("shows the truncated banner", () => {
    render(<FileView {...base} rel="a.log" mode="render" content={{ kind: "text", text: "x", truncated: true, size: 3e6, mtime: 1 }} />);
    expect(screen.getByText("Showing the first 2 MB")).toBeTruthy();
  });
  it("renders markdown in render mode and source in source mode", () => {
    const content = { kind: "text" as const, text: "# Title", truncated: false, size: 7, mtime: 1 };
    const { rerender } = render(<FileView {...base} rel="a.md" mode="render" content={content} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    rerender(<FileView {...base} rel="a.md" mode="source" content={content} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("FileView markdown anchors", () => {
  it("gives headings slug ids that #links target, under StrictMode", () => {
    const text = "[x](#my-title)\n\n# My Title\n\n# My Title";
    const { container } = render(
      <StrictMode>
        <FileView {...base} rel="a.md" mode="render" content={{ kind: "text", text, truncated: false, size: 9, mtime: 1 }} />
      </StrictMode>,
    );
    expect(container.querySelector("h1#my-title")).toBeTruthy();
    expect(container.querySelector("h1#my-title-1")).toBeTruthy();
    expect(container.querySelector('a[href="#my-title"]')).toBeTruthy();
  });
  it("does not nest links for a linked http image", () => {
    const text = "[![ci](https://img.shields.io/x.svg)](https://github.com/o/r)";
    const { container } = render(<FileView {...base} rel="a.md" mode="render" content={{ kind: "text", text, truncated: false, size: 9, mtime: 1 }} />);
    expect(container.querySelectorAll("a").length).toBe(1);
    expect(container.querySelector("a a")).toBeNull();
  });
});
