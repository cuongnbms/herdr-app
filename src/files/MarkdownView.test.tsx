import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), parse: vi.fn(async () => ({})), render: vi.fn(async () => ({ svg: "<svg></svg>" })) },
}));
import { MarkdownView } from "./MarkdownView";

/** jsdom has no CSS Custom Highlight API; this stands in for it. */
class FakeHighlight extends Set<Range> {}
const highlights = new Map<string, FakeHighlight>();
const texts = (name: string) => [...(highlights.get(name) ?? [])].map((r) => r.toString());

beforeEach(() => {
  highlights.clear();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { escape: (s: string) => s, highlights });
});
afterEach(() => vi.unstubAllGlobals());

const base = { machineId: "local", root: "/r", rel: "a.md", onOpen: () => {}, initialScroll: 0, saveScroll: () => {} };

describe("MarkdownView find", () => {
  it("highlights matches in the rendered text and steps through them", () => {
    const status = vi.fn();
    const text = "# Foo title\n\nsome foo here\n\n`foo()`";
    const { rerender } = render(<MarkdownView {...base} text={text} find={{ query: "foo", index: 0, matchCase: false }} onFindStatus={status} />);
    expect(texts("files-find")).toEqual(["Foo", "foo", "foo"]);
    expect(texts("files-find-current")).toEqual(["Foo"]);
    expect(status).toHaveBeenLastCalledWith({ count: 3, index: 0 });
    rerender(<MarkdownView {...base} text={text} find={{ query: "foo", index: 4, matchCase: false }} onFindStatus={status} />);
    expect(status).toHaveBeenLastCalledWith({ count: 3, index: 1 });
    expect(texts("files-find-current")).toEqual(["foo"]);
    rerender(<MarkdownView {...base} text={text} find={{ query: "foo", index: 0, matchCase: true }} onFindStatus={status} />);
    expect(status).toHaveBeenLastCalledWith({ count: 2, index: 0 });
  });

  it("clears the highlights when find closes", () => {
    const { rerender } = render(<MarkdownView {...base} text="foo" find={{ query: "foo", index: 0, matchCase: false }} />);
    expect(texts("files-find")).toEqual(["foo"]);
    rerender(<MarkdownView {...base} text="foo" find={null} />);
    expect(highlights.size).toBe(0);
  });

  it("searches again when the rendered content changes", async () => {
    const status = vi.fn();
    const find = { query: "foo", index: 0, matchCase: false };
    const { rerender } = render(<MarkdownView {...base} text="foo" find={find} onFindStatus={status} />);
    expect(status).toHaveBeenLastCalledWith({ count: 1, index: 0 });
    rerender(<MarkdownView {...base} text={"foo\n\nfoo foo"} find={find} onFindStatus={status} />);
    await waitFor(() => expect(status).toHaveBeenLastCalledWith({ count: 3, index: 0 }));
    expect(texts("files-find")).toHaveLength(3);
  });
});
