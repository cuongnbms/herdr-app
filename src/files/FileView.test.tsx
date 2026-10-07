import { StrictMode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { FileView } from "./FileView";

const base = { machineId: "local", root: "/r", onMode: () => {}, onOpen: () => {}, find: null, initialScroll: 0, saveScroll: () => {} };

describe("FileView", () => {
  it("shows the binary notice", () => {
    render(<FileView {...base} rel="a.bin" mode="render" content={{ kind: "binary", text: null, truncated: false, size: 2048, mtime: 1 }} />);
    expect(screen.getByText("Binary file, not shown")).toBeTruthy();
  });
  it("shows a notice, not the binary one, for text without content", () => {
    render(<FileView {...base} rel="a.ts" mode="render" content={{ kind: "text", text: null, truncated: false, size: 2, mtime: 1 }} />);
    expect(screen.queryByText("Binary file, not shown")).toBeNull();
    expect(screen.getByText("No content was returned for this file")).toBeTruthy();
  });
  it("rendered markdown saves its scroll position for its file when left", () => {
    const save = vi.fn();
    const content = { kind: "text" as const, text: "# Title\n\nbody", truncated: false, size: 9, mtime: 1 };
    const { container, unmount } = render(<FileView {...base} rel="a.md" mode="render" content={content} initialScroll={30} saveScroll={save} />);
    const el = container.querySelector(".files-markdown") as HTMLElement;
    expect(el.scrollTop).toBe(30);
    el.scrollTop = 75;
    fireEvent.scroll(el);
    expect(save).not.toHaveBeenCalled();
    unmount();
    expect(save).toHaveBeenCalledWith("a.md", 75);
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
  it("opens a linked file with its decoded fragment", () => {
    const onOpen = vi.fn();
    const text = "[x](../src/x.ts#L3) [y](b.md#caf%C3%A9)";
    render(<FileView {...base} onOpen={onOpen} rel="docs/a.md" mode="render" content={{ kind: "text", text, truncated: false, size: 9, mtime: 1 }} />);
    fireEvent.click(screen.getByText("x"));
    expect(onOpen).toHaveBeenLastCalledWith("src/x.ts", "L3");
    fireEvent.click(screen.getByText("y"));
    expect(onOpen).toHaveBeenLastCalledWith("docs/b.md", "café");
  });
});
